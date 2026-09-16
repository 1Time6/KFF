// Which capabilities/templates actually exist, to see whether the "创建任务" modal
// (which only offers *.publish.* capabilities) can be satisfied for real accounts.
import {readFileSync} from 'node:fs';
import pg from 'pg';

const config = JSON.parse(readFileSync('.kff/local-config.json', 'utf8'));
const client = new pg.Client({connectionString: config.database_url});
await client.connect();

const show = async (title, sql) => {
  const {rows} = await client.query(sql);
  console.log('\n=== ' + title + ' ===');
  if (!rows.length) { console.log('(none)'); return; }
  for (const row of rows) console.log(JSON.stringify(row));
};

await show('capabilities on REAL accounts', `
  SELECT a.display_name AS account, c.capability_key, c.evidence_state, c.mode
  FROM kff.capabilities c JOIN kff.accounts a ON a.id = c.account_id
  WHERE a.is_synthetic = false ORDER BY a.display_name, c.capability_key`);

await show('publish capabilities anywhere (.publish.)', `
  SELECT c.capability_key, count(*) AS n,
         count(*) FILTER (WHERE a.is_synthetic = false) AS real_accounts
  FROM kff.capabilities c JOIN kff.accounts a ON a.id = c.account_id
  WHERE c.capability_key LIKE '%.publish.%'
  GROUP BY c.capability_key ORDER BY c.capability_key`);

await show('bundled templates by capability_key', `
  SELECT capability_key, state, count(*) AS n
  FROM kff.template_versions GROUP BY capability_key, state ORDER BY capability_key, state`);

await client.end();
