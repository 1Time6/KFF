-- Reception preparation is another kind of job in the original durable queue.
ALTER TABLE kff.facebook_connections ADD COLUMN reception_policy jsonb NOT NULL DEFAULT '{}';
ALTER TABLE kff.jobs ALTER COLUMN action_id DROP NOT NULL;
ALTER TABLE kff.jobs ADD COLUMN kind text NOT NULL DEFAULT 'EXECUTION' CHECK(kind IN ('EXECUTION','RECEPTION'));
ALTER TABLE kff.jobs ADD COLUMN conversation_id uuid;
ALTER TABLE kff.jobs ADD COLUMN message_id uuid;
ALTER TABLE kff.jobs ADD COLUMN job_key text;
ALTER TABLE kff.jobs ADD COLUMN payload jsonb;
ALTER TABLE kff.jobs ADD COLUMN result jsonb;
ALTER TABLE kff.jobs ADD COLUMN error_code text;
ALTER TABLE kff.jobs ADD COLUMN lease_token bigint NOT NULL DEFAULT 0 CHECK(lease_token>=0);
ALTER TABLE kff.jobs ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE kff.jobs ADD UNIQUE(brand_id,job_key);
ALTER TABLE kff.jobs ADD FOREIGN KEY(conversation_id,organization_id,brand_id) REFERENCES kff.conversations(id,organization_id,brand_id);
ALTER TABLE kff.jobs ADD FOREIGN KEY(message_id,conversation_id,organization_id,brand_id) REFERENCES kff.messages(id,conversation_id,organization_id,brand_id);
ALTER TABLE kff.jobs ADD CHECK((kind='EXECUTION' AND action_id IS NOT NULL AND job_key IS NULL AND payload IS NULL) OR (kind='RECEPTION' AND action_id IS NULL AND conversation_id IS NOT NULL AND message_id IS NOT NULL AND job_key IS NOT NULL AND payload IS NOT NULL));
CREATE INDEX reception_jobs_ready ON kff.jobs(available_at,created_at) WHERE kind='RECEPTION' AND state IN ('READY','LEASED');
CREATE INDEX reception_jobs_conversation ON kff.jobs(conversation_id,created_at DESC) WHERE kind='RECEPTION';
CREATE FUNCTION kff.protect_reception_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.kind<>OLD.kind OR (OLD.kind='RECEPTION' AND ROW(NEW.id,NEW.organization_id,NEW.brand_id,NEW.conversation_id,NEW.message_id,NEW.job_key,NEW.payload,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.brand_id,OLD.conversation_id,OLD.message_id,OLD.job_key,OLD.payload,OLD.created_at)) THEN RAISE EXCEPTION 'IMMUTABLE_RECEPTION_JOB'; END IF;
 IF NEW.lease_token<OLD.lease_token OR (OLD.kind='RECEPTION' AND OLD.state IN ('DONE','DEAD') AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'RECEPTION_JOB_TERMINAL'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reception_job_version BEFORE UPDATE ON kff.jobs FOR EACH ROW EXECUTE FUNCTION kff.protect_reception_job();
CREATE FUNCTION kff.protect_lead_extensions() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='customers' THEN
  IF NEW.acquisition_source IS DISTINCT FROM OLD.acquisition_source OR (OLD.first_interaction_at IS NOT NULL AND NEW.first_interaction_at>OLD.first_interaction_at) OR (OLD.last_interaction_at IS NOT NULL AND NEW.last_interaction_at<OLD.last_interaction_at) THEN RAISE EXCEPTION 'IMMUTABLE_LEAD_ORIGIN'; END IF;
 ELSE
  IF NEW.channel_kind<>OLD.channel_kind OR NEW.control_version<OLD.control_version OR (NEW.handling_mode<>OLD.handling_mode AND NEW.control_version<>OLD.control_version+1) OR NEW.last_answered_sequence<OLD.last_answered_sequence THEN RAISE EXCEPTION 'CONVERSATION_CONTROL_VERSION_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER lead_customer_origin BEFORE UPDATE ON kff.customers FOR EACH ROW EXECUTE FUNCTION kff.protect_lead_extensions();
CREATE TRIGGER lead_conversation_control BEFORE UPDATE ON kff.conversations FOR EACH ROW EXECUTE FUNCTION kff.protect_lead_extensions();
