CREATE TABLE kff.commerce_currencies (
  organization_id uuid NOT NULL,brand_id uuid NOT NULL,currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  minor_unit_exponent integer NOT NULL CHECK(minor_unit_exponent BETWEEN 0 AND 6),precision_source text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(brand_id,currency),UNIQUE(brand_id,currency,minor_unit_exponent),FOREIGN KEY(brand_id,organization_id) REFERENCES kff.brands(id,organization_id)
);
CREATE TABLE kff.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,sku text NOT NULL CHECK(sku ~ '^[A-Za-z0-9._-]{1,80}$'),
  state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','ACTIVE','ARCHIVED')),version integer NOT NULL DEFAULT 1 CHECK(version>0),current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,organization_id,brand_id),UNIQUE(brand_id,sku),
  FOREIGN KEY(brand_id,organization_id) REFERENCES kff.brands(id,organization_id)
);
CREATE TABLE kff.product_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,product_id uuid NOT NULL,
  version_number integer NOT NULL CHECK(version_number>0),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),currency text NOT NULL,
  minor_unit_exponent integer NOT NULL CHECK(minor_unit_exponent BETWEEN 0 AND 6),precision_source text NOT NULL,
  unit_amount_minor bigint NOT NULL CHECK(unit_amount_minor BETWEEN 0 AND 999999999999999),delivery_scope text NOT NULL CHECK(length(delivery_scope) BETWEEN 1 AND 2000),terms text NOT NULL CHECK(length(terms) BETWEEN 1 AND 4000),
  request_id uuid NOT NULL,request_hash text NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id),UNIQUE(id,product_id,organization_id,brand_id),UNIQUE(product_id,version_number),UNIQUE(brand_id,request_id),
  FOREIGN KEY(product_id,organization_id,brand_id) REFERENCES kff.products(id,organization_id,brand_id),FOREIGN KEY(brand_id,currency,minor_unit_exponent) REFERENCES kff.commerce_currencies(brand_id,currency,minor_unit_exponent),
  FOREIGN KEY(created_by,brand_id) REFERENCES kff.memberships(user_id,brand_id)
);
ALTER TABLE kff.products ADD FOREIGN KEY(current_version_id,id,organization_id,brand_id) REFERENCES kff.product_versions(id,product_id,organization_id,brand_id);
CREATE TABLE kff.order_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,customer_id uuid NOT NULL,
  snapshot jsonb NOT NULL,snapshot_hash text NOT NULL,request_id uuid NOT NULL,request_hash text NOT NULL,created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT(now()+interval '15 minutes'),
  UNIQUE(id,organization_id,brand_id),UNIQUE(id,customer_id,organization_id,brand_id),UNIQUE(brand_id,request_id),
  FOREIGN KEY(customer_id,organization_id,brand_id) REFERENCES kff.customers(id,organization_id,brand_id),FOREIGN KEY(created_by,brand_id) REFERENCES kff.memberships(user_id,brand_id),CHECK(expires_at>created_at)
);
CREATE TABLE kff.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,customer_id uuid NOT NULL,conversation_id uuid,preview_id uuid NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','CANCELED')),payment_state text NOT NULL DEFAULT 'UNVERIFIED' CHECK(payment_state='UNVERIFIED'),version integer NOT NULL DEFAULT 1 CHECK(version>0),
  snapshot jsonb NOT NULL,snapshot_hash text NOT NULL,request_id uuid NOT NULL,request_hash text NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id,brand_id),UNIQUE(brand_id,request_id),
  FOREIGN KEY(preview_id,customer_id,organization_id,brand_id) REFERENCES kff.order_previews(id,customer_id,organization_id,brand_id),
  FOREIGN KEY(conversation_id,customer_id,organization_id,brand_id) REFERENCES kff.conversations(id,customer_id,organization_id,brand_id),FOREIGN KEY(created_by,brand_id) REFERENCES kff.memberships(user_id,brand_id)
);
CREATE TABLE kff.order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,order_id uuid NOT NULL,
  event_type text NOT NULL CHECK(event_type IN ('CREATED','CANCELED')),actor_id uuid NOT NULL,details jsonb NOT NULL,request_id uuid NOT NULL,request_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(brand_id,request_id),FOREIGN KEY(order_id,organization_id,brand_id) REFERENCES kff.orders(id,organization_id,brand_id)
);
CREATE INDEX orders_recent ON kff.orders(brand_id,created_at DESC,id);
CREATE INDEX orders_customer ON kff.orders(customer_id,created_at DESC,id);
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['commerce_currencies','products','product_versions','order_previews','orders','order_events'] LOOP
    EXECUTE format('ALTER TABLE kff.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY scoped_access ON kff.%I TO kff_app USING (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid) WITH CHECK (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid)',tab);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON kff.%I TO kff_app',tab);
  END LOOP;
END $$;
REVOKE UPDATE ON kff.commerce_currencies,kff.product_versions,kff.order_previews,kff.order_events FROM kff_app;
CREATE TRIGGER commerce_precision_immutable BEFORE UPDATE ON kff.commerce_currencies FOR EACH ROW EXECUTE FUNCTION kff.protect_owned_record();
CREATE TRIGGER product_version_immutable BEFORE UPDATE ON kff.product_versions FOR EACH ROW EXECUTE FUNCTION kff.protect_owned_record();
CREATE TRIGGER order_preview_immutable BEFORE UPDATE ON kff.order_previews FOR EACH ROW EXECUTE FUNCTION kff.protect_owned_record();
CREATE TRIGGER order_event_immutable BEFORE UPDATE ON kff.order_events FOR EACH ROW EXECUTE FUNCTION kff.protect_owned_record();
CREATE FUNCTION kff.protect_product_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.id,NEW.organization_id,NEW.brand_id,NEW.sku,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.brand_id,OLD.sku,OLD.created_at) THEN RAISE EXCEPTION 'IMMUTABLE_PRODUCT_IDENTITY'; END IF;
  IF OLD.current_version_id IS NOT NULL AND NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'PRODUCT_VERSION_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER product_identity BEFORE UPDATE ON kff.products FOR EACH ROW EXECUTE FUNCTION kff.protect_product_identity();
CREATE FUNCTION kff.protect_order_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.id,NEW.organization_id,NEW.brand_id,NEW.customer_id,NEW.conversation_id,NEW.preview_id,NEW.snapshot,NEW.snapshot_hash,NEW.request_id,NEW.request_hash,NEW.created_by,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.brand_id,OLD.customer_id,OLD.conversation_id,OLD.preview_id,OLD.snapshot,OLD.snapshot_hash,OLD.request_id,OLD.request_hash,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'IMMUTABLE_ORDER_SNAPSHOT'; END IF;
  IF NOT(OLD.state='OPEN' AND NEW.state='CANCELED' AND NEW.version=OLD.version+1 AND OLD.payment_state='UNVERIFIED' AND NEW.payment_state='UNVERIFIED') THEN RAISE EXCEPTION 'ORDER_TRANSITION_DENIED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER order_snapshot BEFORE UPDATE ON kff.orders FOR EACH ROW EXECUTE FUNCTION kff.protect_order_snapshot();
