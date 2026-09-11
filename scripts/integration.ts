import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { initializeLocalConfig } from '@kff/database';
const config = initializeLocalConfig();
const databaseName = 'kff_test_' + randomBytes(10).toString('hex');
if (!/^kff_test_[a-f0-9]{20}$/.test(databaseName)) throw new Error('Invalid isolated test database name');
const admin = new pg.Client({ connectionString: config.database_url }); await admin.connect();
await admin.query('CREATE DATABASE "' + databaseName + '"');
const url = new URL(config.database_url); url.pathname = '/' + databaseName;
const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/integration', '--reporter=default', '--reporter=json', '--outputFile=.kff/checks/integration-results.json'], { cwd: process.cwd(), windowsHide: true, stdio: 'inherit', env: { ...process.env, DATABASE_URL: url.href, KFF_TEST_DATABASE: databaseName, KFF_ROOT: path.resolve('.') } });
const code = await new Promise<number>(resolve => child.on('exit', value => resolve(value ?? 1)));
if (code === 0) {
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName]);
  await admin.query('DROP DATABASE "' + databaseName + '"');
} else console.error('Retained isolated failed-test database:', databaseName);
await admin.end(); process.exitCode = code;
