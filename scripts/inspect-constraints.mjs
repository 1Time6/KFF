// Database constraints and zod bounds that the UI does not surface, so a user can
// fill a form with values that hit a raw constraint error instead of a clear message.
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

await show('unique constraints on user-facing tables', `
  SELECT c.conrelid::regclass::text AS table_name,
         c.conname,
         pg_get_constraintdef(c.oid) AS definition
  FROM pg_constraint c
  JOIN pg_namespace n ON n.oid = c.connamespace
  WHERE n.nspname = 'kff' AND c.contype = 'u'
    AND c.conrelid::regclass::text IN
      ('kff.accounts','kff.environments','kff.acquisition_monitors','kff.orders','kff.products')
  ORDER BY 1, 2`);

await show('non-null / check constraints on accounts', `
  SELECT conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
  WHERE conrelid = 'kff.accounts'::regclass AND contype IN ('c','u','f')
  ORDER BY conname`);

await show('non-null / check constraints on environments', `
  SELECT conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
  WHERE conrelid = 'kff.environments'::regclass AND contype IN ('c','u','f')
  ORDER BY conname`);

await show('duplicate account names already present', `
  SELECT display_name, count(*) AS n FROM kff.accounts GROUP BY display_name HAVING count(*) > 1 ORDER BY n DESC LIMIT 10`);

await client.end();
