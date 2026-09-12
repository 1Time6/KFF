import { setTimeout as delay } from 'node:timers/promises';
import { dispatchOne, recoverExpired } from '../../../packages/core/src/execution';
import { closePool } from '@kff/database';
import { processCollectionPage, purgeExpiredCollectionData } from '../../../packages/core/src/collections';
import { purgeExpiredImports } from '../../../packages/core/src/imports';
import { purgeExpiredTargetSets } from '../../../packages/core/src/target-snapshots';
import {prepareScheduleOne} from '../../../packages/core/src/schedules';
import {processStripeCheckout,processStripeEvent} from '../../../packages/core/src/payment-worker';
let stopped = false;
let lastRetentionCheck = 0;
process.on('SIGINT', () => { stopped = true; }); process.on('SIGTERM', () => { stopped = true; });
console.log('KFF Worker started');
// Provider I/O must not stall execution leases, dispatch or stopping in the main loop.
const paymentsRunning=(async()=>{while(!stopped){try{await processStripeEvent();await processStripeCheckout();}catch{console.error('Payment cycle failed; durable requests remain queued.');}await delay(750);}})();
while (!stopped) {
  try { await recoverExpired(); await dispatchOne(); await processCollectionPage(); await prepareScheduleOne(); if (Date.now() - lastRetentionCheck > 60000) { await purgeExpiredCollectionData(); await purgeExpiredImports(); await purgeExpiredTargetSets(); lastRetentionCheck = Date.now(); } }
  catch { console.error('Worker cycle failed; pending database jobs remain durable.'); }
  await delay(750);
}
await paymentsRunning;
await closePool();
