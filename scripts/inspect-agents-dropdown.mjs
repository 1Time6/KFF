// Count agents by status: which entries in the "执行 Agent" dropdown will be rejected.
import {readFileSync} from 'node:fs';
import pg from 'pg';

const config = JSON.parse(readFileSync('.kff/local-config.json', 'utf8'));
const client = new pg.Client({connectionString: config.database_url});
await client.connect();

const {rows} = await client.query(`SELECT status, count(*) AS n FROM kff.agents GROUP BY status ORDER BY n DESC`);
console.log('=== agents by status ===');
for (const r of rows) console.log(String(r.n).padStart(4), r.status);

const {rows: usable} = await client.query(`SELECT name, status FROM kff.agents WHERE status <> 'REVOKED' ORDER BY name`);
console.log('\n=== agents the create-environment form will ACCEPT ===');
for (const r of usable) console.log('   ', r.status, r.name);

const {rows: revoked} = await client.query(`SELECT count(*) AS n FROM kff.agents WHERE status = 'REVOKED'`);
console.log('\nREVOKED entries offered in the dropdown (all rejected):', revoked[0].n);

await client.end();
