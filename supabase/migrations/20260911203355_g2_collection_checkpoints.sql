CREATE TABLE kff.collection_queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL, request_id uuid NOT NULL,
  account_id uuid NOT NULL, title text NOT NULL, snapshot jsonb NOT NULL, snapshot_hash text NOT NULL, request_hash text NOT NULL,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  UNIQUE(id,organization_id,brand_id), UNIQUE(organization_id,brand_id,request_id),
  FOREIGN KEY(account_id,organization_id,brand_id) REFERENCES kff.accounts(id,organization_id,brand_id), CHECK(expires_at>created_at)
);
CREATE TABLE kff.collection_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL, query_id uuid NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','COMPLETED','PARTIAL','FAILED','CANCELED')),
  version integer NOT NULL DEFAULT 0 CHECK(version>=0), lease_token bigint NOT NULL DEFAULT 0 CHECK(lease_token>=0), lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(), next_cursor text, committed_pages integer NOT NULL DEFAULT 0 CHECK(committed_pages>=0),
  returned_count integer NOT NULL DEFAULT 0 CHECK(returned_count>=0), unique_count integer NOT NULL DEFAULT 0 CHECK(unique_count>=0 AND unique_count<=returned_count),
  reported_total bigint CHECK(reported_total>=0), stop_reason text, error_code text, started_at timestamptz, finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id), FOREIGN KEY(query_id,organization_id,brand_id) REFERENCES kff.collection_queries(id,organization_id,brand_id),
  CHECK(next_cursor IS NULL OR length(next_cursor) BETWEEN 1 AND 2048)
);
CREATE TABLE kff.collection_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL, run_id uuid NOT NULL,
  page_number integer NOT NULL CHECK(page_number>0), cursor_in_hash text NOT NULL, next_cursor_hash text,
  evidence_hash text NOT NULL, observed_at timestamptz NOT NULL, returned_count integer NOT NULL CHECK(returned_count>=0),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,organization_id,brand_id), UNIQUE(id,run_id,organization_id,brand_id), UNIQUE(run_id,page_number), UNIQUE(run_id,cursor_in_hash),
  FOREIGN KEY(run_id,organization_id,brand_id) REFERENCES kff.collection_runs(id,organization_id,brand_id)
);
CREATE TABLE kff.collection_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL, account_id uuid NOT NULL,
  source_key text NOT NULL, source_object_id text NOT NULL, last_version integer NOT NULL DEFAULT 0 CHECK(last_version>=0),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,organization_id,brand_id), UNIQUE(organization_id,brand_id,account_id,source_key,source_object_id),
  FOREIGN KEY(account_id,organization_id,brand_id) REFERENCES kff.accounts(id,organization_id,brand_id)
);
CREATE TABLE kff.collection_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL,
  object_id uuid NOT NULL, run_id uuid NOT NULL, page_id uuid NOT NULL, row_number integer NOT NULL CHECK(row_number>=0), object_version integer NOT NULL CHECK(object_version>0),
  source_object_id text NOT NULL, source_url text NOT NULL, observed_at timestamptz NOT NULL, fields jsonb NOT NULL, evidence_hash text NOT NULL,
  allowed_purposes jsonb NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id), UNIQUE(id,run_id,object_id,organization_id,brand_id), UNIQUE(object_id,object_version), UNIQUE(page_id,row_number),
  FOREIGN KEY(object_id,organization_id,brand_id) REFERENCES kff.collection_objects(id,organization_id,brand_id),
  FOREIGN KEY(run_id,organization_id,brand_id) REFERENCES kff.collection_runs(id,organization_id,brand_id),
  FOREIGN KEY(page_id,run_id,organization_id,brand_id) REFERENCES kff.collection_pages(id,run_id,organization_id,brand_id)
);
CREATE TABLE kff.collection_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL, run_id uuid NOT NULL, object_id uuid NOT NULL,
  observation_id uuid NOT NULL, result_order bigint GENERATED ALWAYS AS IDENTITY,
  UNIQUE(run_id,object_id), FOREIGN KEY(run_id,organization_id,brand_id) REFERENCES kff.collection_runs(id,organization_id,brand_id),
  FOREIGN KEY(object_id,organization_id,brand_id) REFERENCES kff.collection_objects(id,organization_id,brand_id),
  FOREIGN KEY(observation_id,run_id,object_id,organization_id,brand_id) REFERENCES kff.collection_observations(id,run_id,object_id,organization_id,brand_id) ON DELETE CASCADE
);
CREATE TABLE kff.collection_events (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, brand_id uuid NOT NULL, run_id uuid NOT NULL, actor_id uuid NOT NULL,
  event_type text NOT NULL, request_hash text NOT NULL, details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(run_id,organization_id,brand_id) REFERENCES kff.collection_runs(id,organization_id,brand_id)
);
CREATE INDEX collection_work_queue ON kff.collection_runs(available_at,created_at) WHERE state IN ('QUEUED','RUNNING');
CREATE INDEX collection_result_page ON kff.collection_results(run_id,result_order);
CREATE INDEX collection_observation_history ON kff.collection_observations(run_id,object_id,object_version);
CREATE INDEX collection_observation_expiry ON kff.collection_observations(expires_at);
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['collection_queries','collection_runs','collection_pages','collection_objects','collection_observations','collection_results','collection_events'] LOOP
    EXECUTE format('ALTER TABLE kff.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY scoped_access ON kff.%I TO kff_app USING (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid) WITH CHECK (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid)',tab);
    EXECUTE format('GRANT SELECT,INSERT ON kff.%I TO kff_app',tab);
  END LOOP;
END $$;
GRANT UPDATE ON kff.collection_runs,kff.collection_objects,kff.collection_results TO kff_app;
GRANT USAGE,SELECT ON SEQUENCE kff.collection_results_result_order_seq TO kff_app;
CREATE FUNCTION kff.protect_collection_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_COLLECTION_RECORD'; END $$;
CREATE TRIGGER collection_query_immutable BEFORE UPDATE OR DELETE ON kff.collection_queries FOR EACH ROW EXECUTE FUNCTION kff.protect_collection_record();
CREATE TRIGGER collection_page_immutable BEFORE UPDATE OR DELETE ON kff.collection_pages FOR EACH ROW EXECUTE FUNCTION kff.protect_collection_record();
CREATE TRIGGER collection_event_immutable BEFORE UPDATE OR DELETE ON kff.collection_events FOR EACH ROW EXECUTE FUNCTION kff.protect_collection_record();
CREATE FUNCTION kff.protect_collection_observation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' AND OLD.expires_at<=clock_timestamp() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'IMMUTABLE_COLLECTION_OBSERVATION';
END $$;
CREATE TRIGGER collection_observation_immutable BEFORE UPDATE OR DELETE ON kff.collection_observations FOR EACH ROW EXECUTE FUNCTION kff.protect_collection_observation();
CREATE FUNCTION kff.protect_collection_object() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (to_jsonb(NEW)-'last_version') IS DISTINCT FROM (to_jsonb(OLD)-'last_version') OR NEW.last_version<>OLD.last_version+1 THEN RAISE EXCEPTION 'IMMUTABLE_COLLECTION_IDENTITY'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER collection_object_identity BEFORE UPDATE ON kff.collection_objects FOR EACH ROW EXECUTE FUNCTION kff.protect_collection_object();
