CREATE TABLE kff.schedule_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,request_id uuid NOT NULL,
  request_hash text NOT NULL,definition jsonb NOT NULL,definition_hash text NOT NULL,evaluated_at timestamptz NOT NULL,
  created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
  UNIQUE(id,organization_id,brand_id),UNIQUE(organization_id,brand_id,request_id),
  FOREIGN KEY(brand_id,organization_id) REFERENCES kff.brands(id,organization_id)
);
CREATE TABLE kff.schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,title text NOT NULL,
  current_version_id uuid,state text NOT NULL DEFAULT 'PAUSED' CHECK(state IN ('ACTIVE','PAUSED','STOPPED','COMPLETED')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),next_slot_index integer NOT NULL DEFAULT 0 CHECK(next_slot_index BETWEEN 0 AND 732),
  next_due_at timestamptz,last_release_at timestamptz,pause_reason text,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id),FOREIGN KEY(brand_id,organization_id) REFERENCES kff.brands(id,organization_id)
);
CREATE TABLE kff.schedule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,schedule_id uuid NOT NULL,preview_id uuid NOT NULL,
  request_id uuid NOT NULL,request_hash text NOT NULL,title text NOT NULL,version_number integer NOT NULL CHECK(version_number>0),
  definition jsonb NOT NULL,definition_hash text NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id),UNIQUE(id,schedule_id,organization_id,brand_id),UNIQUE(schedule_id,version_number),UNIQUE(preview_id),UNIQUE(organization_id,brand_id,request_id),
  FOREIGN KEY(schedule_id,organization_id,brand_id) REFERENCES kff.schedules(id,organization_id,brand_id),
  FOREIGN KEY(preview_id,organization_id,brand_id) REFERENCES kff.schedule_previews(id,organization_id,brand_id)
);
ALTER TABLE kff.schedules ADD FOREIGN KEY(current_version_id,id,organization_id,brand_id) REFERENCES kff.schedule_versions(id,schedule_id,organization_id,brand_id);
CREATE TABLE kff.schedule_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,schedule_id uuid NOT NULL,version_id uuid NOT NULL,
  slot_index integer NOT NULL CHECK(slot_index BETWEEN 0 AND 731),slot_key text NOT NULL,slot jsonb NOT NULL,
  scheduled_at timestamptz,available_at timestamptz,state text NOT NULL CHECK(state IN ('READY_FOR_TASK','SKIPPED','CANCELED')),reason text NOT NULL,cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,organization_id,brand_id),UNIQUE(version_id,slot_index),UNIQUE(version_id,slot_key),
  FOREIGN KEY(version_id,schedule_id,organization_id,brand_id) REFERENCES kff.schedule_versions(id,schedule_id,organization_id,brand_id),
  CHECK(state<>'READY_FOR_TASK' OR (scheduled_at IS NOT NULL AND available_at>=scheduled_at))
);
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['schedule_previews','schedules','schedule_versions','schedule_occurrences'] LOOP
    EXECUTE format('ALTER TABLE kff.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY scoped_access ON kff.%I TO kff_app USING (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid) WITH CHECK (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid)',tab);
    EXECUTE format('GRANT SELECT,INSERT ON kff.%I TO kff_app',tab);
  END LOOP;
END $$;
GRANT UPDATE ON kff.schedules,kff.schedule_occurrences TO kff_app;
CREATE INDEX schedule_due ON kff.schedules(next_due_at,id) WHERE state='ACTIVE';
CREATE INDEX schedule_occurrence_history ON kff.schedule_occurrences(schedule_id,created_at,id);
CREATE FUNCTION kff.protect_schedule_definition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_SCHEDULE_DEFINITION'; END $$;
CREATE TRIGGER schedule_preview_immutable BEFORE UPDATE OR DELETE ON kff.schedule_previews FOR EACH ROW EXECUTE FUNCTION kff.protect_schedule_definition();
CREATE TRIGGER schedule_version_immutable BEFORE UPDATE OR DELETE ON kff.schedule_versions FOR EACH ROW EXECUTE FUNCTION kff.protect_schedule_definition();
CREATE FUNCTION kff.protect_schedule_occurrence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'state'-'cancellation_reason')=(to_jsonb(OLD)-'state'-'cancellation_reason') AND OLD.state='READY_FOR_TASK' AND NEW.state='CANCELED' AND length(NEW.cancellation_reason)>0 THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'IMMUTABLE_SCHEDULE_OCCURRENCE';
END $$;
CREATE TRIGGER schedule_occurrence_immutable BEFORE UPDATE OR DELETE ON kff.schedule_occurrences FOR EACH ROW EXECUTE FUNCTION kff.protect_schedule_occurrence();
