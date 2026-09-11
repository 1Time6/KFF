ALTER TABLE kff.actions ADD COLUMN adjudication_version integer NOT NULL DEFAULT 0 CHECK(adjudication_version>=0);
CREATE TABLE kff.action_adjudications (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, brand_id uuid NOT NULL, action_id uuid NOT NULL,
  reviewer_id uuid NOT NULL, request_hash text NOT NULL, snapshot_hash text NOT NULL,
  expected_version integer NOT NULL CHECK(expected_version>=0), result_version integer NOT NULL CHECK(result_version=expected_version+1),
  previous_state text NOT NULL CHECK(previous_state IN ('UNKNOWN_OUTCOME','NEEDS_HUMAN')),
  decision text NOT NULL CHECK(decision IN ('CONFIRMED_SUCCESS','CONFIRMED_FAILURE','INCONCLUSIVE')),
  result_state text NOT NULL CHECK(result_state IN ('VERIFIED_SUCCEEDED','VERIFIED_FAILED','NEEDS_HUMAN')),
  evidence jsonb NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(action_id,result_version),
  FOREIGN KEY(action_id,organization_id,brand_id) REFERENCES kff.actions(id,organization_id,brand_id),
  CHECK((decision='CONFIRMED_SUCCESS' AND result_state='VERIFIED_SUCCEEDED') OR (decision='CONFIRMED_FAILURE' AND result_state='VERIFIED_FAILED') OR (decision='INCONCLUSIVE' AND result_state='NEEDS_HUMAN'))
);
ALTER TABLE kff.action_adjudications ENABLE ROW LEVEL SECURITY;
CREATE POLICY scoped_access ON kff.action_adjudications TO kff_app USING(organization_id=nullif(current_setting('kff.organization_id',true),'')::uuid AND brand_id=nullif(current_setting('kff.brand_id',true),'')::uuid) WITH CHECK(organization_id=nullif(current_setting('kff.organization_id',true),'')::uuid AND brand_id=nullif(current_setting('kff.brand_id',true),'')::uuid);
GRANT SELECT,INSERT ON kff.action_adjudications TO kff_app;
CREATE FUNCTION kff.protect_adjudication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_ADJUDICATION'; END $$;
CREATE TRIGGER adjudication_immutable BEFORE UPDATE OR DELETE ON kff.action_adjudications FOR EACH ROW EXECUTE FUNCTION kff.protect_adjudication();

CREATE OR REPLACE FUNCTION kff.protect_action_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.adjudication_version<>OLD.adjudication_version THEN
    IF NEW.adjudication_version<>OLD.adjudication_version+1 OR NOT EXISTS(SELECT 1 FROM kff.action_adjudications d WHERE d.action_id=OLD.id AND d.organization_id=OLD.organization_id AND d.brand_id=OLD.brand_id AND d.expected_version=OLD.adjudication_version AND d.result_version=NEW.adjudication_version AND d.previous_state=OLD.state AND d.result_state=NEW.state) THEN RAISE EXCEPTION 'ADJUDICATION_EVENT_REQUIRED'; END IF;
    NEW.updated_at=now(); RETURN NEW;
  END IF;
  IF NEW.state=OLD.state THEN RETURN NEW; END IF;
  IF NOT ((OLD.state='QUEUED' AND NEW.state IN ('PREPARING','CANCELED','BLOCKED')) OR
    (OLD.state='PREPARING' AND NEW.state IN ('SUBMITTING','VERIFIED_SUCCEEDED','VERIFIED_FAILED','CANCELED','BLOCKED','NEEDS_HUMAN')) OR
    (OLD.state='SUBMITTING' AND NEW.state IN ('SUBMITTED','VERIFIED_SUCCEEDED','VERIFIED_FAILED','UNKNOWN_OUTCOME')) OR
    (OLD.state='SUBMITTED' AND NEW.state IN ('VERIFIED_SUCCEEDED','VERIFIED_FAILED','UNKNOWN_OUTCOME')) OR
    (OLD.state='UNKNOWN_OUTCOME' AND NEW.state IN ('VERIFIED_SUCCEEDED','VERIFIED_FAILED','NEEDS_HUMAN'))) THEN RAISE EXCEPTION 'INVALID_ACTION_TRANSITION'; END IF;
  NEW.updated_at=now(); RETURN NEW;
END $$;
CREATE FUNCTION kff.require_adjudication_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM kff.actions a WHERE a.id=NEW.action_id AND a.adjudication_version>=NEW.result_version) THEN RAISE EXCEPTION 'ADJUDICATION_PROJECTION_REQUIRED'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER adjudication_projected AFTER INSERT ON kff.action_adjudications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kff.require_adjudication_projection();
