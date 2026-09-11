CREATE TABLE kff.import_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL, request_id uuid NOT NULL,
  account_id uuid NOT NULL, created_by uuid NOT NULL, configuration jsonb NOT NULL, request_hash text NOT NULL, file_hash text NOT NULL,
  byte_length integer NOT NULL CHECK(byte_length BETWEEN 1 AND 8388608), original bytea, parsed jsonb,
  original_expires_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id), UNIQUE(organization_id,brand_id,request_id),
  FOREIGN KEY(account_id,organization_id,brand_id) REFERENCES kff.accounts(id,organization_id,brand_id),
  CHECK(original_expires_at>created_at AND expires_at>created_at), CHECK(original IS NULL OR octet_length(original)=byte_length)
);
CREATE TABLE kff.import_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL, import_id uuid NOT NULL,
  request_id uuid NOT NULL, request_hash text NOT NULL, mapping jsonb NOT NULL, rows jsonb, summary jsonb NOT NULL,
  preview_hash text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id), UNIQUE(id,import_id,organization_id,brand_id), UNIQUE(import_id,request_id),
  FOREIGN KEY(import_id,organization_id,brand_id) REFERENCES kff.import_files(id,organization_id,brand_id)
);
CREATE TABLE kff.import_confirmations (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, brand_id uuid NOT NULL, import_id uuid NOT NULL UNIQUE, preview_id uuid NOT NULL,
  request_hash text NOT NULL, query_id uuid NOT NULL, content_hash text NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(preview_id,import_id,organization_id,brand_id) REFERENCES kff.import_previews(id,import_id,organization_id,brand_id),
  FOREIGN KEY(query_id,organization_id,brand_id) REFERENCES kff.collection_queries(id,organization_id,brand_id)
);
CREATE INDEX import_content_lookup ON kff.import_confirmations(organization_id,brand_id,content_hash);
CREATE INDEX import_expiry ON kff.import_files(expires_at);
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['import_files','import_previews','import_confirmations'] LOOP
    EXECUTE format('ALTER TABLE kff.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY scoped_access ON kff.%I TO kff_app USING (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid) WITH CHECK (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid)',tab);
    EXECUTE format('GRANT SELECT,INSERT ON kff.%I TO kff_app',tab);
  END LOOP;
END $$;
CREATE FUNCTION kff.protect_import_file() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'original'-'parsed')=(to_jsonb(OLD)-'original'-'parsed')
    AND (NEW.original IS NOT DISTINCT FROM OLD.original OR (NEW.original IS NULL AND OLD.original_expires_at<=clock_timestamp()))
    AND (NEW.parsed IS NOT DISTINCT FROM OLD.parsed OR (NEW.parsed IS NULL AND OLD.expires_at<=clock_timestamp())) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'IMMUTABLE_IMPORT_FILE';
END $$;
CREATE TRIGGER import_file_immutable BEFORE UPDATE OR DELETE ON kff.import_files FOR EACH ROW EXECUTE FUNCTION kff.protect_import_file();
CREATE FUNCTION kff.protect_import_preview() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'rows')=(to_jsonb(OLD)-'rows') AND NEW.rows IS NULL AND OLD.expires_at<=clock_timestamp() THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'IMMUTABLE_IMPORT_PREVIEW';
END $$;
CREATE TRIGGER import_preview_immutable BEFORE UPDATE OR DELETE ON kff.import_previews FOR EACH ROW EXECUTE FUNCTION kff.protect_import_preview();
CREATE TRIGGER import_confirmation_immutable BEFORE UPDATE OR DELETE ON kff.import_confirmations FOR EACH ROW EXECUTE FUNCTION kff.protect_collection_record();
