// Confirm nothing is in flight before editing code / restarting the runtime.
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

await show('in-flight actions', `
  SELECT a.state, count(*) AS n FROM kff.actions a
  WHERE a.state IN ('QUEUED','PREPARING','SUBMITTING','SUBMITTED','UNKNOWN_OUTCOME','NEEDS_HUMAN')
  GROUP BY a.state ORDER BY a.state`);

await show('in-flight tasks', `
  SELECT t.status, count(*) AS n FROM kff.tasks t
  WHERE t.status NOT IN ('DONE','FAILED','CANCELED','REJECTED','DRAFT')
  GROUP BY t.status ORDER BY t.status`);

await show('active jobs / leases', `
  SELECT count(*) AS active_jobs FROM kff.jobs WHERE state IN ('READY','LEASED','RUNNING')`);

await show('environment occupancy', `
  SELECT e.name, e.state, e.browser_status, c.state AS command_state, c.operation
  FROM kff.environments e
  LEFT JOIN LATERAL (SELECT * FROM kff.environment_commands ec
                     WHERE ec.environment_id = e.id ORDER BY ec.created_at DESC LIMIT 1) c ON true
  WHERE c.state IN ('QUEUED','RUNNING') OR e.state <> 'IDLE'
  ORDER BY e.name`).catch(async e => console.log('(query failed: ' + e.message + ')'));

await client.end();
console.log('\n=== local-runtime state.json ===');
const state = JSON.parse(readFileSync('.kff/local-runtime/state.json', 'utf8'));
console.log(JSON.stringify({state: state.state, phase: state.phase, updated: state.updated_at ?? state.updatedAt, components: state.components}, null, 2));
