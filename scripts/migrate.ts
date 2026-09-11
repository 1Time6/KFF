import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { transaction, closePool, projectRoot } from '@kff/database';
import { digest } from '@kff/core';

export async function migrate() {
  await transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(73120421)");
    await client.query('CREATE SCHEMA IF NOT EXISTS kff');
    await client.query('CREATE TABLE IF NOT EXISTS kff.schema_migrations (version text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const directory = path.join(projectRoot, 'supabase/migrations');
    for (const file of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
      const sql = await readFile(path.join(directory, file), 'utf8');
      const hash = digest(sql.replace(/\r\n/g, '\n'));
      const previous = await client.query('SELECT sha256 FROM kff.schema_migrations WHERE version=$1', [file]);
      if (previous.rowCount) { if (previous.rows[0].sha256 !== hash) throw new Error('Applied migration changed: ' + file); continue; }
      await client.query(sql);
      await client.query('INSERT INTO kff.schema_migrations(version,sha256) VALUES ($1,$2)', [file, hash]);
      console.log('Applied migration: ' + file);
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { await migrate(); await closePool(); }
