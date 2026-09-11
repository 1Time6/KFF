CREATE TABLE kff.contact_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL,
  account_id uuid NOT NULL, channel text NOT NULL CHECK(channel IN ('synthetic','facebook_messenger','site_chat')),
  remote_id text NOT NULL CHECK(length(remote_id) BETWEEN 1 AND 160),
  version integer NOT NULL DEFAULT 1 CHECK(version>0), opted_out boolean NOT NULL DEFAULT false, opted_out_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id), UNIQUE(brand_id,account_id,channel,remote_id),
  FOREIGN KEY(account_id,organization_id,brand_id) REFERENCES kff.accounts(id,organization_id,brand_id)
);
CREATE TABLE kff.contact_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, brand_id uuid NOT NULL,
  target_id uuid NOT NULL, target_version integer NOT NULL CHECK(target_version>0),
  purpose text NOT NULL CHECK(purpose IN ('customer_service','marketing')), policy jsonb NOT NULL, policy_hash text NOT NULL,
  request_id uuid NOT NULL, request_hash text NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id), UNIQUE(brand_id,request_id),
  FOREIGN KEY(target_id,organization_id,brand_id) REFERENCES kff.contact_targets(id,organization_id,brand_id)
);
CREATE INDEX contact_permissions_target ON kff.contact_permissions(target_id,created_at DESC);
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['contact_targets','contact_permissions'] LOOP
    EXECUTE format('ALTER TABLE kff.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY scoped_access ON kff.%I TO kff_app USING (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid) WITH CHECK (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid)',tab);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON kff.%I TO kff_app',tab);
  END LOOP;
END $$;
CREATE FUNCTION kff.protect_contact_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.id,NEW.organization_id,NEW.brand_id,NEW.account_id,NEW.channel,NEW.remote_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.brand_id,OLD.account_id,OLD.channel,OLD.remote_id,OLD.created_at) THEN RAISE EXCEPTION 'IMMUTABLE_CONTACT_IDENTITY'; END IF;
  IF NEW.version<OLD.version OR (ROW(NEW.opted_out,NEW.opted_out_at) IS DISTINCT FROM ROW(OLD.opted_out,OLD.opted_out_at) AND NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'CONTACT_VERSION_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contact_identity BEFORE UPDATE ON kff.contact_targets FOR EACH ROW EXECUTE FUNCTION kff.protect_contact_target();
CREATE FUNCTION kff.protect_contact_permission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.id,NEW.organization_id,NEW.brand_id,NEW.target_id,NEW.target_version,NEW.purpose,NEW.policy,NEW.policy_hash,NEW.request_id,NEW.request_hash,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.brand_id,OLD.target_id,OLD.target_version,OLD.purpose,OLD.policy,OLD.policy_hash,OLD.request_id,OLD.request_hash,OLD.created_at) THEN RAISE EXCEPTION 'IMMUTABLE_CONTACT_PERMISSION'; END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN RAISE EXCEPTION 'CONTACT_REVOCATION_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contact_permission_immutable BEFORE UPDATE ON kff.contact_permissions FOR EACH ROW EXECUTE FUNCTION kff.protect_contact_permission();
