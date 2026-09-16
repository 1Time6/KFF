import { randomUUID } from 'node:crypto';
import { query, scoped } from '../../packages/database/src/index';
import type { Scope } from '../../packages/contracts/src/index';
import { browserInboxBatch, browserInboxBinding, type BrowserInboxBinding, type BrowserInboxBatch } from '../../packages/contracts/src/browser-inbox';
import { createFacebookFixture, receiveBrowserInboxBatchInTransaction } from '../../packages/core/src/facebook-inbound';
import { configureEnvironment } from '../../packages/core/src/environments';
import { localIds } from '../../scripts/seed';

export async function browserInboxSetup(scope: Scope, existing?: { account_id: string; environment_id: string }) {
  const account = existing ?? await createFacebookFixture(scope, { request_id: randomUUID(), name: 'Browser Inbox fixture', page_id: BigInt('0x' + randomUUID().replaceAll('-', '')).toString(), agent_id: localIds.agent });
  const row = (await query('SELECT * FROM kff.accounts WHERE id=$1', [account.account_id]))[0];
  const configuration = { driver: 'native' as const, provider_profile_id: null, login_account_id: '800001', operating_identity_id: row.external_id, locale: 'en-US', timezone_id: 'UTC', proxy_ref: null };
  await configureEnvironment(scope, account.environment_id, { expected_version: 1, configuration });
  const environment = (await query('SELECT * FROM kff.environments WHERE id=$1', [account.environment_id]))[0];
  const binding = browserInboxBinding.parse({ account_version: row.version, environment: { environment_id: environment.id, account_id: row.id, agent_id: environment.agent_id, organization_id: scope.organization_id, brand_id: scope.brand_id, profile_key: environment.profile_key, configuration_version: environment.configuration_version, configuration, platform: 'facebook', is_synthetic: true } });
  return { ...account, binding };
}
export function browserInboxSample(binding: BrowserInboxBinding): BrowserInboxBatch {
  return browserInboxBatch.parse({ schema_version: 'kff.browser-inbox-batch.v1', login_account_id: binding.environment.configuration.login_account_id, operating_identity_id: binding.environment.configuration.operating_identity_id, observed_at: new Date().toISOString(), coverage: 'VISIBLE_MESSAGES_ONLY', messages: [{ message_id: 'mid.' + randomUUID(), thread_id: '000777', peer_id: '999888777666555', thread_kind: 'DIRECT', direction: 'INBOUND', body: 'Synthetic browser inquiry', display_name: 'Browser test customer', occurred_at: new Date(Date.now() - 2000).toISOString(), has_attachment: false, source_url: 'https://www.facebook.com/messages/t/000777' }] });
}
export const ingestBrowserBatch = (scope: Scope, binding: BrowserInboxBinding, batch: BrowserInboxBatch) => scoped(scope, client => receiveBrowserInboxBatchInTransaction(client, scope, binding, batch));
