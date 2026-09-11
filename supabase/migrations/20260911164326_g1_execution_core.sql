-- Private application schema: never expose it through the Supabase Data API.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='kff_app') THEN CREATE ROLE kff_app NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;
GRANT kff_app TO CURRENT_USER;
GRANT USAGE ON SCHEMA kff TO kff_app;

CREATE TABLE kff.organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
CREATE TABLE kff.brands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES kff.organizations(id), name text NOT NULL, outbound_paused boolean NOT NULL DEFAULT false, UNIQUE(id,organization_id));
CREATE TABLE kff.local_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE, password_hash text NOT NULL, disabled boolean NOT NULL DEFAULT false);
CREATE TABLE kff.memberships (user_id uuid NOT NULL, organization_id uuid NOT NULL, brand_id uuid NOT NULL, role text NOT NULL CHECK(role IN ('admin','operator','viewer')), PRIMARY KEY(user_id,brand_id), FOREIGN KEY(brand_id,organization_id) REFERENCES kff.brands(id,organization_id));
CREATE TABLE kff.sessions (id_hash text PRIMARY KEY, user_id uuid NOT NULL, provider text NOT NULL CHECK(provider IN ('local','supabase')), expires_at timestamptz NOT NULL, revoked_at timestamptz);

CREATE TABLE kff.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL,
  display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 80), platform text NOT NULL, account_type text NOT NULL,
  external_id text NOT NULL CHECK(external_id ~ '^[0-9]{1,128}$'), credential_ref text, state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','ACTIVE','AUTH_EXPIRED','DISABLED')),
  is_synthetic boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id), UNIQUE(brand_id,platform,account_type,external_id,is_synthetic),
  FOREIGN KEY(brand_id,organization_id) REFERENCES kff.brands(id,organization_id)
);
CREATE TABLE kff.agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL, name text NOT NULL,
  token_hash text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'OFFLINE' CHECK(status IN ('PAIRED','ONLINE','OFFLINE','DRAINING','QUARANTINED','REVOKED')),
  protocol_version text NOT NULL DEFAULT 'kff.agent.v1', heartbeat_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id), FOREIGN KEY(brand_id,organization_id) REFERENCES kff.brands(id,organization_id)
);
CREATE TABLE kff.environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL, name text NOT NULL,
  account_id uuid NOT NULL, agent_id uuid NOT NULL, profile_key uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  state text NOT NULL DEFAULT 'IDLE' CHECK(state IN ('IDLE','BUSY','QUARANTINED','DISABLED')), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id), UNIQUE(id,account_id,organization_id,brand_id),
  FOREIGN KEY(account_id,organization_id,brand_id) REFERENCES kff.accounts(id,organization_id,brand_id),
  FOREIGN KEY(agent_id,organization_id,brand_id) REFERENCES kff.agents(id,organization_id,brand_id)
);
CREATE TABLE kff.capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL, account_id uuid NOT NULL,
  capability_key text NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK(revision>0), adapter_version text NOT NULL,
  evidence_state text NOT NULL CHECK(evidence_state IN ('UNASSESSED','FEASIBLE','IMPLEMENTED_TEST_ONLY','VERIFIED_REAL','BLOCKED','DEPRECATED')),
  mode text NOT NULL CHECK(mode IN ('DISABLED','TEST_ONLY','CONTROLLED_PILOT','PRODUCTION')), is_synthetic boolean NOT NULL,
  description text NOT NULL, last_verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,capability_key,revision), UNIQUE(id,organization_id,brand_id), UNIQUE(id,account_id,organization_id,brand_id),
  FOREIGN KEY(account_id,organization_id,brand_id) REFERENCES kff.accounts(id,organization_id,brand_id)
);
CREATE TABLE kff.content_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL, body text NOT NULL CHECK(length(body)<=5000),
  content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'), created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id), FOREIGN KEY(brand_id,organization_id) REFERENCES kff.brands(id,organization_id)
);
CREATE TABLE kff.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL, title text NOT NULL,
  account_id uuid NOT NULL, environment_id uuid NOT NULL, capability_id uuid NOT NULL, content_version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPROVED','REJECTED','QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELED','NEEDS_HUMAN')),
  snapshot jsonb NOT NULL, snapshot_hash text NOT NULL CHECK(snapshot_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL, request_hash text NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id), UNIQUE(organization_id,brand_id,idempotency_key),
  FOREIGN KEY(account_id,organization_id,brand_id) REFERENCES kff.accounts(id,organization_id,brand_id),
  FOREIGN KEY(environment_id,account_id,organization_id,brand_id) REFERENCES kff.environments(id,account_id,organization_id,brand_id),
  FOREIGN KEY(capability_id,account_id,organization_id,brand_id) REFERENCES kff.capabilities(id,account_id,organization_id,brand_id),
  FOREIGN KEY(content_version_id,organization_id,brand_id) REFERENCES kff.content_versions(id,organization_id,brand_id)
);
CREATE TABLE kff.approval_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL, task_id uuid NOT NULL,
  snapshot_hash text NOT NULL, decision text NOT NULL CHECK(decision IN ('APPROVED','REJECTED')), decided_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(task_id,organization_id,brand_id) REFERENCES kff.tasks(id,organization_id,brand_id)
);
CREATE TABLE kff.runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL, task_id uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELED','NEEDS_HUMAN')),
  stop_requested boolean NOT NULL DEFAULT false, stop_reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id), UNIQUE(id,task_id,organization_id,brand_id), FOREIGN KEY(task_id,organization_id,brand_id) REFERENCES kff.tasks(id,organization_id,brand_id)
);
CREATE TABLE kff.actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL, run_id uuid NOT NULL UNIQUE, task_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','PREPARING','SUBMITTING','SUBMITTED','VERIFIED_SUCCEEDED','VERIFIED_FAILED','UNKNOWN_OUTCOME','CANCELED','BLOCKED','NEEDS_HUMAN')),
  error_code text, receipt jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id), FOREIGN KEY(run_id,task_id,organization_id,brand_id) REFERENCES kff.runs(id,task_id,organization_id,brand_id)
);
CREATE TABLE kff.action_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL, action_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK(attempt_number>0), agent_id uuid NOT NULL, state text NOT NULL DEFAULT 'PREPARING',
  leases jsonb NOT NULL DEFAULT '[]', submitted_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(action_id,attempt_number), UNIQUE(id,organization_id,brand_id),
  FOREIGN KEY(action_id,organization_id,brand_id) REFERENCES kff.actions(id,organization_id,brand_id),
  FOREIGN KEY(agent_id,organization_id,brand_id) REFERENCES kff.agents(id,organization_id,brand_id)
);
CREATE TABLE kff.resource_leases (
  organization_id uuid NOT NULL, brand_id uuid NOT NULL, resource_type text NOT NULL CHECK(resource_type IN ('account','environment')), resource_id uuid NOT NULL,
  token bigint NOT NULL DEFAULT 0 CHECK(token>=0), holder_attempt_id uuid, expires_at timestamptz NOT NULL DEFAULT now(), quarantined boolean NOT NULL DEFAULT false,
  PRIMARY KEY(organization_id,resource_type,resource_id), FOREIGN KEY(brand_id,organization_id) REFERENCES kff.brands(id,organization_id),
  FOREIGN KEY(holder_attempt_id,organization_id,brand_id) REFERENCES kff.action_attempts(id,organization_id,brand_id)
);
CREATE TABLE kff.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL, action_id uuid NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'READY' CHECK(state IN ('READY','LEASED','DONE','DEAD')), attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(), leased_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(action_id,organization_id,brand_id) REFERENCES kff.actions(id,organization_id,brand_id)
);
CREATE TABLE kff.agent_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL, action_id uuid NOT NULL, attempt_id uuid NOT NULL UNIQUE,
  agent_id uuid NOT NULL, state text NOT NULL DEFAULT 'READY' CHECK(state IN ('READY','CLAIMED','DONE','EXPIRED')), expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), claimed_at timestamptz,
  UNIQUE(id,organization_id,brand_id), FOREIGN KEY(attempt_id,organization_id,brand_id) REFERENCES kff.action_attempts(id,organization_id,brand_id),
  FOREIGN KEY(action_id,organization_id,brand_id) REFERENCES kff.actions(id,organization_id,brand_id),
  FOREIGN KEY(agent_id,organization_id,brand_id) REFERENCES kff.agents(id,organization_id,brand_id)
);
CREATE TABLE kff.inbound_events (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, brand_id uuid NOT NULL, agent_id uuid NOT NULL, command_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), payload_hash text NOT NULL,
  UNIQUE(agent_id,id), FOREIGN KEY(command_id,organization_id,brand_id) REFERENCES kff.agent_commands(id,organization_id,brand_id)
);
CREATE TABLE kff.diagnostic_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL, action_id uuid NOT NULL,
  manifest jsonb NOT NULL, expires_at timestamptz NOT NULL DEFAULT (now()+interval '7 days'), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(action_id,organization_id,brand_id) REFERENCES kff.actions(id,organization_id,brand_id)
);
CREATE TABLE kff.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL, actor_id uuid NOT NULL,
  event_type text NOT NULL, object_id uuid NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(brand_id,organization_id) REFERENCES kff.brands(id,organization_id)
);

