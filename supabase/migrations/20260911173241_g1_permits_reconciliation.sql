ALTER TABLE kff.agent_commands ADD COLUMN quiesced_at timestamptz;
CREATE TABLE kff.pilot_permits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL,
  task_id uuid NOT NULL, account_id uuid NOT NULL, capability_id uuid NOT NULL,
  snapshot_hash text NOT NULL, content_hash text NOT NULL, target_id text NOT NULL,
  capability_revision integer NOT NULL, adapter_version text NOT NULL, access_path text NOT NULL CHECK(access_path='api'),
  approved_by uuid NOT NULL, starts_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  max_actions integer NOT NULL CHECK(max_actions BETWEEN 1 AND 10), reserved_actions integer NOT NULL DEFAULT 0 CHECK(reserved_actions>=0 AND reserved_actions<=max_actions),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), max_cost_minor bigint NOT NULL CHECK(max_cost_minor>=0),
  per_action_max_minor bigint NOT NULL CHECK(per_action_max_minor>=0), reserved_cost_minor bigint NOT NULL DEFAULT 0 CHECK(reserved_cost_minor>=0 AND reserved_cost_minor<=max_cost_minor),
  cost_basis text NOT NULL, authorization_evidence text NOT NULL, platform_conditions text NOT NULL, expected_evidence text NOT NULL,
  stop_rule text NOT NULL CHECK(stop_rule='stop_on_first_unknown_or_failure'), revoked_at timestamptz, halted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(expires_at>starts_at AND expires_at<=starts_at+interval '24 hours'),
  UNIQUE(id,organization_id,brand_id),
  FOREIGN KEY(task_id,organization_id,brand_id) REFERENCES kff.tasks(id,organization_id,brand_id),
  FOREIGN KEY(capability_id,account_id,organization_id,brand_id) REFERENCES kff.capabilities(id,account_id,organization_id,brand_id)
);
CREATE TABLE kff.pilot_reservations (
  action_id uuid PRIMARY KEY, organization_id uuid NOT NULL, brand_id uuid NOT NULL, permit_id uuid NOT NULL,
  cost_minor bigint NOT NULL CHECK(cost_minor>=0), currency text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(action_id,organization_id,brand_id) REFERENCES kff.actions(id,organization_id,brand_id),
  FOREIGN KEY(permit_id,organization_id,brand_id) REFERENCES kff.pilot_permits(id,organization_id,brand_id)
);
CREATE INDEX permits_task ON kff.pilot_permits(task_id,created_at DESC);
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['pilot_permits','pilot_reservations'] LOOP
    EXECUTE format('ALTER TABLE kff.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY scoped_access ON kff.%I TO kff_app USING (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid) WITH CHECK (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid)',tab);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON kff.%I TO kff_app',tab);
  END LOOP;
END $$;
REVOKE UPDATE ON kff.pilot_reservations FROM kff_app;
CREATE FUNCTION kff.protect_pilot_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (to_jsonb(NEW)-ARRAY['reserved_actions','reserved_cost_minor','revoked_at','halted_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['reserved_actions','reserved_cost_minor','revoked_at','halted_at']) THEN RAISE EXCEPTION 'IMMUTABLE_PILOT_SCOPE'; END IF;
  IF NEW.reserved_actions<OLD.reserved_actions OR NEW.reserved_cost_minor<OLD.reserved_cost_minor OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL) OR (OLD.halted_at IS NOT NULL AND NEW.halted_at IS NULL) THEN RAISE EXCEPTION 'PILOT_RESERVATION_CANNOT_RESET'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_pilot BEFORE UPDATE ON kff.pilot_permits FOR EACH ROW EXECUTE FUNCTION kff.protect_pilot_scope();
