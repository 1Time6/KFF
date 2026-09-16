-- Additive only: existing environments/tasks retain version 1 and their existing evidence.
ALTER TABLE kff.environments
 ADD COLUMN configuration_version integer NOT NULL DEFAULT 1 CHECK(configuration_version>0),
 ADD COLUMN browser_configuration jsonb,
 ADD COLUMN browser_status text NOT NULL DEFAULT 'UNASSESSED' CHECK(browser_status IN ('UNASSESSED','STARTING','RUNNING','CLOSED','UNKNOWN')),
 ADD COLUMN browser_version text,
 ADD COLUMN browser_checked_at timestamptz,
 ADD COLUMN browser_error_code text;
CREATE UNIQUE INDEX environment_provider_profile ON kff.environments(agent_id,(browser_configuration->>'provider_profile_id')) WHERE browser_configuration->>'driver'='adspower';

CREATE TABLE kff.environment_commands (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL,
 environment_id uuid NOT NULL, account_id uuid NOT NULL, agent_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('CHECK','OPEN_LOGIN')),
 snapshot jsonb NOT NULL, snapshot_hash text NOT NULL, request_id uuid NOT NULL, request_hash text NOT NULL,
 state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','CLOSED','FAILED','QUARANTINED')),
 stop_requested boolean NOT NULL DEFAULT false, expires_at timestamptz NOT NULL,
 heartbeat_at timestamptz, opened_at timestamptz, closed_at timestamptz, result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id,brand_id), UNIQUE(brand_id,request_id),
 FOREIGN KEY(environment_id,account_id,organization_id,brand_id) REFERENCES kff.environments(id,account_id,organization_id,brand_id),
 FOREIGN KEY(agent_id,organization_id,brand_id) REFERENCES kff.agents(id,organization_id,brand_id)
);
CREATE UNIQUE INDEX environment_command_active ON kff.environment_commands(environment_id) WHERE state IN ('QUEUED','RUNNING','QUARANTINED');
CREATE INDEX environment_command_claim ON kff.environment_commands(agent_id,created_at) WHERE state='QUEUED';
ALTER TABLE kff.resource_leases ADD COLUMN holder_control_id uuid;
ALTER TABLE kff.resource_leases ADD CONSTRAINT resource_control_owner FOREIGN KEY(holder_control_id,organization_id,brand_id) REFERENCES kff.environment_commands(id,organization_id,brand_id);
ALTER TABLE kff.resource_leases ADD CONSTRAINT resource_single_owner CHECK(holder_attempt_id IS NULL OR holder_control_id IS NULL);

ALTER TABLE kff.environment_commands ENABLE ROW LEVEL SECURITY;
CREATE POLICY scoped_access ON kff.environment_commands TO kff_app
 USING(organization_id=nullif(current_setting('kff.organization_id',true),'')::uuid AND brand_id=nullif(current_setting('kff.brand_id',true),'')::uuid)
 WITH CHECK(organization_id=nullif(current_setting('kff.organization_id',true),'')::uuid AND brand_id=nullif(current_setting('kff.brand_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON kff.environment_commands TO kff_app;
