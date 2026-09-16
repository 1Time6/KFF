/**
 * Comparison of the import mapping a preview was generated from against the mapping on screen.
 *
 * `imports/:id/confirmations` locks onto the `preview_id` and `preview_hash` it is given, and the
 * server re-checks that hash against the stored rows and mapping — that part is correct and stays.
 * What was missing is the other direction: changing the sheet, the header row, a field mapping, a
 * status column or the text encoding left the old preview in place and the confirm button usable,
 * so the page could submit a preview that no longer matched what was on screen.
 *
 * The comparison is canonical text, not a digest, so the client needs no crypto: the order of the
 * mapping keys is normalised on both sides and everything else is compared as written.
 */
export interface ImportMappingInput {
  sheet: number;
  header_row: number;
  source_object_id: number;
  fields: Record<string, number>;
  kind_columns: Record<string, number>;
  text_encoding: unknown;
}

/** Canonical, order-independent text for every input that can change what a preview means. */
export function importMappingFingerprint(input: ImportMappingInput): string {
  const pairs = (value: Record<string, number> | undefined) => Object.keys(value ?? {}).sort().map(key => key + '=' + (value as Record<string, number>)[key]).join(',');
  return JSON.stringify([
    Number(input.sheet), Number(input.header_row), Number(input.source_object_id),
    pairs(input.fields), pairs(input.kind_columns), String(input.text_encoding ?? ''),
  ]);
}

/**
 * Whether the on-screen mapping still matches the preview that would be committed. A record that
 * was never previewed is not "stale", it simply has nothing to confirm yet.
 */
export function importPreviewFreshness(preview: { mapping?: unknown } | null | undefined, currentFingerprint: string): { fresh: boolean; reason: string | null } {
  if (!preview) return { fresh: false, reason: '还没有预览：请先选择字段映射并生成预览。' };
  // A preview stored before this comparison existed carries no mapping to compare against, so it is
  // treated as stale rather than silently confirmable.
  if (!preview.mapping || typeof preview.mapping !== 'object') return { fresh: false, reason: '此预览没有保存映射版本：请重新预览后再确认入库。' };
  if (importMappingFingerprint(preview.mapping as ImportMappingInput) !== currentFingerprint) return { fresh: false, reason: '字段映射已修改：当前预览对应的是修改前的映射，请重新预览后再确认入库。' };
  return { fresh: true, reason: null };
}
