-- Reuse the durable inbound envelope. Every Stripe object remains bound to a server-owned connection.
ALTER TABLE kff.inbound_events DROP CONSTRAINT inbound_events_source_kind_check;
ALTER TABLE kff.inbound_events DROP CONSTRAINT inbound_source_contract;
ALTER TABLE kff.inbound_events ADD CHECK(source_kind IN ('agent','site_chat','stripe'));
ALTER TABLE kff.inbound_events ADD CONSTRAINT inbound_source_contract CHECK(
 (source_kind='agent' AND agent_id IS NOT NULL AND command_id IS NOT NULL AND source_key IS NULL) OR
 (source_kind IN ('site_chat','stripe') AND agent_id IS NULL AND command_id IS NULL AND source_key IS NOT NULL AND length(source_key) BETWEEN 1 AND 300));

CREATE TABLE kff.stripe_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,name text NOT NULL,
 stripe_account_id text NOT NULL CHECK(stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),mode text NOT NULL CHECK(mode IN ('TEST','LIVE')),
 credential_ref text NOT NULL CHECK(credential_ref ~ '^KFF_STRIPE_[A-Z0-9_]{1,40}$'),is_synthetic boolean NOT NULL DEFAULT false,
 outbound_enabled boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_by uuid NOT NULL,
 request_id uuid NOT NULL,request_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id,brand_id),UNIQUE(brand_id,request_id),UNIQUE(brand_id,stripe_account_id,mode),
 FOREIGN KEY(brand_id,organization_id) REFERENCES kff.brands(id,organization_id),FOREIGN KEY(created_by,brand_id) REFERENCES kff.memberships(user_id,brand_id),CHECK(NOT is_synthetic OR mode='TEST')
);
CREATE TABLE kff.payment_checkouts (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,brand_id uuid NOT NULL,order_id uuid NOT NULL,connection_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'READY' CHECK(state IN ('READY','CREATING','OPEN','PENDING','PAID','EXPIRED','FAILED','NEEDS_HUMAN')),
 snapshot_hash text NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),minor_unit_exponent integer NOT NULL CHECK(minor_unit_exponent BETWEEN 0 AND 6),
 provider_request jsonb NOT NULL,provider_session_id text,provider_intent_id text,checkout_url text,error_code text,
 submitted_at timestamptz,next_check_at timestamptz NOT NULL DEFAULT now(),lease_token uuid,lease_until timestamptz,checks integer NOT NULL DEFAULT 0 CHECK(checks>=0),
 request_id uuid NOT NULL,request_hash text NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id,brand_id),UNIQUE(id,order_id,connection_id,organization_id,brand_id),UNIQUE(brand_id,request_id),
 UNIQUE(connection_id,provider_session_id),UNIQUE(connection_id,provider_intent_id),
 FOREIGN KEY(order_id,organization_id,brand_id) REFERENCES kff.orders(id,organization_id,brand_id),
 FOREIGN KEY(connection_id,organization_id,brand_id) REFERENCES kff.stripe_connections(id,organization_id,brand_id),
 FOREIGN KEY(created_by,brand_id) REFERENCES kff.memberships(user_id,brand_id),CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE UNIQUE INDEX payment_checkout_one_active ON kff.payment_checkouts(order_id) WHERE state NOT IN ('EXPIRED','FAILED');
CREATE INDEX payment_checkout_due ON kff.payment_checkouts(next_check_at,lease_until) WHERE state IN ('READY','CREATING','OPEN','PENDING');
CREATE TABLE kff.stripe_events (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,brand_id uuid NOT NULL,connection_id uuid NOT NULL,inbound_event_id uuid NOT NULL UNIQUE,
 provider_event_id text NOT NULL,event_type text NOT NULL,event_created_at timestamptz NOT NULL,payload jsonb NOT NULL,payload_hash text NOT NULL,
 state text NOT NULL CHECK(state IN ('PENDING','PROCESSING','PROCESSED','IGNORED','REJECTED','NEEDS_HUMAN')),
 error_code text,attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),lease_token uuid,lease_until timestamptz,received_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id,brand_id),UNIQUE(connection_id,provider_event_id),
 FOREIGN KEY(connection_id,organization_id,brand_id) REFERENCES kff.stripe_connections(id,organization_id,brand_id),
 FOREIGN KEY(inbound_event_id,organization_id,brand_id) REFERENCES kff.inbound_events(id,organization_id,brand_id),CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE INDEX stripe_events_due ON kff.stripe_events(next_attempt_at,lease_until) WHERE state IN ('PENDING','PROCESSING');
