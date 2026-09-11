import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
const sourceFiles = ['packages/adapters/src/facebook.ts','packages/adapters/src/fixture.ts','packages/contracts/src/index.ts','packages/core/src/index.ts','packages/core/src/service.ts','packages/core/src/execution.ts','packages/core/src/permits.ts','packages/core/src/reconciliation.ts','apps/agent/src/main.ts','apps/web/components/workbench.tsx','tests/contracts/facebook.test.ts'];
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
const child = spawn(process.execPath, commands[name], { cwd: process.cwd(), stdio: ['ignore', log, log], windowsHide: true, env: { ...process.env, KFF_ROOT: process.cwd(), KFF_CHECK_NAME: name, NEXT_TELEMETRY_DISABLED: '1' } });
child.on('exit', (code, signal) => {
  closeSync(log);
  const result = { name, started_at: startedAt, ended_at: new Date().toISOString(), exit_code: code, signal, process_id: child.pid, command: ['node', ...commands[name]], source_hashes: sourceHashes };
  writeFileSync(path.join(directory, name + '.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); process.exitCode = code ?? 1;
});
