import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { environmentResultInput } from '../../../packages/contracts/src/environment';
export const environmentClosure = z.object({ id: z.string().uuid(), nonce: z.string().regex(/^[a-f0-9]{64}$/), result: environmentResultInput, closed_at: z.iso.datetime() }).strict();
export function environmentClosureFile(runtime: string, id: string) { return path.join(runtime, 'agent', 'environment-closures', z.string().uuid().parse(id) + '.json'); }
export function saveEnvironmentClosure(runtime: string, record: z.infer<typeof environmentClosure>) {
  const value = environmentClosure.parse(record); const file = environmentClosureFile(runtime, value.id);
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file)) throw new Error('ENVIRONMENT_CLOSURE_EXISTS');
  writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600, flush: true }); renameSync(file + '.tmp', file);
}
export function readEnvironmentClosure(runtime: string, id: string, nonce: string) {
  const file = environmentClosureFile(runtime, id); if (!existsSync(file)) return null;
  const value = environmentClosure.parse(JSON.parse(readFileSync(file, 'utf8')));
  if (value.id !== id || value.nonce !== nonce) throw new Error('ENVIRONMENT_CLOSURE_MISMATCH');
  return value;
}
