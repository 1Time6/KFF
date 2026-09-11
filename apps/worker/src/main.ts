import { setTimeout as delay } from 'node:timers/promises';
import { dispatchOne, recoverExpired } from '../../../packages/core/src/execution';
import { closePool } from '@kff/database';
let stopped = false;
process.on('SIGINT', () => { stopped = true; }); process.on('SIGTERM', () => { stopped = true; });
console.log('KFF Worker started');
while (!stopped) {
  try { await recoverExpired(); await dispatchOne(); }
  catch { console.error('Worker cycle failed; pending database jobs remain durable.'); }
  await delay(750);
}
await closePool();
