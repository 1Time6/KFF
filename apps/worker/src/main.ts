import { prepareBrowserInboxPage, syncBrowserInboxTasks } from '../../../packages/core/src/browser-inbox';
import { prepareBrowserCollectionPage, syncBrowserCollectionTasks } from '../../../packages/core/src/browser-collections';
import { setTimeout as delay } from 'node:timers/promises';
import { dispatchOne, recoverExpired } from '../../../packages/core/src/execution';
import { closePool } from '@kff/database';
import { recoverEnvironmentCommands } from '../../../packages/core/src/environments';
import { processCollectionPage, purgeExpiredCollectionData } from '../../../packages/core/src/collections';
import { purgeExpiredImports } from '../../../packages/core/src/imports';
import { purgeExpiredTargetSets } from '../../../packages/core/src/target-snapshots';
import {prepareScheduleOne} from '../../../packages/core/src/schedules';
import {processStripeCheckout,processStripeEvent} from '../../../packages/core/src/payment-worker';
import {processRefundLedger} from '../../../packages/core/src/refund-worker';
import {schedulePendingReception} from '../../../packages/core/src/reception-queue';
import {processReceptionOne} from '../../../packages/core/src/reception-worker';
import {prepareDiscoveryScan,projectDiscoveryLeads,prepareAcquisitionAction} from '../../../packages/core/src/acquisition';
import {deriveCommentMonitors} from '../../../packages/core/src/acquisition-continuation';
import {purgeExpiredProviderData} from '../../../packages/core/src/acquisition-provider';
import {isDrainRequest,localSupervisionProtocol} from '../../../packages/contracts/src/local-supervision';
let stopped = false;
let lastRetentionCheck = 0;
process.on('SIGINT', () => { stopped = true; }); process.on('SIGTERM', () => { stopped = true; });
process.on('message',message=>{if(isDrainRequest(message)){stopped=true;process.send?.({protocol:localSupervisionProtocol,state:'DRAINING'});}});
process.on('disconnect',()=>{stopped=true;});
console.log('KFF Worker started');
process.send?.({protocol:localSupervisionProtocol,state:'RUNNING'});
// Provider I/O must not stall execution leases, dispatch or stopping in the main loop.
const paymentsRunning=(async()=>{while(!stopped){try{await processStripeEvent();await processStripeCheckout();await processRefundLedger();}catch{console.error('Payment cycle failed; durable requests remain queued.');}await delay(750);}})();
const receptionRunning=(async()=>{while(!stopped){try{await schedulePendingReception();await processReceptionOne();}catch{console.error('Reception cycle failed; durable jobs retain their retry state.');}await delay(750);}})();
const acquisitionRunning=(async()=>{while(!stopped){try{await deriveCommentMonitors();await prepareDiscoveryScan();await prepareBrowserCollectionPage();await processCollectionPage();await projectDiscoveryLeads();await prepareAcquisitionAction();}catch{console.error('Acquisition cycle failed; durable checkpoints retained.');}await delay(750);}})();
while (!stopped) {
  try { await recoverEnvironmentCommands(); await recoverExpired(); await syncBrowserCollectionTasks(); await syncBrowserInboxTasks(); await prepareBrowserInboxPage(); await dispatchOne(); await prepareScheduleOne(); if (Date.now() - lastRetentionCheck > 60000) { await purgeExpiredCollectionData(); await purgeExpiredProviderData(); await purgeExpiredImports(); await purgeExpiredTargetSets(); lastRetentionCheck = Date.now(); } }
  catch { console.error('Worker cycle failed; pending database jobs remain durable.'); }
  await delay(750);
}
await paymentsRunning;
await receptionRunning;
await acquisitionRunning;
await closePool();
if(process.connected){process.send?.({protocol:localSupervisionProtocol,state:'DRAINED'});process.disconnect();}
