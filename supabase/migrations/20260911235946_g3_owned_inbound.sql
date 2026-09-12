-- Extend the existing durable event envelope; Agent events retain their required references.
-- Scoped staff directory for assigning an owner; identities and roles only, never login secrets.
ALTER TABLE kff.memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY brand_staff_directory ON kff.memberships TO kff_app USING(organization_id=nullif(current_setting('kff.organization_id',true),'')::uuid AND brand_id=nullif(current_setting('kff.brand_id',true),'')::uuid);
GRANT SELECT ON kff.memberships TO kff_app;
ALTER TABLE kff.inbound_events ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE kff.inbound_events ALTER COLUMN command_id DROP NOT NULL;
ALTER TABLE kff.inbound_events ADD COLUMN source_kind text NOT NULL DEFAULT 'agent' CHECK(source_kind IN ('agent','site_chat'));
ALTER TABLE kff.inbound_events ADD COLUMN source_key text;
ALTER TABLE kff.inbound_events ADD CONSTRAINT inbound_source_contract CHECK(
  (source_kind='agent' AND agent_id IS NOT NULL AND command_id IS NOT NULL AND source_key IS NULL) OR
  (source_kind='site_chat' AND agent_id IS NULL AND command_id IS NULL AND source_key IS NOT NULL AND length(source_key) BETWEEN 1 AND 300));
ALTER TABLE kff.inbound_events ADD UNIQUE(id,organization_id,brand_id);
CREATE UNIQUE INDEX inbound_source_dedup ON kff.inbound_events(brand_id,source_kind,source_key) WHERE source_key IS NOT NULL;

