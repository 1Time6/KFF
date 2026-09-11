CREATE TABLE kff.cost_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL,
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), minor_unit_exponent integer NOT NULL CHECK(minor_unit_exponent BETWEEN 0 AND 6),
  precision_source text NOT NULL, limit_minor bigint NOT NULL CHECK(limit_minor>=0), version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id), UNIQUE(brand_id,currency),
  FOREIGN KEY(brand_id,organization_id) REFERENCES kff.brands(id,organization_id)
);
CREATE TABLE kff.cost_reservations (
  action_id uuid PRIMARY KEY, organization_id uuid NOT NULL, brand_id uuid NOT NULL, permit_id uuid,
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), reserved_minor bigint NOT NULL CHECK(reserved_minor>=0), actual_cost_minor bigint,
  state text NOT NULL DEFAULT 'RESERVED' CHECK(state IN ('RESERVED','PENDING_RECONCILIATION','SETTLED','RELEASED')),
  cost_basis text NOT NULL, evidence_ref text, version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(action_id,organization_id,brand_id),
  FOREIGN KEY(action_id,organization_id,brand_id) REFERENCES kff.actions(id,organization_id,brand_id),
  FOREIGN KEY(permit_id,organization_id,brand_id) REFERENCES kff.pilot_permits(id,organization_id,brand_id),
  CHECK((state IN ('RESERVED','PENDING_RECONCILIATION') AND actual_cost_minor IS NULL) OR (state='SETTLED' AND actual_cost_minor IS NOT NULL AND actual_cost_minor>=0) OR (state='RELEASED' AND actual_cost_minor IS NOT NULL AND actual_cost_minor=0))
);
CREATE TABLE kff.cost_entries (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, brand_id uuid NOT NULL, action_id uuid,
  currency text NOT NULL, event_type text NOT NULL CHECK(event_type IN ('LIMIT_SET','RESERVED','PENDING_RECONCILIATION','SETTLED','RELEASED','ADJUSTED')),
  actor_id uuid NOT NULL, request_hash text NOT NULL, details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(brand_id,organization_id) REFERENCES kff.brands(id,organization_id),
  FOREIGN KEY(action_id,organization_id,brand_id) REFERENCES kff.cost_reservations(action_id,organization_id,brand_id)
);
CREATE INDEX cost_reservations_currency ON kff.cost_reservations(brand_id,currency,state);
CREATE INDEX cost_entries_action ON kff.cost_entries(action_id,created_at DESC);
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['cost_budgets','cost_reservations','cost_entries'] LOOP
    EXECUTE format('ALTER TABLE kff.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY scoped_access ON kff.%I TO kff_app USING (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid) WITH CHECK (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid)',tab);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON kff.%I TO kff_app',tab);
  END LOOP;
END $$;
REVOKE UPDATE ON kff.cost_entries FROM kff_app;
CREATE FUNCTION kff.protect_cost_entry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_COST_EVENT'; END $$;
CREATE TRIGGER cost_event_immutable BEFORE UPDATE OR DELETE ON kff.cost_entries FOR EACH ROW EXECUTE FUNCTION kff.protect_cost_entry();
CREATE FUNCTION kff.protect_cost_budget() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.id,NEW.organization_id,NEW.brand_id,NEW.currency,NEW.minor_unit_exponent,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.brand_id,OLD.currency,OLD.minor_unit_exponent,OLD.created_at) THEN RAISE EXCEPTION 'IMMUTABLE_COST_CURRENCY'; END IF;
  IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'COST_VERSION_REQUIRED'; END IF;
  NEW.updated_at=now(); RETURN NEW;
END $$;
CREATE TRIGGER cost_budget_version BEFORE UPDATE ON kff.cost_budgets FOR EACH ROW EXECUTE FUNCTION kff.protect_cost_budget();
CREATE FUNCTION kff.protect_cost_reservation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.action_id,NEW.organization_id,NEW.brand_id,NEW.permit_id,NEW.currency,NEW.reserved_minor,NEW.cost_basis,NEW.created_at) IS DISTINCT FROM ROW(OLD.action_id,OLD.organization_id,OLD.brand_id,OLD.permit_id,OLD.currency,OLD.reserved_minor,OLD.cost_basis,OLD.created_at) THEN RAISE EXCEPTION 'IMMUTABLE_COST_RESERVATION'; END IF;
  IF (OLD.state='SETTLED' AND NEW.state<>'SETTLED') OR (OLD.state='RELEASED' AND NEW.state NOT IN ('RELEASED','SETTLED')) OR (OLD.state='PENDING_RECONCILIATION' AND NEW.state='RESERVED') THEN RAISE EXCEPTION 'INVALID_COST_TRANSITION'; END IF;
  IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'COST_VERSION_REQUIRED'; END IF;
  NEW.updated_at=now(); RETURN NEW;
END $$;
CREATE TRIGGER cost_reservation_version BEFORE UPDATE ON kff.cost_reservations FOR EACH ROW EXECUTE FUNCTION kff.protect_cost_reservation();

-- Preserve historical estimates, without asserting that their actual bill is known or zero.
INSERT INTO kff.cost_reservations(action_id,organization_id,brand_id,permit_id,currency,reserved_minor,state,cost_basis)
SELECT r.action_id,r.organization_id,r.brand_id,r.permit_id,r.currency,r.cost_minor,'PENDING_RECONCILIATION',p.cost_basis FROM kff.pilot_reservations r JOIN kff.pilot_permits p ON p.id=r.permit_id;
INSERT INTO kff.cost_entries(id,organization_id,brand_id,action_id,currency,event_type,actor_id,request_hash,details)
SELECT gen_random_uuid(),r.organization_id,r.brand_id,r.action_id,r.currency,'PENDING_RECONCILIATION',p.approved_by,'migration:g2-cost-ledger',jsonb_build_object('source','legacy_pilot_reservation','reserved_minor',r.reserved_minor::text,'actual_cost_minor',NULL)
FROM kff.cost_reservations r JOIN kff.pilot_permits p ON p.id=r.permit_id;
