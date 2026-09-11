import pg, { type PoolClient, type QueryResultRow } from 'pg';
import type { Scope } from '@kff/contracts';
import { localConfig } from './runtime';
export { localConfig, runtimeDir, projectRoot, initializeLocalConfig } from './runtime';

let pool: pg.Pool | undefined;
export function getPool(): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? localConfig().database_url, max: 8, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000, application_name: 'kff', options: '-c timezone=UTC' });
  return pool;
}
export async function query<T extends QueryResultRow = QueryResultRow>(sql: string, args: unknown[] = []): Promise<T[]> { return (await getPool().query<T>(sql, args)).rows; }
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function scoped<T>(scope: Scope, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return transaction(async client => {
    await client.query("SELECT set_config('kff.organization_id',$1,true), set_config('kff.brand_id',$2,true), set_config('kff.user_id',$3,true)", [scope.organization_id, scope.brand_id, scope.user_id]);
    await client.query('SET LOCAL ROLE kff_app');
    return fn(client);
  });
}
export async function closePool() { if (pool) { await pool.end(); pool = undefined; } }
