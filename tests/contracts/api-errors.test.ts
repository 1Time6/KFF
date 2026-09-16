import { it, expect } from 'vitest';
import { z } from 'zod';
import { FIELD_ERROR_LIMIT, fieldErrorsFrom, fieldPathOf, uniqueViolationMessage, validationSummary } from '../../apps/web/lib/api-errors';

const issue = (path: (string | number)[], message: string) => ({ path, message });

// The defect: only `issues[0].message` survived, so the field path was lost and the operator could
// not tell which input to fix.
it('keeps the field path for every reported problem', () => {
  const errors = fieldErrorsFrom([issue(['body'], '正文不能为空'), issue(['expected_version'], '版本必须为正整数')]);
  expect(errors).toEqual([{ field: 'body', message: '正文不能为空' }, { field: 'expected_version', message: '版本必须为正整数' }]);
  expect(validationSummary(errors)).toContain('body：');
  expect(validationSummary(errors)).toContain('共 2 项');
  // A nested path is dotted so the client can locate it.
  expect(fieldPathOf(issue(['policy', 'expires_at'], 'x'))).toBe('policy.expires_at');
  expect(fieldPathOf(issue([], '整份请求不满足约束'))).toBe('(request)');
  expect(fieldPathOf(issue([0, 'id'], 'x'))).toBe('0.id');
  // One entry per field, so a repeated path cannot crowd out the other problems.
  expect(fieldErrorsFrom([issue(['a'], 'first'), issue(['a'], 'second')])).toEqual([{ field: 'a', message: 'first' }]);
  expect(validationSummary([])).toBe('输入无效');
});

// A large payload must not turn one response into a wall of text or leak the whole schema.
it('bounds how many field errors are returned', () => {
  const many = Array.from({ length: 50 }, (_, index) => issue(['field' + index], 'invalid'));
  const errors = fieldErrorsFrom(many);
  expect(errors).toHaveLength(FIELD_ERROR_LIMIT);
  expect(errors[0].field).toBe('field0');
  expect(errors.at(-1)!.field).toBe('field' + (FIELD_ERROR_LIMIT - 1));
});

// Real Zod output must feed the same shape, so this is not a hand-written fixture.
it('accepts the issues a real schema produces', () => {
  const schema = z.object({ body: z.string().min(1), expected_version: z.number().int().positive() }).strict();
  const parsed = schema.safeParse({ body: '', expected_version: 0, extra: true });
  expect(parsed.success).toBe(false);
  if (parsed.success) return;
  const errors = fieldErrorsFrom(parsed.error.issues);
  // A strict schema also reports the unrecognised key against the whole request, which is exactly
  // what `(request)` is for: the operator is told the payload shape is wrong, not a named field.
  expect(errors.map(error => error.field).sort()).toEqual(['(request)', 'body', 'expected_version']);
  expect(errors.some(error => error.field === 'extra')).toBe(false);
  // Every reported message is the validator's own text, not an internal dump.
  for (const error of errors) {
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.message).not.toMatch(/pg_|SELECT |relation |constraint /i);
  }
});

// The unique-violation case used to say "refresh" for every conflict, including ones the operator
// could fix by editing a field. A recognised constraint explains it; anything else stays generic and
// never echoes the database error.
it('explains the unique conflicts it can recognise and stays generic otherwise', () => {
  const known = uniqueViolationMessage('contact_targets_brand_id_account_id_channel_remote_id_key');
  expect(known.recognized).toBe(true);
  expect(known.message).toContain('联系目标');
  const unknown = uniqueViolationMessage('some_other_table_private_key');
  expect(unknown.recognized).toBe(false);
  expect(unknown.message).not.toContain('some_other_table_private_key');
  expect(unknown.message).toContain('刷新');
  expect(unknown.message).not.toMatch(/pg_|SELECT |constraint /i);
  expect(uniqueViolationMessage(undefined).recognized).toBe(false);
});
