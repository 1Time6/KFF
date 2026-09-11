CREATE TABLE kff.adapter_artifacts (
  id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'), adapter_version text NOT NULL,
  source_hashes jsonb NOT NULL, test_count integer NOT NULL CHECK(test_count>0), test_command text NOT NULL,
  test_ended_at timestamptz NOT NULL, evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON kff.adapter_artifacts TO kff_app;
CREATE TABLE kff.capability_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL,
  capability_id uuid NOT NULL, artifact_id text NOT NULL REFERENCES kff.adapter_artifacts(id), recorded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(capability_id,organization_id,brand_id) REFERENCES kff.capabilities(id,organization_id,brand_id)
);
ALTER TABLE kff.capabilities ADD COLUMN implementation_digest text;
ALTER TABLE kff.capability_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY scoped_access ON kff.capability_checks TO kff_app USING(organization_id=nullif(current_setting('kff.organization_id',true),'')::uuid AND brand_id=nullif(current_setting('kff.brand_id',true),'')::uuid) WITH CHECK(organization_id=nullif(current_setting('kff.organization_id',true),'')::uuid AND brand_id=nullif(current_setting('kff.brand_id',true),'')::uuid);
GRANT SELECT,INSERT ON kff.capability_checks TO kff_app;
