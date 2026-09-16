// Verify the audit left no junk rows behind.
import {readFileSync} from 'node:fs';
import pg from 'pg';

const config = JSON.parse(readFileSync('.kff/local-config.json', 'utf8'));
const client = new pg.Client({connectionString: config.database_url});
await client.connect();

const one = async (label, sql) => {
  const {rows} = await client.query(sql);
  console.log(label, '=', rows[0].n);
};

await one('DIAGNOSTIC accounts left behind', "SELECT count(*)::int AS n FROM kff.accounts WHERE display_name LIKE 'DIAGNOSTIC%'");
await one('DELETE-ME environments left behind', "SELECT count(*)::int AS n FROM kff.environments WHERE name LIKE 'DELETE-ME%'");
await one('accounts total (expected 88)', 'SELECT count(*)::int AS n FROM kff.accounts');
await one('environments total (expected 55)', 'SELECT count(*)::int AS n FROM kff.environments');
await one('agents total (expected 100)', 'SELECT count(*)::int AS n FROM kff.agents');

await client.end();