CREATE TABLE kff.verified_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,order_id uuid NOT NULL UNIQUE,checkout_id uuid NOT NULL UNIQUE,connection_id uuid NOT NULL,
 provider_intent_id text NOT NULL,provider_session_id text NOT NULL,mode text NOT NULL CHECK(mode IN ('TEST','LIVE')),is_synthetic boolean NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),currency text NOT NULL,minor_unit_exponent integer NOT NULL,source_event_id uuid,
 verified_via text NOT NULL CHECK(verified_via IN ('WEBHOOK_AND_QUERY','SERVER_QUERY')),proof jsonb NOT NULL,verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,organization_id,brand_id),UNIQUE(connection_id,provider_intent_id),UNIQUE(connection_id,provider_session_id),
 FOREIGN KEY(checkout_id,order_id,connection_id,organization_id,brand_id) REFERENCES kff.payment_checkouts(id,order_id,connection_id,organization_id,brand_id),
 FOREIGN KEY(source_event_id,organization_id,brand_id) REFERENCES kff.stripe_events(id,organization_id,brand_id),CHECK((verified_via='SERVER_QUERY')=(source_event_id IS NULL))
);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['stripe_connections','payment_checkouts','stripe_events','verified_payments'] LOOP
  EXECUTE format('ALTER TABLE kff.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY scoped_access ON kff.%I TO kff_app USING (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid) WITH CHECK (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid)',tab);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON kff.%I TO kff_app',tab);
 END LOOP;
END $$;
REVOKE UPDATE ON kff.verified_payments FROM kff_app;
CREATE TRIGGER verified_payment_immutable BEFORE UPDATE ON kff.verified_payments FOR EACH ROW EXECUTE FUNCTION kff.protect_owned_record();
CREATE FUNCTION kff.protect_stripe_connection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-ARRAY['version','outbound_enabled']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['version','outbound_enabled']) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'IMMUTABLE_STRIPE_CONNECTION'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER stripe_connection_identity BEFORE UPDATE ON kff.stripe_connections FOR EACH ROW EXECUTE FUNCTION kff.protect_stripe_connection();
CREATE FUNCTION kff.protect_payment_checkout() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.organization_id,NEW.brand_id,NEW.order_id,NEW.connection_id,NEW.snapshot_hash,NEW.amount_minor,NEW.currency,NEW.minor_unit_exponent,NEW.provider_request,NEW.request_id,NEW.request_hash,NEW.created_by,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.brand_id,OLD.order_id,OLD.connection_id,OLD.snapshot_hash,OLD.amount_minor,OLD.currency,OLD.minor_unit_exponent,OLD.provider_request,OLD.request_id,OLD.request_hash,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'IMMUTABLE_PAYMENT_REQUEST'; END IF;
 IF (OLD.provider_session_id IS NOT NULL AND NEW.provider_session_id IS DISTINCT FROM OLD.provider_session_id) OR (OLD.provider_intent_id IS NOT NULL AND NEW.provider_intent_id IS DISTINCT FROM OLD.provider_intent_id) OR (OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at) THEN RAISE EXCEPTION 'IMMUTABLE_PAYMENT_OBJECT'; END IF;
 IF OLD.state='PAID' AND NEW.state<>'PAID' THEN RAISE EXCEPTION 'PAYMENT_CANNOT_REGRESS'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER payment_checkout_identity BEFORE UPDATE ON kff.payment_checkouts FOR EACH ROW EXECUTE FUNCTION kff.protect_payment_checkout();
