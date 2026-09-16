import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { sourceHash } from './source-hash.mjs';
import path from 'node:path';

const commands = {
  typecheck: ['node_modules/typescript/bin/tsc', '--noEmit'],
  lint: ['node_modules/eslint/bin/eslint.js', '.'],
  unit: ['node_modules/vitest/vitest.mjs', 'run', 'tests/unit', '--reporter=default', '--reporter=json', '--outputFile=.kff/checks/unit-results.json'],
  contracts: ['node_modules/vitest/vitest.mjs', 'run', 'tests/contracts', '--reporter=default', '--reporter=json', '--outputFile=.kff/checks/contracts-results.json'],
  integration: ['node_modules/tsx/dist/cli.mjs', 'scripts/integration.ts'],
  fixtures: ['node_modules/@playwright/test/cli.js', 'test', '--project=fixtures'],
  web: ['node_modules/@playwright/test/cli.js', 'test', '--project=web'],
  build: ['node_modules/next/dist/bin/next', 'build', 'apps/web'],
  production: ['node_modules/tsx/dist/cli.mjs', 'scripts/production-smoke.ts'],
};
const name = process.argv[2];
if (!Object.hasOwn(commands, name)) throw new Error('Unknown check');
const directory = path.resolve('.kff/checks'); mkdirSync(directory, { recursive: true });
const log = openSync(path.join(directory, name + '.log'), 'w');
const startedAt = new Date().toISOString();
const sourceFiles = [...new Set(execFileSync('git', ['-c','core.quotepath=false','ls-files','--cached','--others','--exclude-standard'], { encoding: 'utf8' }).split(/\r?\n/))].filter(file => !file.endsWith('next-env.d.ts') && ((/^(apps|packages|scripts|tests|supabase)\//.test(file) && /\.(ts|tsx|mjs|sql|css|json|toml|xlsx)$/.test(file)) || ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','eslint.config.mjs','vitest.config.ts','playwright.config.ts'].includes(file))).sort();
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, sourceHash(file)]));
const child = spawn(process.execPath, commands[name], { cwd: process.cwd(), stdio: ['ignore', log, log], windowsHide: true, env: { ...process.env, KFF_ROOT: process.cwd(), KFF_CHECK_NAME: name, NEXT_TELEMETRY_DISABLED: '1' } });
child.on('exit', (code, signal) => {
  closeSync(log);
  const changed = Object.entries(sourceHashes).filter(([file, hash]) => sourceHash(file) !== hash).map(([file]) => file);
  const result = { name, started_at: startedAt, ended_at: new Date().toISOString(), exit_code: changed.length ? 1 : code, child_exit_code: code, changed_during_check: changed, signal, process_id: child.pid, command: ['node', ...commands[name]], source_hashes: sourceHashes };
  writeFileSync(path.join(directory, name + '.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ name, exit_code: result.exit_code, changed_during_check: changed, covered_source_files: sourceFiles.length })); process.exitCode = result.exit_code ?? 1;
});
