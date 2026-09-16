import { it, expect } from 'vitest';
import { leadAuditCursor, parseLeadAuditCursor } from '../../packages/core/src/lead-management';

const id = (suffix: string) => '00000000-0000-4000-8000-0000000000' + suffix;
const at = '2026-09-16T10:00:00.000Z';

// The page is ordered by (created_at DESC, id DESC), so the cursor has to carry both keys: a
// timestamp alone cannot separate records that share a timestamp, which is how same-time rows
// leaked across the page boundary.
it('round-trips a position cursor carrying both sort keys', () => {
  const cursor = leadAuditCursor({ id: id('01'), created_at: at });
  expect(cursor).toBe(at + '|' + id('01'));
  expect(parseLeadAuditCursor(cursor)).toEqual({ created_at: at, id: id('01'), legacy: false });
});

// An existing `before` link keeps working, but is reported as the old boundary kind so the caller
// can say the page is bounded by time only.
it('reads a bare timestamp as a legacy cursor and says so', () => {
  expect(parseLeadAuditCursor(at)).toEqual({ created_at: at, id: null, legacy: true });
  expect(parseLeadAuditCursor(undefined)).toBeNull();
  // The very first page has no cursor at all, which is not the same as a legacy one.
  expect(parseLeadAuditCursor('')).toBeNull();
});

// A malformed cursor is refused rather than silently treated as "no cursor", which would restart
// the listing from the newest record and look like duplicated pages.
it('refuses a malformed cursor instead of ignoring it', () => {
  for (const value of ['not-a-date', at + '|not-a-uuid', at + '|', '|' + id('01'), '2026-13-45T00:00:00.000Z']) {
    expect(() => parseLeadAuditCursor(value), value).toThrow();
  }
});

// Timestamps with a separator-like character are impossible in ISO form, so the separator can only
// be the one before the id.
it('splits on the last separator so the timestamp is never truncated', () => {
  const parsed = parseLeadAuditCursor(leadAuditCursor({ id: id('0a'), created_at: at }));
  expect(parsed?.created_at).toBe(at);
  expect(parsed?.id).toBe(id('0a'));
  // Two different records at the same instant produce different cursors.
  expect(leadAuditCursor({ id: id('01'), created_at: at })).not.toBe(leadAuditCursor({ id: id('02'), created_at: at }));
});
