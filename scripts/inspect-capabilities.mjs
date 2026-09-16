// Capability rows for the real accounts (what each action is currently allowed to do).
import {readFileSync} from 'node:fs';
import pg from 'pg';

const config = JSON.parse(readFileSync('.kff/local-config.json', 'utf8'));
const client = new pg.Client({connectionString: config.database_url});
await client.connect();

const {rows: cols} = await client.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema='kff' AND table_name='capabilities' ORDER BY ordinal_position`);
console.log('capabilities columns:', cols.map(r => r.column_name).join(', '));

const {rows} = await client.query(`
  SELECT a.display_name AS account, c.capability_key, c.evidence_state, c.mode, c.is_synthetic, c.last_verified_at
  FROM kff.capabilities c
  JOIN kff.accounts a ON a.id = c.account_id
  WHERE a.is_synthetic = false
  ORDER BY a.display_name, c.capability_key`);
console.log('\n=== capabilities of real accounts ===');
if (!rows.length) console.log('(no rows)');
for (const r of rows) console.log(JSON.stringify(r));

const {rows: agg} = await client.query(`
  SELECT c.capability_key, c.evidence_state, c.mode, count(*) AS n
  FROM kff.capabilities c
  WHERE c.is_synthetic = false
  GROUP BY c.capability_key, c.evidence_state, c.mode ORDER BY c.capability_key, c.mode`);
console.log('\n=== all capability states (aggregated) ===');
for (const r of agg) console.log(JSON.stringify(r));

await client.end();
