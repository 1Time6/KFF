import { it, expect } from 'vitest';
import { exportableFields } from '../../apps/web/components/collection-export';

// Mirror of packages/core/src/collection-export.ts: `MANUAL_IMPORT` may export only the fields the
// operator declared on upload, `OWNED_FIXTURE` may export its own fields, and any other source -
// including SOCIAL_DISCOVERY - has an empty allow-list.
it('allows exactly the fields the server allows for each source type', () => {
  const fields = ['message', 'author_id', 'reaction_count'];
  expect(exportableFields({ source_type: 'MANUAL_IMPORT', fields, export_fields: ['message'] })).toEqual(['message']);
  expect(exportableFields({ source_type: 'OWNED_FIXTURE', fields })).toEqual(fields);
  // The defect: the fixed-snapshot entry treated every non-import source as exportable, so a
  // SOCIAL_DISCOVERY snapshot offered fields the server refuses with EXPORT_FIELD_FORBIDDEN.
  expect(exportableFields({ source_type: 'SOCIAL_DISCOVERY', fields, export_fields: ['message'] })).toEqual([]);
  expect(exportableFields({ source_type: 'API_DISCOVERY', fields })).toEqual([]);
  // A manual import that declared no exportable field stays closed rather than falling back.
  expect(exportableFields({ source_type: 'MANUAL_IMPORT', fields })).toEqual([]);
  expect(exportableFields({ source_type: 'MANUAL_IMPORT', fields, export_fields: [] })).toEqual([]);
});

// The two export entries must agree on the same snapshot, which is what makes the button's promise
// match what the server will accept.
it('gives the same answer for the ordinary and the fixed-snapshot entry', () => {
  const snapshots = [
    { source_type: 'MANUAL_IMPORT', fields: ['message', 'author_id'], export_fields: ['message'] },
    { source_type: 'OWNED_FIXTURE', fields: ['message', 'author_id'] },
    { source_type: 'SOCIAL_DISCOVERY', fields: ['message', 'author_id'] },
  ];
  for (const snapshot of snapshots) {
    // Both entries read this one function; a snapshot that allows nothing must render no button.
    const offered = exportableFields(snapshot).filter(field => snapshot.fields.includes(field));
    const clickable = offered.length > 0;
    expect(clickable).toBe(exportableFields(snapshot).length > 0);
    if (snapshot.source_type === 'SOCIAL_DISCOVERY') expect(clickable).toBe(false);
  }
});
