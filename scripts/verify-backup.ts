import { readFileSync, writeFileSync, mkdirSync, cpSync, lstatSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import pg from 'pg';

// This command only starts a NEW copy below .kff/restore-checks. It never starts or replaces a backup/live directory.
const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const restoreOnly = process.argv[3] === '--restore-only';
if (process.argv.length !== (restoreOnly ? 4 : 3) || process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Usage on Windows x64: pnpm db:verify-backup .kff/backups/<stopped-backup> [--restore-only]');
const inside = (base: string, child: string) => child.toLowerCase().startsWith(base.toLowerCase() + path.sep);
const backup = realpathSync(path.resolve(root, process.argv[2])), source = realpathSync(path.join(backup, 'postgres'));
const runtime = realpathSync(path.join(root, '.kff'));
if (!inside(root, runtime)) throw new Error('UNSAFE_RUNTIME_PATH');
mkdirSync(path.join(runtime, 'restore-checks'), { recursive: true });
const parent = realpathSync(path.join(runtime, 'restore-checks')), id = randomUUID(), target = path.join(parent, id), data = path.join(target, 'postgres');
if (!inside(runtime, parent)) throw new Error('UNSAFE_RESTORE_PARENT');
if (!inside(path.join(root, '.kff/backups'), backup) || !inside(backup, source) || !inside(parent, data) || existsSync(target)) throw new Error('UNSAFE_RESTORE_PATH');
const read = (file: string) => { const bytes = readFileSync(file); return JSON.parse(bytes.toString(bytes[0] === 255 && bytes[1] === 254 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '')); };
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const walk = (directory: string): string[] => readdirSync(directory).flatMap(name => { const file = path.join(directory, name), s = lstatSync(file); if (s.isSymbolicLink()) throw new Error('RESTORE_LINK_NOT_ALLOWED'); if (s.isDirectory()) return walk(file); if (!s.isFile()) throw new Error('RESTORE_FILE_INVALID'); return [file]; });
const manifest = read(path.join(backup, 'manifest.json')) as Array<{ path: string; sha256: string; bytes: number }>;
if (!Array.isArray(manifest) || !manifest.length || new Set(manifest.map(row => row.path.toLowerCase())).size !== manifest.length) throw new Error('BACKUP_MANIFEST_INVALID');
if (['postmaster.pid', 'standby.signal', 'recovery.signal'].some(file => existsSync(path.join(source, file))) || readFileSync(path.join(source, 'PG_VERSION'), 'utf8').trim() !== '17') throw new Error('STOPPED_POSTGRES_17_BACKUP_REQUIRED');
const originalFiles = walk(source), listed = new Set(manifest.map(row => path.resolve(source, row.path).toLowerCase()));
if (originalFiles.length !== manifest.length || listed.size !== manifest.length || originalFiles.some(file => !listed.has(file.toLowerCase()))) throw new Error('BACKUP_FILE_INVENTORY_CHANGED');
for (const row of manifest) {
  const original = path.resolve(source, row.path);
  if (!inside(source, original) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !/^[a-f0-9]{64}$/i.test(row.sha256) || lstatSync(original).size !== row.bytes || sha256(original) !== row.sha256.toLowerCase()) throw new Error('BACKUP_CHECKSUM_MISMATCH');
}
console.log(JSON.stringify({ stage: 'backup_verified', files: manifest.length }));
mkdirSync(target, { recursive: true }); cpSync(source, data, { recursive: true, errorOnExist: true, force: false });
for (const row of manifest) { const copied = path.resolve(data, row.path); if (!inside(data, copied) || lstatSync(copied).size !== row.bytes || sha256(copied) !== row.sha256.toLowerCase()) throw new Error('RESTORE_CHECKSUM_MISMATCH'); }
console.log(JSON.stringify({ stage: 'copy_verified', directory: data }));
const require = createRequire(import.meta.url), embeddedRequire = createRequire(require.resolve('embedded-postgres'));
const pgCtl = (await import(pathToFileURL(embeddedRequire.resolve('@embedded-postgres/windows-x64')).href)).pg_ctl as string;
const listener = createServer(); await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
const port = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve()));
const ctl = (args: string[]) => new Promise<number>((resolve, reject) => { const child = spawn(pgCtl, args, { windowsHide: true, stdio: 'ignore' }); child.once('error', reject); child.once('exit', code => resolve(code ?? -1)); });
const clean = data.replaceAll('\\', '/'); if (!/^[A-Za-z0-9: _./-]+$/.test(clean)) throw new Error('UNSUPPORTED_RESTORE_PATH_CHARACTERS');
const live = new pg.Client({ connectionString: read(path.join(root, '.kff/local-config.json')).database_url }); await live.connect();
const url = new URL(read(path.join(backup, 'local-config.json')).database_url); url.hostname = '127.0.0.1'; url.port = String(port); url.search = ''; url.hash = '';
const tables = async (client: pg.Client, selected?: string[]) => {
  const names = selected ?? (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='kff' AND ($1 OR tablename<>'schema_migrations') ORDER BY tablename", [restoreOnly])).rows.map(row => row.tablename as string);
  const result: Array<{ table: string; rows: number; md5: string }> = [];
  for (const table of names) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error('UNSUPPORTED_TABLE_NAME');
    // The current pending upgrade adds this defaulted column; compare every pre-existing value.
    const content = restoreOnly ? (table === 'agents' ? "to_jsonb(t)-'heartbeat_at'" : 'to_jsonb(t)') : (table === 'facebook_connections' ? "to_jsonb(t)-'transport'" : 'to_jsonb(t)');
    const row = (await client.query(`SELECT count(*)::int rows,md5(coalesce(string_agg((${content})::text,chr(10) ORDER BY (${content})::text),'')) md5 FROM kff."${table}" t`)).rows[0];
    result.push({ table, rows: row.rows, md5: row.md5 });
  }
  return result;
};
const history = async (client: pg.Client) => (await client.query('SELECT version,sha256,applied_at FROM kff.schema_migrations ORDER BY version')).rows;
const mainBefore = await tables(live, restoreOnly ? undefined : ['accounts', 'acquisition_prospects', 'customers', 'conversations', 'messages', 'whatsapp_referrals']);
const runMigration = (codeRoot: string) => new Promise<{ exit_code: number; division_by_zero: boolean; changed_migration_rejected: boolean }>((resolve, reject) => {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'scripts/migrate.ts')], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, KFF_ROOT: codeRoot, DATABASE_URL: url.href } });
  let output = ''; const collect = (bytes: Buffer) => { output = (output + bytes.toString()).slice(-16384); }; child.stdout.on('data', collect); child.stderr.on('data', collect);
  child.once('error', reject); child.once('exit', code => resolve({ exit_code: code ?? -1, division_by_zero: output.includes('division by zero'), changed_migration_rejected: output.includes('Applied migration changed:') }));
});
const migrationFiles = readdirSync(path.join(root, 'supabase/migrations')).filter(file => file.endsWith('.sql')).sort();
const sourceHashes = Object.fromEntries(['scripts/verify-backup.ts', 'scripts/migrate.ts', ...migrationFiles.map(file => 'supabase/migrations/' + file)].map(file => [file, sha256(path.join(root, file))]));
let attempted = false, closed = false, complete = false;
const checks: Record<string, unknown> = {};
try {
  attempted = true;
  if (await ctl(['start', '-D', data, '-l', path.join(target, 'postgres.log'), '-w', '-t', '30', '-o', `-h 127.0.0.1 -p ${port} -c "data_directory=${clean}" -c "config_file=${clean}/postgresql.conf" -c "hba_file=${clean}/pg_hba.conf" -c "ident_file=${clean}/pg_ident.conf" -c archive_mode=off -c shared_preload_libraries=`]) !== 0) throw new Error('RESTORE_START_FAILED');
  const client = new pg.Client({ connectionString: url.href }); await client.connect();
  try {
    const location = (await client.query("SELECT current_setting('data_directory') dir,current_setting('port') port")).rows[0];
    if (path.resolve(location.dir).toLowerCase() !== data.toLowerCase() || Number(location.port) !== port) throw new Error('RESTORE_CONNECTION_MISMATCH');
    if (restoreOnly) await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const before = await tables(client), originalHistory = await history(client);
    const pending = migrationFiles.filter(file => !originalHistory.some(row => row.version === file));
    if (restoreOnly) {
      for (const row of originalHistory) {
        if (!migrationFiles.includes(row.version) || row.sha256 !== createHash('sha256').update(readFileSync(path.join(root, 'supabase/migrations', row.version), 'utf8').replace(/\r\n/g, '\n')).digest('hex')) throw new Error('RESTORED_MIGRATION_CHECKSUM_MISMATCH');
      }
      const restoredTables = [];
      for (const row of before) {
        const content = row.table === 'agents' ? "to_jsonb(t)-'heartbeat_at'" : 'to_jsonb(t)';
        const records = (await client.query(`SELECT (${content})::text payload FROM kff."${row.table}" t ORDER BY (${content})::text`)).rows;
        restoredTables.push({ table: row.table, count: records.length, sha256: createHash('sha256').update(records.map(record => record.payload).join('\n')).digest('hex') });
      }
      const security = (await client.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='kff' AND c.relkind='r' ORDER BY c.relname")).rows;
      await client.query('COMMIT');
      checks.restore = { read_only: true, migrations_applied: 0, pending_migrations: pending, migration_history: originalHistory, migration_checksums_match: true, tables: restoredTables, security, excluded_volatile_fields: ['agents.heartbeat_at'] };
      console.log(JSON.stringify({ stage: 'restore_verified', data_tables: restoredTables.length, migrations: originalHistory.length, migrations_applied: 0 }));
    } else {
    if (pending.length !== 1 || pending[0] !== '20260912172904_browser_message_transport.sql') throw new Error('THIS_UPGRADE_CHECK_REQUIRES_THE_27_MIGRATION_BACKUP');
    const shadow = path.join(target, 'failure-probe'), shadowMigrations = path.join(shadow, 'supabase/migrations'); mkdirSync(shadowMigrations, { recursive: true });
    for (const file of migrationFiles) writeFileSync(path.join(shadowMigrations, file), readFileSync(path.join(root, 'supabase/migrations', file)));
    const changed = path.join(shadowMigrations, pending[0]); writeFileSync(changed, readFileSync(changed, 'utf8') + '\nSELECT 1/0; -- failure probe in the isolated copy only\n');
    console.log(JSON.stringify({ stage: 'migration_failure_probe', from_migrations: originalHistory.length, port }));
    const failure = await runMigration(shadow);
    const transportPresent = async () => Boolean((await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema='kff' AND table_name='facebook_connections' AND column_name='transport'")).rowCount);
    if (!failure.exit_code || !failure.division_by_zero || await transportPresent() || JSON.stringify(await tables(client)) !== JSON.stringify(before) || JSON.stringify(await history(client)) !== JSON.stringify(originalHistory)) throw new Error('FAILED_MIGRATION_WAS_NOT_ATOMIC');
    checks.failed_upgrade = { ...failure, original_data_unchanged: true, history_unchanged: true, new_column_rolled_back: true };
    const applied = await runMigration(root); if (applied.exit_code !== 0) throw new Error('MIGRATION_RUNNER_FAILED');
    const upgradedHistory = await history(client), after = await tables(client);
    if (!await transportPresent() || JSON.stringify(before) !== JSON.stringify(after) || upgradedHistory.length !== migrationFiles.length || JSON.stringify(upgradedHistory.slice(0, originalHistory.length)) !== JSON.stringify(originalHistory)) throw new Error('UPGRADE_DATA_OR_HISTORY_MISMATCH');
    for (const row of upgradedHistory) if (row.sha256 !== createHash('sha256').update(readFileSync(path.join(root, 'supabase/migrations', row.version), 'utf8').replace(/\r\n/g, '\n')).digest('hex')) throw new Error('UPGRADE_HISTORY_CHECKSUM_MISMATCH');
    const transport = (await client.query("SELECT count(*)::int connections,count(*) FILTER(WHERE transport='API')::int api_default FROM kff.facebook_connections")).rows[0];
    if (transport.connections !== transport.api_default) throw new Error('EXISTING_TRANSPORT_CHANGED');
    const repeat = await runMigration(root); if (repeat.exit_code !== 0 || JSON.stringify(await history(client)) !== JSON.stringify(upgradedHistory) || JSON.stringify(await tables(client)) !== JSON.stringify(after)) throw new Error('MIGRATION_RERUN_CHANGED_DATA');
    const stale = await runMigration(shadow); if (!stale.exit_code || !stale.changed_migration_rejected || JSON.stringify(await history(client)) !== JSON.stringify(upgradedHistory) || JSON.stringify(await tables(client)) !== JSON.stringify(after)) throw new Error('CHANGED_MIGRATION_NOT_REJECTED');
    checks.upgrade = { exit_code: applied.exit_code, from_migrations: originalHistory.length, to_migrations: upgradedHistory.length, pending, old_data_tables: before.length, old_data_unchanged: true, transport, before, after, migration_history: upgradedHistory };
    checks.repeat = { exit_code: repeat.exit_code, history_and_data_unchanged: true };
    checks.changed_applied_migration = { ...stale, history_and_data_unchanged: true };
    const security = (await client.query("SELECT c.relname,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='kff' AND c.relname IN ('accounts','acquisition_prospects','messages','facebook_connections','browser_inbox_monitors','browser_inbox_checkpoints') ORDER BY c.relname")).rows;
    const trigger = (await client.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid='kff.check_inbound_message_scope()'::regprocedure")).rows[0];
    if (security.length !== 6 || security.some(row => !row.relrowsecurity) || trigger.prosecdef !== false || JSON.stringify(trigger.proconfig) !== JSON.stringify(['search_path=""'])) throw new Error('MIGRATION_SECURITY_MISMATCH');
    checks.security = security; checks.trigger = trigger;
    }
    for (const [file, hash] of Object.entries(sourceHashes)) if (sha256(path.join(root, file)) !== hash) throw new Error('SOURCE_CHANGED_DURING_VERIFICATION');
    complete = true;
    if (!restoreOnly) console.log(JSON.stringify({ stage: 'upgrade_verified', data_tables: before.length, migrations: migrationFiles.length }));
  } finally { await client.end(); }
} finally {
  try { if (attempted) { if (await ctl(['status', '-D', data]) === 0) await ctl(['stop', '-D', data, '-m', 'fast', '-w', '-t', '30']); closed = await ctl(['status', '-D', data]) === 3; } }
  finally {
    const mainAfter = await tables(live, restoreOnly ? undefined : mainBefore.map(row => row.table)); await live.end();
    const mainUnchanged = JSON.stringify(mainBefore) === JSON.stringify(mainAfter), report = '.kff/checks/backup-' + (restoreOnly ? 'restore-' : 'upgrade-') + id + '.json';
    const result = { schema_version: restoreOnly ? 'kff.backup-restore-check.v1' : 'kff.backup-upgrade-check.v1', checked_at: new Date().toISOString(), complete: complete && closed && mainUnchanged, backup, restored_directory: data, isolated_port: port, source_file_count: manifest.length, original_and_copy_sha256_verified: true, restored_server_closed: closed, checks, main_before: mainBefore, main_after: mainAfter, main_selected_data_unchanged: mainUnchanged, source_sha256: sourceHashes };
    mkdirSync(path.join(root, '.kff/checks'), { recursive: true }); writeFileSync(path.join(root, report), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ stage: 'restore_closed', complete: result.complete, closed, report, main_selected_data_unchanged: result.main_selected_data_unchanged }));
    if (!closed) throw new Error('RESTORE_CLOSE_UNCONFIRMED');
    if (!mainUnchanged) throw new Error('LIVE_DATA_CHANGED_DURING_CHECK');
  }
}
