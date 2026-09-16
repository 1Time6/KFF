// Why can't things be used: runtime switches, permits and monitor states.
import {readFileSync} from 'node:fs';
import pg from 'pg';

const config = JSON.parse(readFileSync('.kff/local-config.json', 'utf8'));
const client = new pg.Client({connectionString: config.database_url});
await client.connect();

const show = async (title, sql) => {
  const {rows} = await client.query(sql);
  console.log('\n=== ' + title + ' ===');
  if (!rows.length) { console.log('(no rows)'); return; }
  for (const row of rows) console.log(JSON.stringify(row));
};

await show('acquisition monitors by state', `
  SELECT m.state, count(*) AS n FROM kff.acquisition_monitors m GROUP BY m.state ORDER BY m.state`);

await show('real-account monitors', `
  SELECT m.title, m.state, a.display_name AS account
  FROM kff.acquisition_monitors m
  JOIN kff.accounts a ON a.id = m.account_id
  WHERE a.is_synthetic = false ORDER BY m.state, m.title`);

await show('tables that look like switches', `
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'kff' AND (table_name LIKE '%switch%' OR table_name LIKE '%setting%' OR table_name LIKE '%runtime%')
  ORDER BY table_name`);

await show('capability rows for real accounts', `
  SELECT a.display_name AS account, c.capability_key, c.state
  FROM kff.account_capabilities c
  JOIN kff.accounts a ON a.id = c.account_id
  WHERE a.is_synthetic = false
  ORDER BY a.display_name, c.capability_key`).catch(async e => {
  console.log('\n=== capability query failed: ' + e.message + ' ===');
  const {rows} = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='kff' AND table_name LIKE '%capab%' ORDER BY table_name`);
  console.log(JSON.stringify(rows));
});

await client.end();
