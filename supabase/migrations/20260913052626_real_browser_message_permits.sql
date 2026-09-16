-- Keep API and read scopes; add the fixed browser message adapter's acceptance receipt.
ALTER TABLE kff.pilot_permits DROP CONSTRAINT pilot_permits_access_path_check;
ALTER TABLE kff.pilot_permits ADD CONSTRAINT pilot_permits_access_path_check
  CHECK (access_path = 'api' OR (access_path = 'browser_read' AND (
    (adapter_version = 'facebook-search-browser-v1' AND expected_evidence = 'collection_page') OR
    (adapter_version = 'facebook-inbox-browser-v1' AND expected_evidence = 'inbox_page')
  )) OR (access_path = 'browser_message' AND adapter_version = 'facebook-browser-messenger-v1'
    AND expected_evidence = 'message_acceptance' AND max_actions = 1
    AND expires_at <= starts_at + interval '1 hour'));

-- A personal-profile browser connection must never be treated as a Page API connection.
CREATE OR REPLACE FUNCTION kff.check_facebook_connection() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
 IF NOT EXISTS(
   SELECT 1 FROM kff.accounts a WHERE a.id=NEW.account_id AND a.platform='facebook'
     AND a.organization_id=NEW.organization_id AND a.brand_id=NEW.brand_id
     AND a.external_id=NEW.page_id AND a.is_synthetic=NEW.is_synthetic
     AND (a.account_type='page' OR (
       a.account_type='profile' AND NOT a.is_synthetic AND NEW.transport='BROWSER'
       AND NOT NEW.auto_reply AND NEW.policy_ref='kff.facebook-browser.explicit-consent.v1'
       AND EXISTS(SELECT 1 FROM kff.environments e WHERE e.id=NEW.environment_id AND e.account_id=a.id
         AND e.organization_id=a.organization_id AND e.brand_id=a.brand_id
         AND e.browser_configuration->>'driver'='adspower'
         AND e.browser_configuration->>'login_account_id'=a.external_id
         AND e.browser_configuration->>'operating_identity_id'=a.external_id)
     ))
 ) THEN RAISE EXCEPTION 'FACEBOOK_ACCOUNT_MISMATCH'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER facebook_connection_identity ON kff.facebook_connections;
CREATE TRIGGER facebook_connection_identity BEFORE INSERT OR UPDATE ON kff.facebook_connections
FOR EACH ROW EXECUTE FUNCTION kff.check_facebook_connection();
