CREATE TABLE kff.target_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL, query_id uuid NOT NULL, request_id uuid NOT NULL,
  request_hash text NOT NULL, definition jsonb, definition_hash text NOT NULL, created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id), UNIQUE(id,query_id,organization_id,brand_id), UNIQUE(organization_id,brand_id,request_id),
  FOREIGN KEY(query_id,organization_id,brand_id) REFERENCES kff.collection_queries(id,organization_id,brand_id), CHECK(expires_at>created_at)
);
CREATE TABLE kff.target_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL, query_id uuid NOT NULL, preview_id uuid NOT NULL,
  request_id uuid NOT NULL, request_hash text NOT NULL, title text NOT NULL, definition jsonb, definition_hash text NOT NULL,
  included_count integer NOT NULL CHECK(included_count BETWEEN 0 AND 1000), excluded_count integer NOT NULL CHECK(excluded_count BETWEEN 0 AND 1000),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','REVOKED')), version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_by uuid NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id), UNIQUE(organization_id,brand_id,request_id), UNIQUE(preview_id),
  FOREIGN KEY(query_id,organization_id,brand_id) REFERENCES kff.collection_queries(id,organization_id,brand_id),
  FOREIGN KEY(preview_id,query_id,organization_id,brand_id) REFERENCES kff.target_previews(id,query_id,organization_id,brand_id), CHECK(expires_at>created_at)
);
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['target_previews','target_snapshots'] LOOP
    EXECUTE format('ALTER TABLE kff.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY scoped_access ON kff.%I TO kff_app USING (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid) WITH CHECK (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid)',tab);
    EXECUTE format('GRANT SELECT,INSERT ON kff.%I TO kff_app',tab);
  END LOOP;
END $$;
GRANT UPDATE ON kff.target_previews,kff.target_snapshots TO kff_app;
CREATE INDEX target_snapshot_query ON kff.target_snapshots(query_id,created_at);
CREATE FUNCTION kff.protect_target_preview() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'definition')=(to_jsonb(OLD)-'definition') AND NEW.definition IS NULL AND OLD.expires_at<=clock_timestamp() THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'IMMUTABLE_TARGET_PREVIEW';
END $$;
CREATE TRIGGER target_preview_immutable BEFORE UPDATE OR DELETE ON kff.target_previews FOR EACH ROW EXECUTE FUNCTION kff.protect_target_preview();
CREATE FUNCTION kff.protect_target_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'definition')=(to_jsonb(OLD)-'definition') AND NEW.definition IS NULL AND OLD.expires_at<=clock_timestamp() THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'state'-'version')=(to_jsonb(OLD)-'state'-'version') AND OLD.state='ACTIVE' AND NEW.state='REVOKED' AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'IMMUTABLE_TARGET_SNAPSHOT';
END $$;
CREATE TRIGGER target_snapshot_immutable BEFORE UPDATE OR DELETE ON kff.target_snapshots FOR EACH ROW EXECUTE FUNCTION kff.protect_target_snapshot();
