-- Additive acquisition metadata. Observations and execution stay in the original stores.
CREATE TABLE kff.acquisition_monitors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL,
 account_id uuid NOT NULL, request_id uuid NOT NULL, request_hash text NOT NULL, title text NOT NULL,
 config jsonb NOT NULL, state text NOT NULL DEFAULT 'PAUSED' CHECK(state IN ('PAUSED','ACTIVE')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), interval_minutes integer NOT NULL CHECK(interval_minutes BETWEEN 5 AND 10080),
 next_due_at timestamptz NOT NULL DEFAULT now(), scan_number integer NOT NULL DEFAULT 0,
 automation jsonb, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id,brand_id), UNIQUE(organization_id,brand_id,request_id),
 FOREIGN KEY(account_id,organization_id,brand_id) REFERENCES kff.accounts(id,organization_id,brand_id)
);
CREATE TABLE kff.acquisition_scans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL,
 monitor_id uuid NOT NULL, query_id uuid NOT NULL UNIQUE, monitor_version integer NOT NULL, scan_number integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(monitor_id,scan_number),
 FOREIGN KEY(monitor_id,organization_id,brand_id) REFERENCES kff.acquisition_monitors(id,organization_id,brand_id),
 FOREIGN KEY(query_id,organization_id,brand_id) REFERENCES kff.collection_queries(id,organization_id,brand_id)
);
CREATE TABLE kff.acquisition_leads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL,
 monitor_id uuid NOT NULL, object_id uuid NOT NULL, observation_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1, state text NOT NULL DEFAULT 'NEW' CHECK(state IN ('NEW','QUALIFIED','DISMISSED','OPTED_OUT')),
 score integer NOT NULL CHECK(score BETWEEN 0 AND 100), matched_keywords jsonb NOT NULL, reason text NOT NULL,
 automation_error text,next_action_at timestamptz DEFAULT now(),
 first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id,brand_id), UNIQUE(monitor_id,object_id),
 FOREIGN KEY(monitor_id,organization_id,brand_id) REFERENCES kff.acquisition_monitors(id,organization_id,brand_id),
 FOREIGN KEY(object_id,organization_id,brand_id) REFERENCES kff.collection_objects(id,organization_id,brand_id) ON DELETE CASCADE,
 FOREIGN KEY(observation_id,organization_id,brand_id) REFERENCES kff.collection_observations(id,organization_id,brand_id) ON DELETE CASCADE
);
CREATE TABLE kff.acquisition_action_links (
 task_id uuid PRIMARY KEY, organization_id uuid NOT NULL, brand_id uuid NOT NULL,
 monitor_id uuid NOT NULL, lead_id uuid NOT NULL, account_id uuid NOT NULL, platform text NOT NULL,
 source_object_id text NOT NULL, author_id text NOT NULL, action_kind text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id,platform,source_object_id,action_kind),
 FOREIGN KEY(task_id,organization_id,brand_id) REFERENCES kff.tasks(id,organization_id,brand_id),
 FOREIGN KEY(monitor_id,organization_id,brand_id) REFERENCES kff.acquisition_monitors(id,organization_id,brand_id)
);
CREATE INDEX acquisition_due ON kff.acquisition_monitors(next_due_at) WHERE state='ACTIVE';
CREATE TABLE kff.acquisition_evaluations (
 observation_id uuid PRIMARY KEY REFERENCES kff.collection_observations(id) ON DELETE CASCADE,
 organization_id uuid NOT NULL, brand_id uuid NOT NULL, monitor_id uuid NOT NULL,
 score integer NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE kff.acquisition_suppressions (
 organization_id uuid NOT NULL,brand_id uuid NOT NULL,account_id uuid NOT NULL,author_id text NOT NULL,
 reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(account_id,author_id),
 FOREIGN KEY(account_id,organization_id,brand_id) REFERENCES kff.accounts(id,organization_id,brand_id)
);
CREATE INDEX acquisition_lead_selection ON kff.acquisition_leads(monitor_id,state,score DESC);
CREATE INDEX acquisition_contact_frequency ON kff.acquisition_action_links(account_id,author_id,created_at);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['acquisition_monitors','acquisition_scans','acquisition_leads','acquisition_action_links','acquisition_evaluations','acquisition_suppressions'] LOOP
  EXECUTE format('ALTER TABLE kff.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY scoped_access ON kff.%I TO kff_app USING (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid) WITH CHECK (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid)',tab);
  EXECUTE format('GRANT SELECT,INSERT ON kff.%I TO kff_app',tab);
 END LOOP;
END $$;
GRANT UPDATE ON kff.acquisition_monitors,kff.acquisition_leads TO kff_app;