CREATE TABLE kff.site_channels (
  id uuid PRIMARY KEY,organization_id uuid NOT NULL,brand_id uuid NOT NULL,account_id uuid NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),is_synthetic boolean NOT NULL,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','PAUSED')),version integer NOT NULL DEFAULT 1 CHECK(version>0),
  session_hours integer NOT NULL CHECK(session_hours BETWEEN 1 AND 720),reply_window_hours integer NOT NULL CHECK(reply_window_hours BETWEEN 1 AND 168),
  sessions_per_minute integer NOT NULL CHECK(sessions_per_minute BETWEEN 1 AND 1000),messages_per_minute integer NOT NULL CHECK(messages_per_minute BETWEEN 1 AND 10000),
  session_bucket_at timestamptz NOT NULL DEFAULT now(),session_bucket_count integer NOT NULL DEFAULT 0 CHECK(session_bucket_count>=0),
  message_bucket_at timestamptz NOT NULL DEFAULT now(),message_bucket_count integer NOT NULL DEFAULT 0 CHECK(message_bucket_count>=0),
  request_id uuid NOT NULL,request_hash text NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id),UNIQUE(id,account_id,organization_id,brand_id),UNIQUE(account_id),UNIQUE(brand_id,request_id),
  FOREIGN KEY(account_id,organization_id,brand_id) REFERENCES kff.accounts(id,organization_id,brand_id),
  FOREIGN KEY(created_by,brand_id) REFERENCES kff.memberships(user_id,brand_id)
);
CREATE TABLE kff.visitor_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,channel_id uuid NOT NULL,
  visitor_id uuid NOT NULL,token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,revoked_at timestamptz,
  message_bucket_at timestamptz NOT NULL DEFAULT now(),message_bucket_count integer NOT NULL DEFAULT 0 CHECK(message_bucket_count>=0),
  UNIQUE(id,organization_id,brand_id),UNIQUE(channel_id,visitor_id),
  FOREIGN KEY(channel_id,organization_id,brand_id) REFERENCES kff.site_channels(id,organization_id,brand_id),CHECK(expires_at>created_at)
);
CREATE TABLE kff.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,
  display_name text CHECK(length(display_name) BETWEEN 1 AND 80),owner_user_id uuid,
  stage text NOT NULL DEFAULT 'NEW_INQUIRY' CHECK(stage IN ('NEW_INQUIRY','QUALIFYING','FOLLOWING_UP','IN_PROGRESS','QUALIFIED_INQUIRY','WON','DELIVERING','DELIVERED','LOST','OPTED_OUT')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),first_inquiry_event_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id),FOREIGN KEY(first_inquiry_event_id,organization_id,brand_id) REFERENCES kff.inbound_events(id,organization_id,brand_id),
  FOREIGN KEY(owner_user_id,brand_id) REFERENCES kff.memberships(user_id,brand_id)
);
ALTER TABLE kff.contact_targets ADD UNIQUE(id,account_id,channel,remote_id,organization_id,brand_id);
CREATE TABLE kff.customer_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,customer_id uuid NOT NULL,
  account_id uuid NOT NULL,channel text NOT NULL,remote_id text NOT NULL,contact_target_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id),UNIQUE(id,customer_id,account_id,organization_id,brand_id),UNIQUE(brand_id,account_id,channel,remote_id),
  FOREIGN KEY(customer_id,organization_id,brand_id) REFERENCES kff.customers(id,organization_id,brand_id),
  FOREIGN KEY(contact_target_id,account_id,channel,remote_id,organization_id,brand_id) REFERENCES kff.contact_targets(id,account_id,channel,remote_id,organization_id,brand_id)
);
CREATE TABLE kff.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,
  customer_id uuid NOT NULL,identity_id uuid NOT NULL UNIQUE,account_id uuid NOT NULL,channel_id uuid NOT NULL,
  last_sequence integer NOT NULL DEFAULT 0 CHECK(last_sequence>=0),last_message_at timestamptz,reply_window_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,organization_id,brand_id),UNIQUE(id,customer_id,organization_id,brand_id),
  FOREIGN KEY(identity_id,customer_id,account_id,organization_id,brand_id) REFERENCES kff.customer_identities(id,customer_id,account_id,organization_id,brand_id),
  FOREIGN KEY(channel_id,account_id,organization_id,brand_id) REFERENCES kff.site_channels(id,account_id,organization_id,brand_id)
);
CREATE TABLE kff.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,conversation_id uuid NOT NULL,
  inbound_event_id uuid NOT NULL UNIQUE,sequence integer NOT NULL CHECK(sequence>0),direction text NOT NULL CHECK(direction='INBOUND'),
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 5000),client_display_name text CHECK(length(client_display_name) BETWEEN 1 AND 80),received_at timestamptz NOT NULL,client_sent_at timestamptz,
  contact_permission_id uuid NOT NULL,UNIQUE(id,organization_id,brand_id),UNIQUE(conversation_id,sequence),
  FOREIGN KEY(conversation_id,organization_id,brand_id) REFERENCES kff.conversations(id,organization_id,brand_id),
  FOREIGN KEY(inbound_event_id,organization_id,brand_id) REFERENCES kff.inbound_events(id,organization_id,brand_id),
  FOREIGN KEY(contact_permission_id,organization_id,brand_id) REFERENCES kff.contact_permissions(id,organization_id,brand_id)
);
CREATE TABLE kff.customer_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,customer_id uuid NOT NULL,
  event_type text NOT NULL CHECK(event_type IN ('INQUIRY','PROFILE_UPDATED','NOTE')),actor_id uuid NOT NULL,details jsonb NOT NULL,
  request_id uuid NOT NULL,request_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(brand_id,request_id),FOREIGN KEY(customer_id,organization_id,brand_id) REFERENCES kff.customers(id,organization_id,brand_id)
);
CREATE INDEX conversations_recent ON kff.conversations(brand_id,last_message_at DESC,id);
CREATE INDEX customers_recent ON kff.customers(brand_id,updated_at DESC,id);
CREATE INDEX customer_events_timeline ON kff.customer_events(customer_id,created_at,id);
CREATE INDEX visitor_session_expiry ON kff.visitor_sessions(expires_at) WHERE revoked_at IS NULL;
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['site_channels','visitor_sessions','customers','customer_identities','conversations','messages','customer_events'] LOOP
    EXECUTE format('ALTER TABLE kff.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY scoped_access ON kff.%I TO kff_app USING (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid) WITH CHECK (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid)',tab);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON kff.%I TO kff_app',tab);
  END LOOP;
