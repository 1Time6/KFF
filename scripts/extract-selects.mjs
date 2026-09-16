// Extract the option-source expression of every <select> in the web components,
// so each one can be compared against its server-side validation.
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';

const dir = path.join('apps', 'web', 'components');
const targets = [
  ['acquisition-candidates.tsx', 40], ['acquisition-workbench.tsx', 49],
  ['acquisition-workbench.tsx', 53], ['acquisition-workbench.tsx', 55],
  ['acquisition-workbench.tsx', 77], ['browser-inbox-setup.tsx', 49],
  ['collection-workbench.tsx', 54], ['contact-permissions.tsx', 42],
  ['contact-permissions.tsx', 59], ['cost-ledger.tsx', 64],
  ['import-workbench.tsx', 45], ['order-workbench.tsx', 56],
  ['reception-controls.tsx', 39], ['schedule-workbench.tsx', 36],
  ['template-workbench.tsx', 51], ['workbench.tsx', 150],
  ['workbench.tsx', 158], ['workbench.tsx', 160],
];

const cache = new Map();
const linesOf = file => {
  if (!cache.has(file)) cache.set(file, readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/));
  return cache.get(file);
};

for (const [file, lineNo] of targets) {
  const line = linesOf(file)[lineNo - 1] ?? '';
  const matches = [...line.matchAll(/<select[^>]*>([\s\S]{0,260})/g)];
  console.log('--- ' + file + ' L' + lineNo);
  if (!matches.length) { console.log('    (no <select on this line)'); continue; }
  for (const m of matches) console.log('    ' + m[0].replace(/\s+/g, ' ').slice(0, 250));
}

// Also list every <select that carries no filter at all (bare .map over a full list).
console.log('\n=== selects whose option source has NO filter call ===');
for (const file of readdirSync(dir).filter(f => f.endsWith('.tsx'))) {
  const text = readFileSync(path.join(dir, file), 'utf8');
  for (const m of text.matchAll(/<select[^>]*>([\s\S]{0,300}?)<\/select>/g)) {
    const body = m[1];
    const src = body.match(/([A-Za-z_$][\w.$?[\]]*)\.map\(/);
    if (!src) continue;
    const expr = src[1];
    if (/\.filter\(/.test(expr)) continue;
    const lineNo = text.slice(0, m.index).split(/\r?\n/).length;
    console.log('   ' + file + ' L' + lineNo + '  source=' + expr);
  }
}
