-- Message dispatch reuses Task -> Run -> Action -> Job -> Agent -> leases/guardian.
ALTER TABLE kff.organizations ADD COLUMN stop_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE kff.brands ADD COLUMN stop_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE kff.accounts ADD COLUMN stop_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE kff.agents ADD COLUMN stop_epoch integer NOT NULL DEFAULT 0;
CREATE FUNCTION kff.advance_stop_epoch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='agents' THEN
   IF NEW.status<>OLD.status AND (NEW.status IN ('DRAINING','REVOKED','QUARANTINED') OR OLD.status IN ('DRAINING','QUARANTINED')) THEN NEW.stop_epoch=OLD.stop_epoch+1; ELSE NEW.stop_epoch=OLD.stop_epoch; END IF;
 ELSE
   IF NEW.outbound_paused<>OLD.outbound_paused THEN NEW.stop_epoch=OLD.stop_epoch+1; ELSE NEW.stop_epoch=OLD.stop_epoch; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER org_stop_epoch BEFORE UPDATE ON kff.organizations FOR EACH ROW EXECUTE FUNCTION kff.advance_stop_epoch();
CREATE TRIGGER brand_stop_epoch BEFORE UPDATE ON kff.brands FOR EACH ROW EXECUTE FUNCTION kff.advance_stop_epoch();
CREATE TRIGGER account_stop_epoch BEFORE UPDATE ON kff.accounts FOR EACH ROW EXECUTE FUNCTION kff.advance_stop_epoch();
CREATE TRIGGER agent_stop_epoch BEFORE UPDATE ON kff.agents FOR EACH ROW EXECUTE FUNCTION kff.advance_stop_epoch();

ALTER TABLE kff.conversations ADD COLUMN last_answered_sequence integer NOT NULL DEFAULT 0 CHECK(last_answered_sequence>=0);
ALTER TABLE kff.tasks ADD COLUMN conversation_id uuid;
ALTER TABLE kff.tasks ADD FOREIGN KEY(conversation_id,account_id,organization_id,brand_id) REFERENCES kff.conversations(id,account_id,organization_id,brand_id);
CREATE INDEX message_task_conversation ON kff.tasks(conversation_id,created_at DESC) WHERE conversation_id IS NOT NULL;
ALTER TABLE kff.messages ADD COLUMN action_id uuid UNIQUE;
ALTER TABLE kff.messages ADD COLUMN actor_kind text NOT NULL DEFAULT 'CUSTOMER' CHECK(actor_kind IN ('CUSTOMER','AI','HUMAN','FACEBOOK'));
ALTER TABLE kff.messages ALTER COLUMN inbound_event_id DROP NOT NULL;
ALTER TABLE kff.messages DROP CONSTRAINT messages_direction_check;
ALTER TABLE kff.messages ADD CHECK(direction IN ('INBOUND','EXTERNAL_OUTBOUND','OUTBOUND'));
ALTER TABLE kff.messages ADD FOREIGN KEY(action_id,organization_id,brand_id) REFERENCES kff.actions(id,organization_id,brand_id);
ALTER TABLE kff.messages ADD CHECK((direction='OUTBOUND' AND action_id IS NOT NULL AND inbound_event_id IS NULL AND contact_permission_id IS NOT NULL) OR (direction<>'OUTBOUND' AND action_id IS NULL AND inbound_event_id IS NOT NULL));
ALTER TABLE kff.messages ADD UNIQUE(id,conversation_id,organization_id,brand_id);