END $$;
REVOKE UPDATE ON kff.customer_identities,kff.messages,kff.customer_events FROM kff_app;
CREATE FUNCTION kff.protect_owned_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'IMMUTABLE_OWNED_RECORD';
END $$;
CREATE TRIGGER immutable_owned_message BEFORE UPDATE ON kff.messages FOR EACH ROW EXECUTE FUNCTION kff.protect_owned_record();
CREATE TRIGGER immutable_owned_identity BEFORE UPDATE ON kff.customer_identities FOR EACH ROW EXECUTE FUNCTION kff.protect_owned_record();
CREATE TRIGGER immutable_customer_event BEFORE UPDATE ON kff.customer_events FOR EACH ROW EXECUTE FUNCTION kff.protect_owned_record();
CREATE FUNCTION kff.protect_owned_channel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.id,NEW.organization_id,NEW.brand_id,NEW.account_id,NEW.name,NEW.is_synthetic,NEW.session_hours,NEW.reply_window_hours,NEW.sessions_per_minute,NEW.messages_per_minute,NEW.request_id,NEW.request_hash,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.brand_id,OLD.account_id,OLD.name,OLD.is_synthetic,OLD.session_hours,OLD.reply_window_hours,OLD.sessions_per_minute,OLD.messages_per_minute,OLD.request_id,OLD.request_hash,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'IMMUTABLE_CHANNEL_POLICY'; END IF;
  IF NEW.version<OLD.version OR (NEW.state<>OLD.state AND NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'CHANNEL_VERSION_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER owned_channel_policy BEFORE UPDATE ON kff.site_channels FOR EACH ROW EXECUTE FUNCTION kff.protect_owned_channel();
CREATE FUNCTION kff.protect_owned_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.id,NEW.organization_id,NEW.brand_id,NEW.channel_id,NEW.visitor_id,NEW.token_hash,NEW.created_at,NEW.expires_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.brand_id,OLD.channel_id,OLD.visitor_id,OLD.token_hash,OLD.created_at,OLD.expires_at)
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN RAISE EXCEPTION 'IMMUTABLE_VISITOR_SESSION'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER owned_session_identity BEFORE UPDATE ON kff.visitor_sessions FOR EACH ROW EXECUTE FUNCTION kff.protect_owned_session();
CREATE FUNCTION kff.protect_owned_customer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.id,NEW.organization_id,NEW.brand_id,NEW.first_inquiry_event_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.brand_id,OLD.first_inquiry_event_id,OLD.created_at) THEN RAISE EXCEPTION 'IMMUTABLE_CUSTOMER_ORIGIN'; END IF;
  IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'CUSTOMER_VERSION_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER owned_customer_version BEFORE UPDATE ON kff.customers FOR EACH ROW EXECUTE FUNCTION kff.protect_owned_customer();
CREATE FUNCTION kff.protect_owned_conversation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.id,NEW.organization_id,NEW.brand_id,NEW.customer_id,NEW.identity_id,NEW.account_id,NEW.channel_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.brand_id,OLD.customer_id,OLD.identity_id,OLD.account_id,OLD.channel_id,OLD.created_at) THEN RAISE EXCEPTION 'IMMUTABLE_CONVERSATION_IDENTITY'; END IF;
  IF NEW.last_sequence<OLD.last_sequence OR NEW.last_sequence>OLD.last_sequence+1 THEN RAISE EXCEPTION 'CONVERSATION_SEQUENCE_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER owned_conversation_identity BEFORE UPDATE ON kff.conversations FOR EACH ROW EXECUTE FUNCTION kff.protect_owned_conversation();
CREATE FUNCTION kff.check_owned_message_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kff.conversations v JOIN kff.customer_identities i ON i.id=v.identity_id
    JOIN kff.contact_permissions p ON p.id=NEW.contact_permission_id AND p.target_id=i.contact_target_id
    JOIN kff.inbound_events e ON e.id=NEW.inbound_event_id AND e.source_kind='site_chat'
    WHERE v.id=NEW.conversation_id AND v.organization_id=NEW.organization_id AND v.brand_id=NEW.brand_id
      AND split_part(e.source_key,'/',1)=v.channel_id::text AND split_part(e.source_key,'/',2)=i.remote_id
      AND p.policy->>'source_ref'=e.id::text
  ) THEN RAISE EXCEPTION 'MESSAGE_IDENTITY_MISMATCH'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER owned_message_scope BEFORE INSERT ON kff.messages FOR EACH ROW EXECUTE FUNCTION kff.check_owned_message_scope();
