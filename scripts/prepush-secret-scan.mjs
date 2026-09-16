// Pre-push safety scan: look for credentials and live platform data inside every file
// git would actually upload, so nothing sensitive reaches a remote.
import {execFileSync} from 'node:child_process';
import {readFileSync, statSync} from 'node:fs';

const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {maxBuffer: 1 << 28})
  .toString('utf8').split('\0').filter(Boolean);
console.log('files git would upload:', listed.length);

const SECRET_PATTERNS = [
  ['local DB password', /kff_local:[A-Za-z0-9]{20,}/],
  ['postgres URI with creds', /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/],
  ['session/agent secret hex', /\b[a-f0-9]{64}\b/],
  ['Supabase key', /eyJhbGciOi[A-Za-z0-9_-]{20,}/],
  ['Apify token', /apify_api_[A-Za-z0-9]{10,}/],
  ['Facebook/EAA token', /EAA[A-Za-z0-9]{40,}/],
  ['Stripe secret', /sk_(?:live|test)_[A-Za-z0-9]{20,}/],
  ['Stripe webhook secret', /whsec_[A-Za-z0-9]{20,}/],
  ['OpenAI-style key', /sk-[A-Za-z0-9]{32,}/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AdsPower key assignment', /KFF_ADSPOWER_API_KEY\s*[:=]\s*["']?[A-Za-z0-9]{8,}/],
  ['reception AI key', /KFF_RECEPTION_AI_KEY\s*[:=]\s*["']?[A-Za-z0-9\-_]{8,}/],
];

const TEXT_EXT = /\.(?:json|ts|tsx|mjs|cjs|js|md|txt|css|sql|py|ps1|cmd|yml|yaml|env|example|sha256|log|ndjson)$/i;

const hits = [];
const bigNonText = [];
let scanned = 0;
for (const file of listed) {
  let size = 0;
  try { size = statSync(file).size; } catch { continue; }
  if (!TEXT_EXT.test(file)) { if (size > 2 * 1024 * 1024) bigNonText.push([file, size]); continue; }
  if (size > 8 * 1024 * 1024) { bigNonText.push([file, size]); continue; }
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  scanned++;
  for (const [label, re] of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push({file, label, sample: m[0].slice(0, 12) + '…'});
  }
}

console.log('text files scanned:', scanned);
console.log('\n=== SECRET HITS ===');
if (!hits.length) console.log('(none)');
else {
  const byFile = new Map();
  for (const h of hits) {
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    byFile.get(h.file).push(h.label);
  }
  for (const [file, labels] of [...byFile].slice(0, 60)) console.log('  ' + file + '  <- ' + [...new Set(labels)].join(', '));
  console.log('  total flagged files:', byFile.size);
}

console.log('\n=== large / non-text files (not content-scanned) ===');
for (const [f, s] of bigNonText.slice(0, 15)) console.log('  ' + (s / 1024 / 1024).toFixed(1) + ' MB  ' + f);
if (bigNonText.length > 15) console.log('  ... and ' + (bigNonText.length - 15) + ' more');
