// Read-only inventory: why can (or can't) an account be selected in the UI.
import {readFileSync} from 'node:fs';
import pg from 'pg';

const config = JSON.parse(readFileSync('.kff/local-config.json', 'utf8'));
const client = new pg.Client({connectionString: config.database_url});
await client.connect();

const show = async (title, sql, params = []) => {
  const {rows} = await client.query(sql, params);
  console.log('\n=== ' + title + ' ===');
  if (!rows.length) { console.log('(no rows)'); return; }
  for (const row of rows) console.log(JSON.stringify(row));
};

await show('real Facebook accounts', `
  SELECT a.display_name, a.account_type, a.external_id, a.state
  FROM kff.accounts a
  WHERE a.is_synthetic = false
  ORDER BY a.display_name`);

await show('environments of real accounts', `
  SELECT a.display_name AS account, e.name AS environment, e.state, e.browser_status,
         e.browser_configuration->>'driver' AS driver,
         e.browser_configuration->>'provider_profile_id' AS provider_profile_id,
         e.browser_checked_at, e.browser_error_code
  FROM kff.environments e
  JOIN kff.accounts a ON a.id = e.account_id
  WHERE a.is_synthetic = false
  ORDER BY a.display_name`);

await show('agents', `
  SELECT name, status, heartbeat_at FROM kff.agents ORDER BY name`);

await show('acquisition monitors', `
  SELECT m.title, m.state, a.display_name AS account, a.is_synthetic AS acct_synthetic
  FROM kff.acquisition_monitors m
  LEFT JOIN kff.accounts a ON a.id = m.account_id
  ORDER BY m.title`);

await show('runtime switches', `
  SELECT key, value FROM kff.runtime_switches ORDER BY key`).catch(async () => {
  await show('runtime switches (fallback)', `
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='kff' AND table_name LIKE '%runtime%'
    ORDER BY column_name`);
});

await client.end();
