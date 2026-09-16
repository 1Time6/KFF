-- A monitor stores polling checkpoints; all execution remains in tasks/jobs/Agent leases.
CREATE TABLE kff.browser_inbox_monitors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL,
 account_id uuid NOT NULL, environment_id uuid NOT NULL, binding jsonb NOT NULL,
 state text NOT NULL DEFAULT 'PAUSED' CHECK(state IN ('ACTIVE','PAUSED')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), scan_requested boolean NOT NULL DEFAULT false,
 interval_seconds integer NOT NULL CHECK(interval_seconds BETWEEN 10 AND 3600),
 page_size integer NOT NULL CHECK(page_size BETWEEN 1 AND 50),
 raw_retention_hours integer NOT NULL CHECK(raw_retention_hours BETWEEN 1 AND 24),
 cursor text CHECK(length(cursor) BETWEEN 1 AND 2048), page_token bigint NOT NULL DEFAULT 0 CHECK(page_token>=0),
 cycle_id uuid NOT NULL DEFAULT gen_random_uuid(), cycle_pages integer NOT NULL DEFAULT 0 CHECK(cycle_pages BETWEEN 0 AND 20),
 current_task_id uuid, next_poll_at timestamptz NOT NULL DEFAULT now(), last_polled_at timestamptz, last_error_code text,
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id,brand_id), UNIQUE(account_id),
 FOREIGN KEY(environment_id,account_id,organization_id,brand_id) REFERENCES kff.environments(id,account_id,organization_id,brand_id),
 FOREIGN KEY(current_task_id,organization_id,brand_id) REFERENCES kff.tasks(id,organization_id,brand_id)
);
CREATE INDEX browser_inbox_due ON kff.browser_inbox_monitors(next_poll_at,id) WHERE current_task_id IS NULL AND (state='ACTIVE' OR scan_requested);
CREATE TABLE kff.browser_inbox_checkpoints (
 task_id uuid PRIMARY KEY, monitor_id uuid NOT NULL, organization_id uuid NOT NULL, brand_id uuid NOT NULL,
 cycle_id uuid NOT NULL, page_token bigint NOT NULL, cursor text, next_cursor text,
 page_sha256 text NOT NULL CHECK(page_sha256 ~ '^[a-f0-9]{64}$'),
 stored integer NOT NULL CHECK(stored>=0), duplicates integer NOT NULL CHECK(duplicates>=0), observed_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(monitor_id,page_token),
 FOREIGN KEY(task_id,organization_id,brand_id) REFERENCES kff.tasks(id,organization_id,brand_id),
 FOREIGN KEY(monitor_id,organization_id,brand_id) REFERENCES kff.browser_inbox_monitors(id,organization_id,brand_id)
);
CREATE INDEX browser_inbox_cycle ON kff.browser_inbox_checkpoints(monitor_id,cycle_id);
ALTER TABLE kff.browser_inbox_monitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE kff.browser_inbox_checkpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY scoped_access ON kff.browser_inbox_monitors TO kff_app
 USING(organization_id=nullif(current_setting('kff.organization_id',true),'')::uuid AND brand_id=nullif(current_setting('kff.brand_id',true),'')::uuid)
 WITH CHECK(organization_id=nullif(current_setting('kff.organization_id',true),'')::uuid AND brand_id=nullif(current_setting('kff.brand_id',true),'')::uuid);
CREATE POLICY scoped_access ON kff.browser_inbox_checkpoints TO kff_app
 USING(organization_id=nullif(current_setting('kff.organization_id',true),'')::uuid AND brand_id=nullif(current_setting('kff.brand_id',true),'')::uuid)
 WITH CHECK(organization_id=nullif(current_setting('kff.organization_id',true),'')::uuid AND brand_id=nullif(current_setting('kff.brand_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON kff.browser_inbox_monitors TO kff_app;
GRANT SELECT,INSERT ON kff.browser_inbox_checkpoints TO kff_app;
