/**
 * Presentation state for the paged contact lists.
 *
 * The panel used to fetch the brand-wide list and filter by account in the browser, so an account
 * whose records were older than the newest 200 brand rows looked empty. The API now filters by
 * account before LIMIT and returns a `(created_at, id)` cursor, but the page still has to tell
 * "this account has no records" apart from "this page has no more records" - showing the first as
 * the second is what made the missing records invisible.
 */
export interface ContactCursorState {
  cursor: string | null;
  loaded: number;
}
export interface ContactPageMeta {
  /** True while the server says another page exists. */
  has_more: boolean;
  /** The cursor to request next, or null when the list is complete. */
  next_cursor: string | null;
}
export interface ContactListNotice {
  /** What to show under the list, or null when there is nothing worth saying. */
  text: string | null;
  /** Whether the "load more" control should be offered. */
  can_load_more: boolean;
}

export function contactListNotice(meta: ContactPageMeta, state: ContactCursorState): ContactListNotice {
  if (meta.has_more && meta.next_cursor) return { text: `已显示 ${state.loaded} 条，还有更多记录未显示。`, can_load_more: true };
  // Nothing loaded and no further page: the account really has no records, and saying so is the
  // point of the distinction.
  if (state.loaded === 0) return { text: '此账号还没有记录。', can_load_more: false };
  // A cursor was supplied but the page came back empty while earlier pages exist: that is a genuine
  // end of list, not an empty account.
  return { text: `已显示全部 ${state.loaded} 条。`, can_load_more: false };
}

/** The query string for one page of the contact list, always scoped to the selected account. */
export function contactListQuery(accountId: string, cursor?: { targets?: string | null; permissions?: string | null }): string {
  const search = new URLSearchParams({ account_id: accountId });
  if (cursor?.targets) search.set('targets_cursor', cursor.targets);
  if (cursor?.permissions) search.set('permissions_cursor', cursor.permissions);
  return search.toString();
}

/** Merge a newly loaded page into what is already displayed, skipping ids already present. */
export function appendContactPage<T extends { id: string }>(loaded: readonly T[], page: readonly T[]): T[] {
  const seen = new Set(loaded.map(item => item.id));
  return [...loaded, ...page.filter(item => !seen.has(item.id))];
}
