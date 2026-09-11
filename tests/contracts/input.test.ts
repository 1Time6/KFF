import { expect, it } from 'vitest';
import { externalId, accountInput, resultInput, taskInput } from '../../packages/contracts/src/index';
import { agentCommandSchema } from '../../packages/contracts/src/index';
import { fixtureCommand } from '../helpers/commands';

it('preserves IDs beyond JavaScript safe integer precision', () => {
  expect(externalId.parse('000123456789012345678901234567890')).toBe('000123456789012345678901234567890');
  expect(externalId.safeParse(1234567890123456).success).toBe(false);
});
it('does not accept a client-supplied brand or success flag', () => {
  expect(accountInput.safeParse({ display_name: 'page', external_id: '1234', platform: 'facebook', account_type: 'page', brand_id: 'forged' }).success).toBe(false);
  expect(resultInput.safeParse({ allowed: true, outcome: 'SUCCESS' }).success).toBe(false);
});
it('rejects unknown execution modes and arbitrary fixture code', () => {
  const value = { title: 'test', account_id: '44444444-4444-4444-8444-444444444444', environment_id: '55555555-5555-4555-8555-555555555555', capability_id: '77777777-7777-4777-8777-777777777777', idempotency_key: 'test-request-1', mode: 'AUTO_APPROVED', fixture_scenario: 'javascript:alert(1)' };
  expect(taskInput.safeParse(value).success).toBe(false);
});
it('rejects unknown protocols, execution fields and malformed resource tokens', () => {
  const command = fixtureCommand();
  expect(agentCommandSchema.parse(command).leases[0].token).toBe('90071992547409930');
  expect(agentCommandSchema.safeParse({ ...command, protocol_version: 'kff.agent.v999' }).success).toBe(false);
  expect(agentCommandSchema.safeParse({ ...command, snapshot: { ...command.snapshot, shell: 'arbitrary' } }).success).toBe(false);
  expect(agentCommandSchema.safeParse({ ...command, leases: [{ ...command.leases[0], token: 1 }, command.leases[1]] }).success).toBe(false);
});
