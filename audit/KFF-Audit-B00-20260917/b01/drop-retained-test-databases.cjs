/**
 * Drops the isolated test databases that a failed run retained, and lists what it dropped.
 * It only ever touches databases matching `kff_test_<20 hex>`, which is the name
 * `scripts/integration.ts` generates for a throwaway run. The user's own `kff` database is
 * never a candidate, and this script does not read or write any table.
 */
const fs = require('node:fs');
const path = require('node:path');
const REPO = 'C:/Users/17731/Desktop/KFF';
const config = JSON.parse(fs.readFileSync(path.join(REPO, '.kff/local-config.json'), 'utf8'));
const pg = require(path.join(REPO, 'node_modules/pg'));

(async () => {
  const admin = new pg.Client({ connectionString: config.database_url });
  await admin.connect();
  const { rows } = await admin.query("SELECT datname FROM pg_database WHERE datname LIKE 'kff\\_test\\_%' ORDER BY datname");
  const dropped = [];
  for (const row of rows) {
    if (!/^kff_test_[a-f0-9]{20}$/.test(row.datname)) throw new Error('Refusing unexpected database name: ' + row.datname);
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [row.datname]);
    await admin.query('DROP DATABASE "' + row.datname + '"');
    dropped.push(row.datname);
  }
  console.log(JSON.stringify({ retained_found: rows.length, dropped }, null, 2));
  await admin.end();
})();