CREATE FUNCTION kff.protect_stripe_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.organization_id,NEW.brand_id,NEW.connection_id,NEW.inbound_event_id,NEW.provider_event_id,NEW.event_type,NEW.event_created_at,NEW.payload,NEW.payload_hash,NEW.received_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.brand_id,OLD.connection_id,OLD.inbound_event_id,OLD.provider_event_id,OLD.event_type,OLD.event_created_at,OLD.payload,OLD.payload_hash,OLD.received_at) THEN RAISE EXCEPTION 'IMMUTABLE_STRIPE_EVENT'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER stripe_event_identity BEFORE UPDATE ON kff.stripe_events FOR EACH ROW EXECUTE FUNCTION kff.protect_stripe_event();
CREATE FUNCTION kff.validate_verified_payment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM kff.payment_checkouts p JOIN kff.orders o ON o.id=p.order_id JOIN kff.stripe_connections c ON c.id=p.connection_id
  WHERE p.id=NEW.checkout_id AND p.provider_session_id=NEW.provider_session_id AND p.provider_intent_id=NEW.provider_intent_id
   AND p.amount_minor=NEW.amount_minor AND p.currency=NEW.currency AND p.minor_unit_exponent=NEW.minor_unit_exponent
   AND c.mode=NEW.mode AND c.is_synthetic=NEW.is_synthetic AND o.state='OPEN' AND o.snapshot_hash=p.snapshot_hash
   AND (o.snapshot->>'total_minor')::bigint=NEW.amount_minor AND o.snapshot->>'currency'=NEW.currency
   AND (o.snapshot->>'minor_unit_exponent')::integer=NEW.minor_unit_exponent
   AND (NEW.source_event_id IS NULL OR EXISTS(SELECT 1 FROM kff.stripe_events e WHERE e.id=NEW.source_event_id AND e.connection_id=p.connection_id))) THEN RAISE EXCEPTION 'PAYMENT_PROOF_MISMATCH'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER verified_payment_contract BEFORE INSERT ON kff.verified_payments FOR EACH ROW EXECUTE FUNCTION kff.validate_verified_payment();
ALTER TABLE kff.orders DROP CONSTRAINT orders_payment_state_check;
ALTER TABLE kff.orders ADD CHECK(payment_state IN ('UNVERIFIED','VERIFIED_TEST_PAID','VERIFIED_PAID'));
CREATE OR REPLACE FUNCTION kff.protect_order_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.organization_id,NEW.brand_id,NEW.customer_id,NEW.conversation_id,NEW.preview_id,NEW.snapshot,NEW.snapshot_hash,NEW.request_id,NEW.request_hash,NEW.created_by,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.brand_id,OLD.customer_id,OLD.conversation_id,OLD.preview_id,OLD.snapshot,OLD.snapshot_hash,OLD.request_id,OLD.request_hash,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'IMMUTABLE_ORDER_SNAPSHOT'; END IF;
 IF OLD.state='OPEN' AND NEW.state='CANCELED' AND NEW.version=OLD.version+1 AND OLD.payment_state='UNVERIFIED' AND NEW.payment_state='UNVERIFIED'
  AND NOT EXISTS(SELECT 1 FROM kff.payment_checkouts p WHERE p.order_id=OLD.id AND p.state NOT IN ('EXPIRED','FAILED')) THEN RETURN NEW; END IF;
 IF OLD.state='OPEN' AND NEW.state='OPEN' AND NEW.version=OLD.version+1 AND OLD.payment_state='UNVERIFIED' AND NEW.payment_state IN ('VERIFIED_TEST_PAID','VERIFIED_PAID')
  AND EXISTS(SELECT 1 FROM kff.verified_payments p WHERE p.order_id=OLD.id AND NEW.payment_state=CASE WHEN p.mode='LIVE' AND NOT p.is_synthetic THEN 'VERIFIED_PAID' ELSE 'VERIFIED_TEST_PAID' END) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'ORDER_TRANSITION_DENIED';
END $$;
