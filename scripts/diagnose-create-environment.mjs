// Replay the create-environment API call with different (account, agent) pairs to
// find which selection produces "账号或 Agent 不在当前品牌内".
// IMPORTANT: this creates real rows while testing, and deletes exactly those rows again.
import {readFileSync} from 'node:fs';
import pg from 'pg';

const base = 'http://127.0.0.1:3000';
const config = JSON.parse(readFileSync('.kff/local-config.json', 'utf8'));

const login = await fetch(base + '/api/auth/login', {
  method: 'POST',
  headers: {'Content-Type': 'application/json', 'Origin': base},
  body: JSON.stringify({email: 'operator@kff.local', password: config.operator_password}),
});
const cookie = (login.headers.getSetCookie?.() ?? []).map(v => v.split(';')[0]).join('; ');
if (!login.ok) { console.log('login failed', login.status); process.exit(1); }

const client = new pg.Client({connectionString: config.database_url});
await client.connect();
const {rows: agents} = await client.query(
  `SELECT id, name, status FROM kff.agents WHERE status IN ('REVOKED','ONLINE') ORDER BY status, name LIMIT 4`);
const {rows: accounts} = await client.query(
  `SELECT id, display_name, is_synthetic FROM kff.accounts WHERE is_synthetic=false ORDER BY display_name LIMIT 1`);
await client.end();

const account = accounts[0];
console.log('using account:', account.display_name, account.id);
console.log('candidates:');
for (const a of agents) console.log('   ', a.status.padEnd(8), a.name);

const attempt = async (label, agentId, agentLabel) => {
  const payload = {name: 'DELETE-ME 诊断 ' + Date.now(), account_id: account.id, agent_id: agentId};
  const res = await fetch(base + '/api/environments', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'Origin': base, Cookie: cookie},
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let created = null;
  try { created = JSON.parse(text).id ?? null; } catch {}
  console.log(`\n[${label}] agent = ${agentLabel}`);
  console.log('   HTTP', res.status, '->', text.slice(0, 160));
  return created;
};

const created = [];
for (const a of agents) {
  const id = await attempt(a.status, a.id, a.name);
  if (id) created.push(id);
}

if (created.length) {
  const cleanup = new pg.Client({connectionString: config.database_url});
  await cleanup.connect();
  const {rowCount} = await cleanup.query('DELETE FROM kff.environments WHERE id = ANY($1::uuid[])', [created]);
  console.log('\ncleaned up', rowCount, 'diagnostic environment row(s)');
  await cleanup.end();
} else {
  console.log('\nno rows created, nothing to clean');
}