CREATE INDEX tasks_brand_created ON kff.tasks(brand_id,created_at DESC,id);
CREATE INDEX runs_brand_created ON kff.runs(brand_id,created_at DESC,id);
CREATE INDEX jobs_ready ON kff.jobs(state,available_at,created_at) WHERE state='READY';
CREATE INDEX leases_expiry ON kff.resource_leases(expires_at) WHERE holder_attempt_id IS NOT NULL;
CREATE INDEX commands_claim ON kff.agent_commands(agent_id,state,created_at);
CREATE INDEX commands_expiry ON kff.agent_commands(expires_at) WHERE state IN ('READY','CLAIMED');
CREATE INDEX diagnostic_action ON kff.diagnostic_bundles(action_id,created_at DESC);

-- All application object access must supply the server-validated scope.
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['accounts','agents','environments','capabilities','content_versions','tasks','approval_decisions','runs','actions','action_attempts','resource_leases','jobs','agent_commands','inbound_events','diagnostic_bundles','audit_events'] LOOP
    EXECUTE format('ALTER TABLE kff.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY scoped_access ON kff.%I TO kff_app USING (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid) WITH CHECK (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid)',tab);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON kff.%I TO kff_app',tab);
  END LOOP;
END $$;
ALTER TABLE kff.brands ENABLE ROW LEVEL SECURITY;
CREATE POLICY brand_scope ON kff.brands TO kff_app USING(id=nullif(current_setting('kff.brand_id',true),'')::uuid AND organization_id=nullif(current_setting('kff.organization_id',true),'')::uuid) WITH CHECK(id=nullif(current_setting('kff.brand_id',true),'')::uuid AND organization_id=nullif(current_setting('kff.organization_id',true),'')::uuid);
GRANT SELECT,UPDATE ON kff.brands TO kff_app;
REVOKE UPDATE ON kff.approval_decisions,kff.content_versions,kff.inbound_events,kff.audit_events FROM kff_app;

