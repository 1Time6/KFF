CREATE TABLE kff.template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL,
  capability_key text NOT NULL, version_number integer NOT NULL CHECK(version_number>0), version_label text NOT NULL, name text NOT NULL,
  manifest jsonb NOT NULL, manifest_hash text NOT NULL, state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','ALLOWED','DISABLED','DEPRECATED')),
  policy_version integer NOT NULL DEFAULT 1 CHECK(policy_version>0), origin text NOT NULL CHECK(origin IN ('bundled','derived')),
  based_on_version_id uuid, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id), UNIQUE(organization_id,brand_id,capability_key,version_number),
  FOREIGN KEY(brand_id,organization_id) REFERENCES kff.brands(id,organization_id),
  FOREIGN KEY(based_on_version_id,organization_id,brand_id) REFERENCES kff.template_versions(id,organization_id,brand_id)
);
CREATE TABLE kff.template_previews (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, brand_id uuid NOT NULL, template_version_id uuid NOT NULL,
  manifest_hash text NOT NULL, account_id uuid NOT NULL, environment_id uuid NOT NULL, capability_id uuid NOT NULL,
  request_hash text NOT NULL, input_hash text NOT NULL, can_enable boolean NOT NULL, result jsonb NOT NULL,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(template_version_id,organization_id,brand_id) REFERENCES kff.template_versions(id,organization_id,brand_id),
  FOREIGN KEY(account_id,organization_id,brand_id) REFERENCES kff.accounts(id,organization_id,brand_id),
  FOREIGN KEY(environment_id,organization_id,brand_id) REFERENCES kff.environments(id,organization_id,brand_id),
  FOREIGN KEY(capability_id,organization_id,brand_id) REFERENCES kff.capabilities(id,organization_id,brand_id)
);
CREATE TABLE kff.template_events (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, brand_id uuid NOT NULL, template_version_id uuid NOT NULL,
  event_type text NOT NULL CHECK(event_type IN ('VERSION_CREATED','POLICY_CHANGED')), actor_id uuid NOT NULL,
  request_hash text NOT NULL, details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(template_version_id,organization_id,brand_id) REFERENCES kff.template_versions(id,organization_id,brand_id)
);
CREATE INDEX template_previews_version ON kff.template_previews(template_version_id,created_at DESC);
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['template_versions','template_previews','template_events'] LOOP
    EXECUTE format('ALTER TABLE kff.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY scoped_access ON kff.%I TO kff_app USING (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid) WITH CHECK (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid)',tab);
    EXECUTE format('GRANT SELECT,INSERT ON kff.%I TO kff_app',tab);
  END LOOP;
END $$;
GRANT UPDATE ON kff.template_versions TO kff_app;
CREATE FUNCTION kff.protect_template_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_TEMPLATE_RECORD'; END $$;
CREATE TRIGGER template_preview_immutable BEFORE UPDATE OR DELETE ON kff.template_previews FOR EACH ROW EXECUTE FUNCTION kff.protect_template_record();
CREATE TRIGGER template_event_immutable BEFORE UPDATE OR DELETE ON kff.template_events FOR EACH ROW EXECUTE FUNCTION kff.protect_template_record();
CREATE FUNCTION kff.protect_template_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (to_jsonb(NEW)-ARRAY['state','policy_version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','policy_version','updated_at']) THEN RAISE EXCEPTION 'IMMUTABLE_TEMPLATE_DEFINITION'; END IF;
  IF OLD.state='DEPRECATED' AND NEW.state<>'DEPRECATED' THEN RAISE EXCEPTION 'TEMPLATE_PERMANENTLY_DEPRECATED'; END IF;
  IF NEW.policy_version<>OLD.policy_version+1 THEN RAISE EXCEPTION 'TEMPLATE_POLICY_VERSION_REQUIRED'; END IF;
  NEW.updated_at=now(); RETURN NEW;
END $$;
CREATE TRIGGER template_definition_immutable BEFORE UPDATE ON kff.template_versions FOR EACH ROW EXECUTE FUNCTION kff.protect_template_version();
