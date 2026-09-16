// Inspect RLS policies on accounts/agents, then replay the environment-create
// validation exactly as the API does it (inside the kff_app role + brand config).
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

await show('RLS enabled?', `
  SELECT relname, relrowsecurity, relforcerowsecurity
  FROM pg_class WHERE relnamespace='kff'::regnamespace
    AND relname IN ('accounts','agents','environments','brands','memberships')
  ORDER BY relname`);

await show('policies on accounts / agents / environments', `
  SELECT tablename, policyname, cmd, qual, with_check
  FROM pg_policies WHERE schemaname='kff'
    AND tablename IN ('accounts','agents','environments')
  ORDER BY tablename, policyname`);

await show('roles and grants', `
  SELECT grantee, table_name, privilege_type
  FROM information_schema.role_table_grants
  WHERE table_schema='kff' AND table_name IN ('accounts','agents')
  ORDER BY table_name, grantee`);

// Replay createEnvironment's two validation queries as the scoped app role.
const brand = '22222222-2222-4222-8222-222222222222';
const org = '11111111-1111-4111-8111-111111111111';
const user = '33333333-3333-4333-8333-333333333333';
const {rows: acct} = await client.query(`SELECT id, display_name FROM kff.accounts WHERE is_synthetic=false ORDER BY display_name LIMIT 1`);
const {rows: agent} = await client.query(`SELECT id, name FROM kff.agents WHERE status<>'REVOKED' ORDER BY name LIMIT 1`);
console.log('\nprobe account =', JSON.stringify(acct[0]), '\nprobe agent   =', JSON.stringify(agent[0]));

await client.query('BEGIN');
try {
  await client.query("SELECT set_config('kff.organization_id',$1,true), set_config('kff.brand_id',$2,true), set_config('kff.user_id',$3,true)", [org, brand, user]);
  await client.query('SET LOCAL ROLE kff_app');
  const a = await client.query('SELECT id FROM kff.accounts WHERE id=$1', [acct[0].id]);
  const g = await client.query("SELECT id FROM kff.agents WHERE id=$1 AND status<>'REVOKED'", [agent[0].id]);
  console.log('\n=== replay as kff_app + brand scope ===');
  console.log('account query rowCount =', a.rowCount, '(needs >= 1)');
  console.log('agent   query rowCount =', g.rowCount, '(needs >= 1)');
  console.log('createEnvironment would', (a.rowCount && g.rowCount) ? 'PASS' : 'FAIL with 账号或 Agent 不在当前品牌内');
} finally {
  await client.query('ROLLBACK');
}

await client.end();
