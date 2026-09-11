import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { agentCommandSchema } from '../../packages/contracts/src/index';
import { runGuardian } from '../../apps/agent/src/guardian';

process.once('message', async raw => {
  const input = z.object({ command: agentCommandSchema, runtime: z.string() }).strict().parse(raw);
  const nonce = randomBytes(32).toString('hex'); process.send?.({ type: 'identity', nonce });
  await runGuardian(input.command, input.runtime, nonce, { signal: new AbortController().signal, beforeSubmit: async () => { throw new Error('Unresponsive owner may not grant a write'); }, onContextOpened: () => {
    process.send?.({ type: 'frozen' }, () => {
      // Freeze only this deliberately spawned test owner, leaving the guardian event loop independent.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
    });
  } });
  process.exit(0);
});
