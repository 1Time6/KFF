-- Extend the existing Inbox/Customer/Event models; no parallel CRM or execution queue.
ALTER TABLE kff.inbound_events DROP CONSTRAINT inbound_events_source_kind_check;
ALTER TABLE kff.inbound_events DROP CONSTRAINT inbound_source_contract;
ALTER TABLE kff.inbound_events ADD CHECK(source_kind IN ('agent','site_chat','stripe','facebook'));
ALTER TABLE kff.inbound_events ADD CONSTRAINT inbound_source_contract CHECK(
 (source_kind='agent' AND agent_id IS NOT NULL AND command_id IS NOT NULL AND source_key IS NULL) OR
 (source_kind IN ('site_chat','stripe','facebook') AND agent_id IS NULL AND command_id IS NULL AND source_key IS NOT NULL AND length(source_key) BETWEEN 1 AND 500));
ALTER TABLE kff.inbound_events ADD COLUMN source_details jsonb;
ALTER TABLE kff.contact_targets DROP CONSTRAINT contact_targets_channel_check;
ALTER TABLE kff.contact_targets ADD CHECK(channel IN ('synthetic','facebook_messenger','facebook_comment','facebook_interaction','site_chat'));

CREATE TABLE kff.facebook_connections (
 account_id uuid PRIMARY KEY,organization_id uuid NOT NULL,brand_id uuid NOT NULL,environment_id uuid NOT NULL,
 page_id text NOT NULL CHECK(page_id ~ '^[0-9]{1,128}$'),is_synthetic boolean NOT NULL,
 state text NOT NULL CHECK(state IN ('ACTIVE','PAUSED')),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 auto_reply boolean NOT NULL DEFAULT false,reply_window_hours integer NOT NULL CHECK(reply_window_hours BETWEEN 1 AND 24),
 policy_ref text NOT NULL CHECK(length(policy_ref) BETWEEN 5 AND 500),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(page_id,is_synthetic),UNIQUE(account_id,organization_id,brand_id),
 FOREIGN KEY(account_id,organization_id,brand_id) REFERENCES kff.accounts(id,organization_id,brand_id),
 FOREIGN KEY(environment_id,account_id,organization_id,brand_id) REFERENCES kff.environments(id,account_id,organization_id,brand_id),
 FOREIGN KEY(created_by,brand_id) REFERENCES kff.memberships(user_id,brand_id)
);
ALTER TABLE kff.facebook_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY scoped_access ON kff.facebook_connections TO kff_app USING(organization_id=nullif(current_setting('kff.organization_id',true),'')::uuid AND brand_id=nullif(current_setting('kff.brand_id',true),'')::uuid) WITH CHECK(organization_id=nullif(current_setting('kff.organization_id',true),'')::uuid AND brand_id=nullif(current_setting('kff.brand_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON kff.facebook_connections TO kff_app;

ALTER TABLE kff.customers ADD COLUMN lead_status text NOT NULL DEFAULT 'NEW' CHECK(lead_status IN ('NEW','ENGAGED','QUALIFIED','WHATSAPP_REFERRED','HANDOFF_COMPLETE','IGNORED','BLOCKED'));
ALTER TABLE kff.customers ADD COLUMN tags text[] NOT NULL DEFAULT '{}' CHECK(cardinality(tags)<=20);
ALTER TABLE kff.customers ADD COLUMN intent_level text NOT NULL DEFAULT 'UNKNOWN' CHECK(intent_level IN ('UNKNOWN','LOW','MEDIUM','HIGH'));
ALTER TABLE kff.customers ADD COLUMN intent_category text;
ALTER TABLE kff.customers ADD COLUMN intent_reason text;
ALTER TABLE kff.customers ADD COLUMN valid_inquiry boolean NOT NULL DEFAULT false;
ALTER TABLE kff.customers ADD COLUMN first_interaction_at timestamptz;
ALTER TABLE kff.customers ADD COLUMN last_interaction_at timestamptz;
ALTER TABLE kff.customers ADD COLUMN acquisition_source jsonb;
ALTER TABLE kff.conversations ALTER COLUMN channel_id DROP NOT NULL;
ALTER TABLE kff.conversations ADD COLUMN channel_kind text NOT NULL DEFAULT 'SITE_CHAT' CHECK(channel_kind IN ('SITE_CHAT','FACEBOOK_MESSENGER','FACEBOOK_COMMENT','FACEBOOK_INTERACTION'));
ALTER TABLE kff.conversations ADD COLUMN handling_mode text NOT NULL DEFAULT 'PAUSED' CHECK(handling_mode IN ('AI','HUMAN','PAUSED'));
ALTER TABLE kff.conversations ADD COLUMN control_version integer NOT NULL DEFAULT 1 CHECK(control_version>0);
ALTER TABLE kff.conversations ADD COLUMN last_inbound_sequence integer NOT NULL DEFAULT 0;
ALTER TABLE kff.conversations ADD COLUMN last_outbound_at timestamptz;
ALTER TABLE kff.conversations ADD CONSTRAINT conversation_channel CHECK((channel_kind='SITE_CHAT' AND channel_id IS NOT NULL) OR (channel_kind<>'SITE_CHAT' AND channel_id IS NULL));
ALTER TABLE kff.conversations ADD UNIQUE(id,account_id,organization_id,brand_id);
ALTER TABLE kff.messages ALTER COLUMN contact_permission_id DROP NOT NULL;
ALTER TABLE kff.messages ADD COLUMN message_kind text NOT NULL DEFAULT 'MESSAGE' CHECK(message_kind IN ('MESSAGE','COMMENT','INTERACTION','ECHO'));
ALTER TABLE kff.messages ADD COLUMN source jsonb;
ALTER TABLE kff.messages DROP CONSTRAINT messages_direction_check;
ALTER TABLE kff.messages ADD CHECK(direction IN ('INBOUND','EXTERNAL_OUTBOUND'));
ALTER TABLE kff.customer_events DROP CONSTRAINT customer_events_event_type_check;
ALTER TABLE kff.customer_events ADD CHECK(event_type IN ('INQUIRY','PROFILE_UPDATED','NOTE','LEAD_UPDATED','HANDLING_CHANGED','AI_DECISION','REFERRAL'));
CREATE INDEX facebook_customer_source ON kff.customers(brand_id,first_interaction_at,id) WHERE acquisition_source IS NOT NULL;
CREATE INDEX facebook_message_time ON kff.messages(brand_id,received_at,conversation_id) WHERE source IS NOT NULL;

CREATE OR REPLACE FUNCTION kff.check_owned_message_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM kff.conversations v JOIN kff.customer_identities i ON i.id=v.identity_id
   JOIN kff.inbound_events e ON e.id=NEW.inbound_event_id
   WHERE v.id=NEW.conversation_id AND v.organization_id=NEW.organization_id AND v.brand_id=NEW.brand_id AND (
    (e.source_kind='site_chat' AND NEW.direction='INBOUND' AND split_part(e.source_key,'/',1)=v.channel_id::text AND split_part(e.source_key,'/',2)=i.remote_id
      AND EXISTS(SELECT 1 FROM kff.contact_permissions p WHERE p.id=NEW.contact_permission_id AND p.target_id=i.contact_target_id AND p.policy->>'source_ref'=e.id::text)) OR
    (e.source_kind='facebook' AND v.channel_kind<>'SITE_CHAT' AND split_part(e.source_key,'/',1)=v.account_id::text
      AND e.source_details->>'sender_id'=i.remote_id AND e.source_details->>'kind'=NEW.message_kind
      AND ((NEW.message_kind='ECHO' AND NEW.direction='EXTERNAL_OUTBOUND') OR (NEW.message_kind<>'ECHO' AND NEW.direction='INBOUND'))
      AND (NEW.contact_permission_id IS NULL OR EXISTS(SELECT 1 FROM kff.contact_permissions p WHERE p.id=NEW.contact_permission_id AND p.target_id=i.contact_target_id AND p.policy->>'source_ref'=e.id::text)))
   )
 ) THEN RAISE EXCEPTION 'MESSAGE_IDENTITY_MISMATCH'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION kff.protect_facebook_connection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.account_id,NEW.organization_id,NEW.brand_id,NEW.page_id,NEW.is_synthetic,NEW.created_by,NEW.created_at) IS DISTINCT FROM ROW(OLD.account_id,OLD.organization_id,OLD.brand_id,OLD.page_id,OLD.is_synthetic,OLD.created_by,OLD.created_at)
   OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'FACEBOOK_CONNECTION_VERSION_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER facebook_connection_version BEFORE UPDATE ON kff.facebook_connections FOR EACH ROW EXECUTE FUNCTION kff.protect_facebook_connection();
CREATE FUNCTION kff.check_facebook_connection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM kff.accounts a WHERE a.id=NEW.account_id AND a.platform='facebook' AND a.account_type='page' AND a.external_id=NEW.page_id AND a.is_synthetic=NEW.is_synthetic) THEN RAISE EXCEPTION 'FACEBOOK_ACCOUNT_MISMATCH'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER facebook_connection_identity BEFORE INSERT ON kff.facebook_connections FOR EACH ROW EXECUTE FUNCTION kff.check_facebook_connection();
