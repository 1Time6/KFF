-- Keep the existing permit, cost, RLS, and reservation mechanisms for bounded browser reads.
ALTER TABLE kff.pilot_permits DROP CONSTRAINT pilot_permits_access_path_check;
ALTER TABLE kff.pilot_permits ADD CONSTRAINT pilot_permits_access_path_check
  CHECK (access_path = 'api' OR (access_path = 'browser_read' AND adapter_version = 'facebook-search-browser-v1' AND expected_evidence = 'collection_page'));
