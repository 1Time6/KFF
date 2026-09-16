// Why does "create environment" reject the account or agent as not in the brand?
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

await show('brands', `SELECT id, organization_id, name FROM kff.brands ORDER BY name`);

await show('real accounts + their brand', `
  SELECT a.display_name, a.brand_id, b.name AS brand_name, a.is_synthetic
  FROM kff.accounts a LEFT JOIN kff.brands b ON b.id = a.brand_id
  WHERE a.is_synthetic = false ORDER BY a.display_name`);

await show('agents grouped by brand', `
  SELECT a.name AS agent, a.brand_id, b.name AS brand_name, a.status
  FROM kff.agents a LEFT JOIN kff.brands b ON b.id = a.brand_id
  WHERE a.status IN ('ONLINE','PAIRED','DRAINING')
  ORDER BY a.status, a.name`);

await show('existing environments + brand', `
  SELECT e.name AS environment, e.brand_id, b.name AS brand_name,
         ac.display_name AS account, ac.brand_id AS account_brand
  FROM kff.environments e
  LEFT JOIN kff.brands b ON b.id = e.brand_id
  LEFT JOIN kff.accounts ac ON ac.id = e.account_id
  WHERE ac.is_synthetic = false ORDER BY e.name`);

await show('accounts vs brand mismatch count', `
  SELECT count(*) AS accounts_total,
         count(*) FILTER (WHERE a.brand_id NOT IN (SELECT id FROM kff.brands)) AS orphan_brand
  FROM kff.accounts a`);

await show('local users and their memberships', `
  SELECT u.email, m.brand_id, b.name AS brand_name, m.role
  FROM kff.local_users u
  LEFT JOIN kff.memberships m ON m.user_id = u.id
  LEFT JOIN kff.brands b ON b.id = m.brand_id`);

await client.end();
