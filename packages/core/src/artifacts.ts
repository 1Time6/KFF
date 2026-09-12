import { readFileSync } from 'node:fs';
import path from 'node:path';
import { digest } from './index';

export function adapterSourceHashes(root: string, adapter: 'facebook' | 'fixture') {
  const files = ['packages/adapters/src/' + adapter + '.ts', 'packages/adapters/src/templates.ts', 'packages/contracts/src/template.ts', 'packages/contracts/src/index.ts', 'packages/core/src/index.ts',...(adapter==='facebook'?['packages/adapters/src/facebook-messenger.ts','packages/adapters/src/facebook-events.ts','packages/contracts/src/lead.ts']:[])];
  return Object.fromEntries(files.map(file => [file, digest(readFileSync(path.join(/* turbopackIgnore: true */ root, file), 'utf8'))]));
}
export function adapterImplementationDigest(root: string, adapter: 'facebook' | 'fixture') { return digest(adapterSourceHashes(root, adapter)); }
