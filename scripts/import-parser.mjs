// Isolated, bounded file parser. It receives bytes on stdin and never evaluates cells.
import { parse } from 'csv-parse/sync';
import yauzl from 'yauzl';
import { SaxesParser } from 'saxes';
import path from 'node:path';

const fail = code => { throw new Error(code); };
const limit = (ok, code = 'FILE_LIMIT_EXCEEDED') => { if (!ok) fail(code); };
const textCell = value => { limit(value.length <= 5000); return { type: 'text', value }; };
const blank = () => ({ type: 'blank' });
const mainNS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const pkgNS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
function xml(bytes) {
  const parser = new SaxesParser({ xmlns: true }); const stack = []; let root; let count = 0;
  parser.on('doctype', () => fail('UNSUPPORTED_XML_DOCTYPE'));
  parser.on('opentag', tag => {
    limit(++count <= 250000 && stack.length < 64);
    const node = { name: tag.local, uri: tag.uri, attrs: Object.values(tag.attributes), text: '', children: [] };
    if (stack.length) stack.at(-1).children.push(node); else root = node;
    stack.push(node);
  });
  const addText = text => { if (stack.length) { const node = stack.at(-1); node.text += text; limit(node.text.length <= 200000); } };
  parser.on('text', addText); parser.on('cdata', addText); parser.on('closetag', () => stack.pop());
  parser.write(decode(bytes)).close(); limit(root, 'INVALID_XLSX'); return root;
}
const attr = (node, name, uri = '') => node.attrs.find(a => a.local === name && a.uri === uri)?.value;
const child = (node, name) => node?.children.find(n => n.name === name && n.uri === node.uri);
const children = (node, name) => node?.children.filter(n => n.name === name && n.uri === node.uri) ?? [];
const unescape = text => text.replace(/_x([a-f0-9]{4})_/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
function richText(node) { return unescape((child(node, 't')?.text ?? '') + children(node, 'r').map(run => child(run, 't')?.text ?? '').join('')); }
async function unzip(bytes) {
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, value) => error ? reject(error) : resolve(value)));
  const files = new Map(); let total = 0; let count = 0;
  await new Promise((resolve, reject) => {
    const error = value => { zip.close(); reject(value); }; zip.on('error', error); zip.on('end', resolve);
    zip.on('entry', entry => {
      try {
        limit(++count <= 2000 && entry.uncompressedSize <= 8 * 1024 * 1024 && (total += entry.uncompressedSize) <= 32 * 1024 * 1024);
        limit(!entry.isEncrypted() && !files.has(entry.fileName), 'INVALID_XLSX');
        limit(!/(vbaProject|externalLinks|embeddings|activeX)/i.test(entry.fileName), 'UNSUPPORTED_XLSX_CONTENT');
        const chunks = []; let size = 0;
        zip.openReadStream(entry, (openError, stream) => {
          if (openError) { error(openError); return; }
          stream.on('error', error);
          stream.on('data', chunk => { size += chunk.length; if (size > entry.uncompressedSize || size > 8 * 1024 * 1024) { stream.destroy(new Error('FILE_LIMIT_EXCEEDED')); return; } chunks.push(chunk); });
          stream.on('end', () => { files.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
        });
      } catch (value) { error(value); }
    }); zip.readEntry();
  });
  return files;
}
async function xlsx(bytes) {
  limit(bytes.subarray(0,4).equals(Buffer.from([80,75,3,4])), 'INVALID_XLSX'); const files = await unzip(bytes);
  const getXML = name => { const data = files.get(name); limit(data, 'INVALID_XLSX'); return xml(data); };
  for (const [name, data] of files) if (name.endsWith('.rels')) {
    const rels = xml(data); limit(rels.uri === pkgNS && rels.name === 'Relationships', 'INVALID_XLSX');
    for (const rel of rels.children) limit(attr(rel,'TargetMode') !== 'External' && !/^[a-z]+:/i.test(attr(rel,'Target') ?? ''), 'UNSUPPORTED_EXTERNAL_LINK');
  }
  const types = getXML('[Content_Types].xml');
  const bookType = types.children.find(node => node.name === 'Override' && attr(node,'PartName') === '/xl/workbook.xml') ?? types.children.find(node => node.name === 'Default' && attr(node,'Extension') === 'xml');
  limit(types.uri === 'http://schemas.openxmlformats.org/package/2006/content-types' && bookType && attr(bookType,'ContentType') === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', 'UNSUPPORTED_XLSX_CONTENT');
  const book = getXML('xl/workbook.xml'); limit(book.name === 'workbook' && book.uri === mainNS, 'INVALID_XLSX');
  const rels = getXML('xl/_rels/workbook.xml.rels'); const sheets = children(child(book,'sheets'),'sheet'); limit(sheets.length >= 1 && sheets.length <= 5);
  let shared = [];
  if (files.has('xl/sharedStrings.xml')) { const strings = getXML('xl/sharedStrings.xml'); limit(strings.name === 'sst' && strings.uri === mainNS,'INVALID_XLSX'); shared = children(strings,'si').map(richText); }
  return { sheets: sheets.map(sheet => {
    const rel = rels.children.find(value => attr(value,'Id') === attr(sheet,'id',relNS)); limit(rel && attr(rel,'Type') === relNS + '/worksheet', 'INVALID_XLSX');
    const target = attr(rel,'Target') ?? ''; const filename = path.posix.normalize(target.startsWith('/') ? target.slice(1) : 'xl/' + target);
    limit(/^xl\/worksheets\/[A-Za-z0-9_.-]+\.xml$/.test(filename), 'INVALID_XLSX');
    const data = getXML(filename); limit(data.name === 'worksheet' && data.uri === mainNS, 'INVALID_XLSX');
    const rows = []; const seen = new Set();
    for (const row of children(child(data,'sheetData'),'row')) {
      const rowIndex = Number(attr(row,'r')); limit(Number.isInteger(rowIndex) && rowIndex >= 1 && rowIndex <= 1021);
      while (rows.length < rowIndex) rows.push([]);
      for (const cell of children(row,'c')) {
        const address = attr(cell,'r') ?? ''; const match = /^([A-Z]{1,2})([1-9][0-9]*)$/.exec(address); limit(match && Number(match[2]) === rowIndex && !seen.has(address), 'INVALID_XLSX'); seen.add(address);
        const column = [...match[1]].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0); limit(column <= 32);
        const values = rows[rowIndex-1]; while (values.length < column) values.push(blank());
        const type = attr(cell,'t'); const value = child(cell,'v')?.text; let result;
        if (child(cell,'f')) result = {type:'invalid',reason:'FORMULA_CELL'};
        else if (type === 's') { limit(value !== undefined && /^[0-9]+$/.test(value) && Number(value) < shared.length,'INVALID_XLSX'); result = textCell(shared[Number(value)]); }
        else if (type === 'inlineStr') result = textCell(richText(child(cell,'is')));
        else if (type === 'str') result = textCell(unescape(value ?? ''));
        else if (value === undefined || value === '') result = blank();
        else if ((type === undefined || type === 'n') && Number.isFinite(Number(value))) result = {type:'number',value:Number(value)};
        else result = {type:'invalid',reason:'UNSUPPORTED_CELL'};
        values[column-1] = result;
      }
    }
    limit(rows.length > 0, 'EMPTY_FILE'); return { name: attr(sheet,'name') ?? 'Sheet', rows };
  }) };
}
try {
  const [format, encoding] = process.argv.slice(2); limit(['csv','xlsx'].includes(format) && ['utf-8','utf-16le','gb18030'].includes(encoding),'INVALID_INPUT');
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; limit(size <= 8 * 1024 * 1024); chunks.push(chunk); }
  limit(size > 0, 'EMPTY_FILE'); const bytes = Buffer.concat(chunks); let parsed;
  if (format === 'xlsx') parsed = await xlsx(bytes);
  else {
    let text; try { text = new TextDecoder(encoding,{fatal:true}).decode(bytes); } catch { fail('INVALID_ENCODING'); }
    limit(!text.includes('\0'), 'INVALID_ENCODING'); let count = 0;
    const rows = parse(text, { bom:true, cast:false, relax_column_count:true, skip_empty_lines:false, max_record_size:160032, on_record: record => { limit(++count <= 1021 && record.length <= 32); return record.map(textCell); } });
    limit(rows.length > 0,'EMPTY_FILE'); parsed = {sheets:[{name:'CSV',rows}]};
  }
  const result = JSON.stringify({ok:true,parsed}); limit(Buffer.byteLength(result) <= 16 * 1024 * 1024); process.stdout.write(result);
} catch (error) {
  const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'INVALID_FILE';
  process.stdout.write(JSON.stringify({ok:false,code})); process.exitCode = 1;
}
