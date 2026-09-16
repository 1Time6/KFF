// Definitive pre-push check: does any uploadable byte sequence contain one of THIS
// machine's real secret values? Pattern matching produced false positives (SHA-256
// digests look like secrets), so compare against the actual values instead.
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';

const secrets = [];
const collect = (label, value) => {
  if (typeof value === 'string' && value.length >= 12) secrets.push([label, value]);
};
if (existsSync('.kff/local-config.json')) {
  const c = JSON.parse(readFileSync('.kff/local-config.json', 'utf8'));
  collect('local-config.database_password', c.database_password);
  collect('local-config.session_secret', c.session_secret);
  collect('local-config.operator_password', c.operator_password);
  collect('local-config.agent_token', c.agent_token);
  collect('local-config.database_url', c.database_url);
}
if (existsSync('.kff/agent-config.json')) {
  const a = JSON.parse(readFileSync('.kff/agent-config.json', 'utf8'));
  // Only genuine credentials. organization_id / brand_id / agent_id are identifiers and
  // controller_origin is the fixed local URL http://127.0.0.1:3000 — none of them is a
  // secret, and flagging them produced false alarms.
  collect('agent-config.token', a.token);
}
if (existsSync('.kff/reception-ai.env')) {
  collect('reception-ai.env', readFileSync('.kff/reception-ai.env', 'utf8').trim());
}
if (existsSync('.kff/adspower-api-key.txt')) collect('adspower-api-key', readFileSync('.kff/adspower-api-key.txt', 'utf8').trim());

console.log('real secret values loaded:', secrets.length);
for (const [label, v] of secrets) console.log('   ' + label + '  (len ' + v.length + ')');

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {maxBuffer: 1 << 28})
  .toString('utf8').split('\0').filter(Boolean);

const offenders = [];
for (const file of files) {
  let buf;
  try { buf = readFileSync(file); } catch { continue; }
  if (buf.length > 16 * 1024 * 1024) continue;
  const text = buf.toString('utf8');
  for (const [label, value] of secrets) {
    if (text.includes(value)) offenders.push({file, label});
  }
  // also flag the local DB user/password pair in any form
  if (/kff_local:[^@\s"']{16,}/.test(text)) offenders.push({file, label: 'kff_local: password form'});
}

console.log('\n=== files containing a REAL secret value ===');
if (!offenders.length) console.log('(none — nothing uploadable contains a live credential)');
else for (const o of offenders) console.log('  ' + o.file + '  <- ' + o.label);
console.log('\nfiles checked:', files.length);
