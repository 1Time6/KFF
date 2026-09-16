import EmbeddedPostgres from 'embedded-postgres';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeLocalConfig, runtimeDir } from '../packages/database/src/runtime';
import { startExistingDatabase } from './existing-database';

export async function startDatabase(databaseDir = path.join(runtimeDir, 'postgres'), port = 55432) {
  const config = initializeLocalConfig();
  mkdirSync(databaseDir, { recursive: true });
  const server = new EmbeddedPostgres({ databaseDir, user: 'kff_local', password: config.database_password, port, persistent: true, authMethod: 'scram-sha-256', postgresFlags: ['-h', '127.0.0.1'], initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: (message: unknown) => { if (String(message).includes('FATAL')) process.stderr.write('Postgres initialization error; see local database state.\n'); } });
  if (!existsSync(path.join(databaseDir, 'PG_VERSION'))) await server.initialise();
  // The dependency force-kills PostgreSQL on Windows. Use pg_ctl for a clean owned shutdown.
  const managed = process.platform === 'win32' ? await startExistingDatabase(databaseDir, port, path.resolve(databaseDir, '..', 'postgres-' + port + '.log')) : server;
  if (process.platform !== 'win32') await server.start();
  const client = server.getPgClient();
  await client.connect();
  const result = await client.query("SELECT 1 FROM pg_database WHERE datname='kff'");
  if (!result.rowCount) await client.query('CREATE DATABASE kff');
  await client.end();
  return managed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const database = await startDatabase();
  console.log('KFF PostgreSQL listening on 127.0.0.1:55432');
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; await database.stop(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
