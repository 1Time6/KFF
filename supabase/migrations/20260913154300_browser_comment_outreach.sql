-- Public comment replies use the original task, approval, permit and action stores.
ALTER TABLE kff.pilot_permits DROP CONSTRAINT pilot_permits_access_path_check;
ALTER TABLE kff.pilot_permits ADD CONSTRAINT pilot_permits_access_path_check
  CHECK (access_path = 'api' OR (access_path = 'browser_read' AND (
    (adapter_version = 'facebook-search-browser-v1' AND expected_evidence = 'collection_page') OR
    (adapter_version = 'facebook-inbox-browser-v1' AND expected_evidence = 'inbox_page')
  )) OR (access_path IN ('browser_message','browser_comment')
    AND adapter_version = CASE access_path WHEN 'browser_comment' THEN 'facebook-browser-comment-v1' ELSE 'facebook-browser-messenger-v1' END
    AND expected_evidence = 'message_acceptance' AND max_actions = 1
    AND expires_at <= starts_at + interval '1 hour'));

-- Keep superseded unexecuted drafts for audit; a submitted action is never replaceable.
ALTER TABLE kff.acquisition_action_links ADD COLUMN superseded_at timestamptz;
ALTER TABLE kff.acquisition_action_links DROP CONSTRAINT acquisition_action_links_account_id_platform_source_object__key;
CREATE UNIQUE INDEX acquisition_current_outreach
  ON kff.acquisition_action_links(account_id,platform,source_object_id,action_kind)
  WHERE superseded_at IS NULL;
GRANT UPDATE(superseded_at) ON kff.acquisition_action_links TO kff_app;
