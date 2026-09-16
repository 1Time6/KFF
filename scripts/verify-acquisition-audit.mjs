// Verify acquisition audit F1/F3/F6 premises against the live database.
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

await show('F1: real accounts and their credential_ref', `
  SELECT display_name, platform, account_type, credential_ref,
         (credential_ref IS NULL) AS credential_is_null
  FROM kff.accounts WHERE is_synthetic = false ORDER BY display_name`);

await show('F3: environments with their driver (can the client see it?)', `
  SELECT a.display_name AS account, e.name AS environment,
         e.browser_configuration IS NOT NULL AS browser_configured,
         e.browser_configuration->>'driver' AS driver
  FROM kff.environments e JOIN kff.accounts a ON a.id = e.account_id
  WHERE a.is_synthetic = false ORDER BY a.display_name`);

await show('F3/F4: any real environment using the native driver?', `
  SELECT e.name, e.browser_configuration->>'driver' AS driver,
         (e.browser_configuration->>'driver') = 'adspower' AS is_adspower
  FROM kff.environments e JOIN kff.accounts a ON a.id = e.account_id
  WHERE a.is_synthetic = false ORDER BY 1`);

await show('F6/F7: strategy+provider of existing monitors', `
  SELECT m.config->'discovery'->>'provider' AS provider,
         m.config->'discovery'->>'strategy' AS strategy,
         count(*) AS n
  FROM kff.acquisition_monitors m
  GROUP BY 1, 2 ORDER BY 1, 2`);

await client.end();
