import { it, expect } from 'vitest';
import { importMappingFingerprint, importPreviewFreshness, type ImportMappingInput } from '../../apps/web/components/import-mapping';

const mapping = (change: Partial<ImportMappingInput> = {}): ImportMappingInput => ({
  sheet: 0, header_row: 1, source_object_id: 0,
  fields: { message: 1, author_id: 2 }, kind_columns: { message: 3 }, text_encoding: 'plain',
  ...change,
});
const onScreen = (change: Partial<ImportMappingInput> = {}) => importMappingFingerprint(mapping(change));
const previewOf = (change: Partial<ImportMappingInput> = {}) => ({ mapping: mapping(change) });

// Every input that can change what a preview means must change the comparison, otherwise editing it
// leaves the old preview confirmable.
it('changes the fingerprint for every mapping input', () => {
  const base = onScreen();
  const edits: [string, Partial<ImportMappingInput>][] = [
    ['sheet', { sheet: 1 }],
    ['header row', { header_row: 2 }],
    ['object id column', { source_object_id: 4 }],
    ['a field column', { fields: { message: 1, author_id: 5 } }],
    ['a field removed', { fields: { message: 1 } }],
    ['a field added', { fields: { message: 1, author_id: 2, reaction_count: 3 } }],
    ['a status column', { kind_columns: { message: 4 } }],
    ['a status column removed', { kind_columns: {} }],
    ['the text encoding', { text_encoding: 'kff-apostrophe-v1' }],
  ];
  for (const [label, change] of edits) expect(onScreen(change), label).not.toBe(base);
  // The same mapping always compares equal, whatever the key order.
  expect(onScreen({ fields: { author_id: 2, message: 1 } })).toBe(base);
  expect(onScreen()).toBe(base);
});

// A preview is only confirmable while the on-screen mapping still matches it.
it('treats a preview as stale once any mapping input moves', () => {
  expect(importPreviewFreshness(previewOf(), onScreen())).toEqual({ fresh: true, reason: null });
  for (const change of [{ sheet: 1 }, { header_row: 3 }, { fields: { message: 2 } }, { kind_columns: {} }, { text_encoding: 'kff-apostrophe-v1' }] as Partial<ImportMappingInput>[]) {
    const verdict = importPreviewFreshness(previewOf(), onScreen(change));
    expect(verdict.fresh, JSON.stringify(change)).toBe(false);
    expect(verdict.reason).toContain('重新预览');
  }
});

// A record that has never been previewed is not stale, it simply has nothing to confirm yet; a
// preview without a stored mapping cannot be trusted to match; and a re-generated preview is fresh.
it('distinguishes "never previewed" from "stale" and accepts a re-generated preview', () => {
  const none = importPreviewFreshness(null, onScreen());
  expect(none.fresh).toBe(false);
  expect(none.reason).toContain('还没有预览');
  expect(importPreviewFreshness(undefined, onScreen()).reason).toContain('还没有预览');
  // A preview stored before the mapping was returned carries nothing to compare against.
  const legacy = importPreviewFreshness({}, onScreen());
  expect(legacy.fresh).toBe(false);
  // After re-previewing with the edited mapping, the stored mapping matches what is on screen.
  const edited: Partial<ImportMappingInput> = { fields: { message: 2 } };
  expect(importPreviewFreshness(previewOf(edited), onScreen(edited))).toEqual({ fresh: true, reason: null });
  // Reverting the edit makes the original preview valid again, which is correct: it matches.
  expect(importPreviewFreshness(previewOf(), onScreen()).fresh).toBe(true);
  // The original preview does not match the edited screen, which is the defect being closed.
  expect(importPreviewFreshness(previewOf(), onScreen(edited)).fresh).toBe(false);
});
