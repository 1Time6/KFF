-- Each account chooses its reception transport; changing it advances the existing connection version.
ALTER TABLE kff.facebook_connections ADD COLUMN transport text NOT NULL DEFAULT 'API' CHECK(transport IN ('API','BROWSER'));
-- Browser replies retain the same contact permission / confirmed-action guard. No new sender queue.
CREATE OR REPLACE FUNCTION kff.check_inbound_message_scope() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM kff.conversations v JOIN kff.customer_identities i ON i.id=v.identity_id
   JOIN kff.inbound_events e ON e.id=NEW.inbound_event_id
   WHERE v.id=NEW.conversation_id AND v.organization_id=NEW.organization_id AND v.brand_id=NEW.brand_id
     AND e.organization_id=v.organization_id AND e.brand_id=v.brand_id AND (
    (e.source_kind='site_chat' AND NEW.direction='INBOUND' AND split_part(e.source_key,'/',1)=v.channel_id::text AND split_part(e.source_key,'/',2)=i.remote_id
      AND EXISTS(SELECT 1 FROM kff.contact_permissions p WHERE p.id=NEW.contact_permission_id AND p.target_id=i.contact_target_id AND p.policy->>'source_ref'=e.id::text)) OR
    (e.source_kind='facebook' AND v.channel_kind IN ('FACEBOOK_MESSENGER','FACEBOOK_COMMENT','FACEBOOK_INTERACTION') AND split_part(e.source_key,'/',1)=v.account_id::text
      AND e.source_details->>'sender_id'=i.remote_id AND e.source_details->>'kind'=NEW.message_kind
      AND ((NEW.message_kind='ECHO' AND NEW.direction='EXTERNAL_OUTBOUND') OR (NEW.message_kind<>'ECHO' AND NEW.direction='INBOUND'))
      AND (NEW.contact_permission_id IS NULL OR EXISTS(SELECT 1 FROM kff.contact_permissions p WHERE p.id=NEW.contact_permission_id AND p.target_id=i.contact_target_id AND p.policy->>'source_ref'=e.id::text))) OR
    (e.source_kind='facebook_browser' AND v.channel_kind='FACEBOOK_BROWSER_MESSENGER' AND i.channel='facebook_browser_messenger'
      AND split_part(e.source_key,'/',1)=v.account_id::text AND e.source_details->>'sender_id'=i.remote_id
      AND e.source_details->'source'->>'thread_id'=i.remote_id AND e.source_details->>'body'=NEW.body
      AND e.source_details->>'kind'=NEW.message_kind AND e.source_details->'source'->>'transport'='BROWSER'
      AND ((NEW.message_kind='MESSAGE' AND NEW.direction='INBOUND') OR (NEW.message_kind='ECHO' AND NEW.direction='EXTERNAL_OUTBOUND'))
      AND (NEW.contact_permission_id IS NULL OR (
        NEW.message_kind='MESSAGE' AND EXISTS(SELECT 1 FROM kff.accounts a JOIN kff.contact_permissions p ON p.id=NEW.contact_permission_id
          WHERE a.id=v.account_id AND a.is_synthetic AND p.target_id=i.contact_target_id AND p.policy->>'source_ref'=e.id::text
            AND p.policy->>'policy_ref'='kff.browser-fixture.service-window.v1')
      )))
   )
 ) THEN RAISE EXCEPTION 'MESSAGE_IDENTITY_MISMATCH'; END IF;
 RETURN NEW;
END $$;
