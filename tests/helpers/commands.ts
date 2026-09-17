import { randomUUID } from 'node:crypto';
import { digest } from '../../packages/core/src/index';
import type { AgentCommand, TaskSnapshot } from '../../packages/contracts/src/index';
import { fixedPageManifest } from '../../packages/adapters/src/templates';

export function fixtureCommand(overrides: Partial<TaskSnapshot> = {}): AgentCommand {
  const snapshot: TaskSnapshot = { account_id: randomUUID(), external_account_id: '100000000000000001', environment_id: randomUUID(), profile_key: randomUUID(), agent_id: randomUUID(), capability_id: randomUUID(), capability_key: 'kff.fixture.page.publish.browser', capability_revision: 1, adapter_version: 'fixture-page-v1', body: 'Line one\n第二行 <safe>', content_hash: '', mode: 'TEST_ONLY', fixture_scenario: 'normal', is_synthetic: true, ...overrides };
  snapshot.content_hash = digest(snapshot.body);
  const manifest = fixedPageManifest(snapshot.capability_key);
  snapshot.template ??= { version_id: randomUUID(), version_number: 1, manifest_hash: digest(manifest), manifest };
  return { protocol_version: 'kff.agent.v1', id: randomUUID(), action_id: randomUUID(), attempt_id: randomUUID(), run_id: randomUUID(), organization_id: randomUUID(), brand_id: randomUUID(), agent_id: snapshot.agent_id, snapshot, snapshot_hash: digest(snapshot), leases: [{ resource_type: 'account', resource_id: snapshot.account_id, token: '90071992547409930' }, { resource_type: 'environment', resource_id: snapshot.environment_id, token: '1' }], expires_at: new Date(Date.now() + 60000).toISOString() };
}

/**
 * A synthetic private-message task. `executeFixtureMessage` asks for submission authority before it
 * performs any I/O, so a child running this command reaches the `before-submit` boundary with nothing
 * else in between - which is what makes it the fixture for every phase from the intent onward.
 */
export function submitBoundaryCommand(): AgentCommand {
  return fixtureCommand({
    capability_key: 'kff.fixture.messenger.reply.api', adapter_version: 'fixture-messenger-v1',
    message: {
      conversation_id: randomUUID(), trigger_message_id: randomUUID(), trigger_sequence: 1, control_version: 1,
      actor_kind: 'AI', actor_id: randomUUID(), connection_version: 1,
      contact: { target_id: randomUUID(), permission_id: randomUUID(), purpose: 'customer_service', account_id: randomUUID(), channel: 'facebook_messenger', remote_id: '999888777666555', target_version: 1, policy_hash: 'b'.repeat(64) },
      stop_epochs: { organization: 0, brand: 0, account: 0, agent: 0 }, referral: null,
    },
  });
}
