-- Browser observations reuse the existing Inbox, while keeping browser thread IDs distinct from PSIDs.
ALTER TABLE kff.inbound_events DROP CONSTRAINT inbound_events_source_kind_check;
ALTER TABLE kff.inbound_events ADD CHECK(source_kind IN ('agent','site_chat','stripe','facebook','facebook_browser'));
ALTER TABLE kff.inbound_events DROP CONSTRAINT inbound_source_contract;
ALTER TABLE kff.inbound_events ADD CONSTRAINT inbound_source_contract CHECK(
 (source_kind='agent' AND agent_id IS NOT NULL AND command_id IS NOT NULL AND source_key IS NULL) OR
 (source_kind IN ('site_chat','stripe','facebook','facebook_browser') AND agent_id IS NULL AND command_id IS NULL AND source_key IS NOT NULL AND length(source_key) BETWEEN 1 AND 500));
ALTER TABLE kff.contact_targets DROP CONSTRAINT contact_targets_channel_check;
ALTER TABLE kff.contact_targets ADD CHECK(channel IN ('synthetic','facebook_messenger','facebook_browser_messenger','facebook_comment','facebook_interaction','site_chat'));
ALTER TABLE kff.conversations DROP CONSTRAINT conversations_channel_kind_check;
ALTER TABLE kff.conversations ADD CHECK(channel_kind IN ('SITE_CHAT','FACEBOOK_MESSENGER','FACEBOOK_BROWSER_MESSENGER','FACEBOOK_COMMENT','FACEBOOK_INTERACTION'));
CREATE INDEX browser_inbox_ingress_window ON kff.inbound_events((split_part(source_key,'/',1)),received_at) WHERE source_kind='facebook_browser';

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
      AND e.source_details->'source'->>'thread_id'=i.remote_id AND e.source_details->'source'->>'transport'='BROWSER'
      AND e.source_details->>'body'=NEW.body AND e.source_details->>'kind'=NEW.message_kind
      AND ((NEW.message_kind='ECHO' AND NEW.direction='EXTERNAL_OUTBOUND') OR (NEW.message_kind='MESSAGE' AND NEW.direction='INBOUND'))
      AND NEW.contact_permission_id IS NULL)
   )
 ) THEN RAISE EXCEPTION 'MESSAGE_IDENTITY_MISMATCH'; END IF;
 RETURN NEW;
END $$;
