import { setTimeout as delay } from 'node:timers/promises';
import { dispatchOne, recoverExpired } from '../../../packages/core/src/execution';
import { closePool } from '@kff/database';
import { processCollectionPage, purgeExpiredCollectionData } from '../../../packages/core/src/collections';
import { purgeExpiredImports } from '../../../packages/core/src/imports';
import { purgeExpiredTargetSets } from '../../../packages/core/src/target-snapshots';
import {prepareScheduleOne} from '../../../packages/core/src/schedules';
let stopped = false;
let lastRetentionCheck = 0;
process.on('SIGINT', () => { stopped = true; }); process.on('SIGTERM', () => { stopped = true; });
console.log('KFF Worker started');
while (!stopped) {
  try { await recoverExpired(); await dispatchOne(); await processCollectionPage(); await prepareScheduleOne(); if (Date.now() - lastRetentionCheck > 60000) { await purgeExpiredCollectionData(); await purgeExpiredImports(); await purgeExpiredTargetSets(); lastRetentionCheck = Date.now(); } }
  catch { console.error('Worker cycle failed; pending database jobs remain durable.'); }
  await delay(750);
}
await closePool();
