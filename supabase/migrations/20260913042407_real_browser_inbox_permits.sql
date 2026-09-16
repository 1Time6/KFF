-- Preserve the existing API and public collection scopes; add only the fixed Inbox read adapter.
ALTER TABLE kff.pilot_permits DROP CONSTRAINT pilot_permits_access_path_check;
ALTER TABLE kff.pilot_permits ADD CONSTRAINT pilot_permits_access_path_check
  CHECK (access_path = 'api' OR (access_path = 'browser_read' AND (
    (adapter_version = 'facebook-search-browser-v1' AND expected_evidence = 'collection_page') OR
    (adapter_version = 'facebook-inbox-browser-v1' AND expected_evidence = 'inbox_page')
  )));
