import { it, expect } from 'vitest';
import { appendContactPage, contactListNotice, contactListQuery } from '../../apps/web/components/contact-list';

// The panel filtered a brand-wide page in the browser, so "no records for this account" and "no more
// records on this page" looked identical. These are the two cases that must read differently.
it('distinguishes an account with no records from a page with no more records', () => {
  const empty = contactListNotice({ has_more: false, next_cursor: null }, { cursor: null, loaded: 0 });
  expect(empty.text).toContain('还没有记录');
  expect(empty.can_load_more).toBe(false);
  const complete = contactListNotice({ has_more: false, next_cursor: null }, { cursor: '2026-09-16T00:00:00.000Z|00000000-0000-4000-8000-000000000001', loaded: 40 });
  expect(complete.text).toContain('全部 40 条');
  expect(complete.text).not.toContain('还没有记录');
  expect(complete.can_load_more).toBe(false);
  // A further page is offered, and the count says the list is not complete.
  const more = contactListNotice({ has_more: true, next_cursor: '2026-09-16T00:00:00.000Z|00000000-0000-4000-8000-000000000001' }, { cursor: null, loaded: 200 });
  expect(more.can_load_more).toBe(true);
  expect(more.text).toContain('更多记录未显示');
  // A server that claims more without a cursor must not offer a control that cannot work.
  expect(contactListNotice({ has_more: true, next_cursor: null }, { cursor: null, loaded: 5 }).can_load_more).toBe(false);
});

// The account filter has to be on every request, and the cursor only when continuing.
it('always scopes the request to the account', () => {
  const account = '11111111-1111-4111-8111-111111111111';
  expect(contactListQuery(account)).toBe('account_id=' + account);
  expect(contactListQuery(account)).toContain('account_id=');
  const next = contactListQuery(account, { targets: 'a|b' });
  expect(next).toContain('targets_cursor=a%7Cb');
  expect(next).not.toContain('permissions_cursor');
  const both = contactListQuery(account, { targets: 'a|b', permissions: 'c|d' });
  expect(both).toContain('permissions_cursor=c%7Cd');
  // An empty cursor is omitted rather than sent as an empty value.
  expect(contactListQuery(account, { targets: '', permissions: null })).not.toContain('cursor');
});

// Appending a page must not duplicate a record that is already shown, whatever the server returns.
it('appends a page without duplicating an already loaded record', () => {
  const loaded = [{ id: 'a' }, { id: 'b' }];
  expect(appendContactPage(loaded, [{ id: 'c' }]).map(row => row.id)).toEqual(['a', 'b', 'c']);
  expect(appendContactPage(loaded, [{ id: 'b' }, { id: 'c' }]).map(row => row.id)).toEqual(['a', 'b', 'c']);
  expect(appendContactPage(loaded, [])).toEqual(loaded);
  expect(appendContactPage([], [{ id: 'a' }])).toEqual([{ id: 'a' }]);
});