CREATE FUNCTION kff.protect_task_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.snapshot,NEW.snapshot_hash,NEW.account_id,NEW.environment_id,NEW.capability_id,NEW.content_version_id,NEW.organization_id,NEW.brand_id,NEW.idempotency_key,NEW.request_hash) IS DISTINCT FROM ROW(OLD.snapshot,OLD.snapshot_hash,OLD.account_id,OLD.environment_id,OLD.capability_id,OLD.content_version_id,OLD.organization_id,OLD.brand_id,OLD.idempotency_key,OLD.request_hash) THEN RAISE EXCEPTION 'IMMUTABLE_TASK_SNAPSHOT'; END IF;
  NEW.updated_at=now(); RETURN NEW;
END $$;
CREATE TRIGGER immutable_task BEFORE UPDATE ON kff.tasks FOR EACH ROW EXECUTE FUNCTION kff.protect_task_snapshot();

CREATE FUNCTION kff.protect_action_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.state=OLD.state THEN RETURN NEW; END IF;
  IF NOT ((OLD.state='QUEUED' AND NEW.state IN ('PREPARING','CANCELED','BLOCKED')) OR
    (OLD.state='PREPARING' AND NEW.state IN ('SUBMITTING','VERIFIED_SUCCEEDED','VERIFIED_FAILED','CANCELED','BLOCKED','NEEDS_HUMAN')) OR
    (OLD.state='SUBMITTING' AND NEW.state IN ('SUBMITTED','VERIFIED_SUCCEEDED','VERIFIED_FAILED','UNKNOWN_OUTCOME')) OR
    (OLD.state='SUBMITTED' AND NEW.state IN ('VERIFIED_SUCCEEDED','VERIFIED_FAILED','UNKNOWN_OUTCOME')) OR
    (OLD.state='UNKNOWN_OUTCOME' AND NEW.state IN ('VERIFIED_SUCCEEDED','VERIFIED_FAILED','NEEDS_HUMAN'))) THEN RAISE EXCEPTION 'INVALID_ACTION_TRANSITION'; END IF;
  NEW.updated_at=now(); RETURN NEW;
END $$;
CREATE TRIGGER action_transition BEFORE UPDATE ON kff.actions FOR EACH ROW EXECUTE FUNCTION kff.protect_action_transition();