CREATE TABLE kff.whatsapp_destinations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,account_id uuid,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),phone text NOT NULL CHECK(phone ~ '^[1-9][0-9]{6,14}$'),
 state text NOT NULL CHECK(state IN ('ACTIVE','PAUSED')),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 template text NOT NULL CHECK(length(template) BETWEEN 1 AND 1500 AND strpos(template,'{whatsapp_url}')>0),
 cooldown_hours integer NOT NULL CHECK(cooldown_hours BETWEEN 1 AND 720),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE NULLS NOT DISTINCT(brand_id,account_id),UNIQUE(id,organization_id,brand_id),
 FOREIGN KEY(brand_id,organization_id) REFERENCES kff.brands(id,organization_id),
 FOREIGN KEY(account_id,organization_id,brand_id) REFERENCES kff.accounts(id,organization_id,brand_id)
);
CREATE TABLE kff.whatsapp_referrals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,account_id uuid NOT NULL,
 customer_id uuid NOT NULL,conversation_id uuid NOT NULL,action_id uuid NOT NULL UNIQUE,message_id uuid,
 destination_id uuid NOT NULL,destination_snapshot jsonb NOT NULL,actor_kind text NOT NULL CHECK(actor_kind IN ('AI','HUMAN')),actor_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','UNKNOWN','FAILED','CANCELED','REFERRED','CONFIRMED','DECLINED')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),source jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),sent_at timestamptz,confirmed_at timestamptz,
 UNIQUE(id,organization_id,brand_id),
 FOREIGN KEY(conversation_id,account_id,organization_id,brand_id) REFERENCES kff.conversations(id,account_id,organization_id,brand_id),
 FOREIGN KEY(conversation_id,customer_id,organization_id,brand_id) REFERENCES kff.conversations(id,customer_id,organization_id,brand_id),
 FOREIGN KEY(action_id,organization_id,brand_id) REFERENCES kff.actions(id,organization_id,brand_id),
 FOREIGN KEY(message_id,conversation_id,organization_id,brand_id) REFERENCES kff.messages(id,conversation_id,organization_id,brand_id),
 FOREIGN KEY(destination_id,organization_id,brand_id) REFERENCES kff.whatsapp_destinations(id,organization_id,brand_id)
);
CREATE INDEX referral_conversation_recent ON kff.whatsapp_referrals(conversation_id,created_at DESC);
CREATE INDEX referral_metrics ON kff.whatsapp_referrals(brand_id,sent_at,account_id) WHERE sent_at IS NOT NULL;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['whatsapp_destinations','whatsapp_referrals'] LOOP
  EXECUTE format('ALTER TABLE kff.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY scoped_access ON kff.%I TO kff_app USING(organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid) WITH CHECK(organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid)',tab);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON kff.%I TO kff_app',tab);
 END LOOP;
END $$;
CREATE FUNCTION kff.protect_referral() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.organization_id,NEW.brand_id,NEW.account_id,NEW.customer_id,NEW.conversation_id,NEW.action_id,NEW.destination_id,NEW.destination_snapshot,NEW.actor_kind,NEW.actor_id,NEW.source,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.brand_id,OLD.account_id,OLD.customer_id,OLD.conversation_id,OLD.action_id,OLD.destination_id,OLD.destination_snapshot,OLD.actor_kind,OLD.actor_id,OLD.source,OLD.created_at)
  OR NEW.version<>OLD.version+1 OR (OLD.message_id IS NOT NULL AND NEW.message_id IS DISTINCT FROM OLD.message_id) THEN RAISE EXCEPTION 'REFERRAL_VERSION_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER referral_snapshot BEFORE UPDATE ON kff.whatsapp_referrals FOR EACH ROW EXECUTE FUNCTION kff.protect_referral();
CREATE FUNCTION kff.protect_destination() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.organization_id,NEW.brand_id,NEW.account_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.brand_id,OLD.account_id,OLD.created_at) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'DESTINATION_VERSION_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER destination_version BEFORE UPDATE ON kff.whatsapp_destinations FOR EACH ROW EXECUTE FUNCTION kff.protect_destination();
-- Delegate original inbound validation unchanged and add a narrowly scoped outbound branch.
ALTER FUNCTION kff.check_owned_message_scope() RENAME TO check_inbound_message_scope;
DROP TRIGGER owned_message_scope ON kff.messages;
CREATE TRIGGER owned_message_scope BEFORE INSERT ON kff.messages FOR EACH ROW WHEN(NEW.direction<>'OUTBOUND') EXECUTE FUNCTION kff.check_inbound_message_scope();
CREATE FUNCTION kff.check_outbound_message_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM kff.actions a JOIN kff.tasks t ON t.id=a.task_id JOIN kff.conversations v ON v.id=t.conversation_id
  WHERE a.id=NEW.action_id AND a.state='VERIFIED_SUCCEEDED' AND v.id=NEW.conversation_id AND t.organization_id=NEW.organization_id AND t.brand_id=NEW.brand_id
    AND t.snapshot->>'body'=NEW.body AND t.snapshot->'message'->'contact'->>'permission_id'=NEW.contact_permission_id::text
    AND t.snapshot->'message'->>'actor_kind'=NEW.actor_kind) THEN RAISE EXCEPTION 'OUTBOUND_MESSAGE_IDENTITY_MISMATCH'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER outbound_message_scope BEFORE INSERT ON kff.messages FOR EACH ROW WHEN(NEW.direction='OUTBOUND') EXECUTE FUNCTION kff.check_outbound_message_scope();
CREATE FUNCTION kff.check_message_task() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.conversation_id IS DISTINCT FROM (NEW.snapshot->'message'->>'conversation_id')::uuid THEN RAISE EXCEPTION 'MESSAGE_TASK_SCOPE_REQUIRED'; END IF;
 IF TG_OP='UPDATE' AND NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN RAISE EXCEPTION 'IMMUTABLE_TASK_SNAPSHOT'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER message_task_scope BEFORE INSERT OR UPDATE ON kff.tasks FOR EACH ROW EXECUTE FUNCTION kff.check_message_task();
