-- External discovery belongs to a brand and verified provider, not a fabricated Meta account.
CREATE TABLE kff.acquisition_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,
 provider text NOT NULL CHECK(provider='APIFY'),provider_user_id text NOT NULL,display_name text NOT NULL,
 verified_at timestamptz NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id,brand_id),UNIQUE(organization_id,brand_id,provider,provider_user_id),
 FOREIGN KEY(brand_id,organization_id) REFERENCES kff.brands(id,organization_id)
);
CREATE TABLE kff.acquisition_imports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,source_id uuid NOT NULL,
 provider_run_id text NOT NULL,actor_id text NOT NULL,dataset_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('FACEBOOK_POSTS','FACEBOOK_COMMENTS','INSTAGRAM_COMMENTS')),
 search_keywords jsonb NOT NULL DEFAULT '[]',source_urls jsonb NOT NULL DEFAULT '[]',
 returned_count integer NOT NULL,unique_count integer NOT NULL,content_hash text NOT NULL,
 usage_usd numeric,finished_at timestamptz NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id,brand_id),UNIQUE(source_id,provider_run_id),
 FOREIGN KEY(source_id,organization_id,brand_id) REFERENCES kff.acquisition_sources(id,organization_id,brand_id)
);
CREATE TABLE kff.acquisition_prospects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,source_id uuid NOT NULL,import_id uuid NOT NULL,
 platform text NOT NULL CHECK(platform IN ('facebook','instagram')),kind text NOT NULL CHECK(kind IN ('POST','COMMENT')),remote_id text NOT NULL,
 source_url text NOT NULL,parent_url text,body text NOT NULL,author_name text,profile_ref text,profile_url text,
 occurred_at timestamptz,search_keywords jsonb NOT NULL DEFAULT '[]',score integer NOT NULL CHECK(score BETWEEN 0 AND 100),score_reason text NOT NULL,
 state text NOT NULL DEFAULT 'NEW' CHECK(state IN ('NEW','QUALIFIED','DISMISSED','OPTED_OUT')),review_note text,
 version integer NOT NULL DEFAULT 1,first_seen_at timestamptz NOT NULL DEFAULT now(),last_seen_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 UNIQUE(id,organization_id,brand_id),UNIQUE(source_id,platform,kind,remote_id),
 FOREIGN KEY(source_id,organization_id,brand_id) REFERENCES kff.acquisition_sources(id,organization_id,brand_id),
 FOREIGN KEY(import_id,organization_id,brand_id) REFERENCES kff.acquisition_imports(id,organization_id,brand_id)
);
CREATE INDEX acquisition_prospect_source_url ON kff.acquisition_prospects(source_id,source_url) WHERE kind='POST';
CREATE INDEX acquisition_prospect_expiry ON kff.acquisition_prospects(expires_at);
CREATE INDEX acquisition_prospect_selection ON kff.acquisition_prospects(brand_id,kind,score DESC,last_seen_at DESC);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['acquisition_sources','acquisition_imports','acquisition_prospects'] LOOP
  EXECUTE format('ALTER TABLE kff.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY scoped_access ON kff.%I TO kff_app USING (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid) WITH CHECK (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid)',tab);
  EXECUTE format('GRANT SELECT,INSERT ON kff.%I TO kff_app',tab);
 END LOOP;
END $$;
GRANT UPDATE ON kff.acquisition_sources,kff.acquisition_prospects TO kff_app;
