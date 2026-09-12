ALTER TABLE kff.verified_payments ADD UNIQUE(id,connection_id,organization_id,brand_id);
CREATE TABLE kff.refund_ledgers (
 payment_id uuid PRIMARY KEY,organization_id uuid NOT NULL,brand_id uuid NOT NULL,connection_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),provider_charge_id text,remote_reserved_minor bigint NOT NULL DEFAULT 0 CHECK(remote_reserved_minor>=0),
 refund_blocked boolean NOT NULL DEFAULT false,synced_at timestamptz,snapshot_hash text,error_code text,
 next_check_at timestamptz NOT NULL DEFAULT now(),lease_token uuid,lease_until timestamptz,checks integer NOT NULL DEFAULT 0 CHECK(checks>=0),
 UNIQUE(payment_id,organization_id,brand_id),UNIQUE(payment_id,connection_id,organization_id,brand_id),
 FOREIGN KEY(payment_id,connection_id,organization_id,brand_id) REFERENCES kff.verified_payments(id,connection_id,organization_id,brand_id),CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE INDEX refund_ledger_due ON kff.refund_ledgers(next_check_at,lease_until);
CREATE TABLE kff.refund_requests (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,brand_id uuid NOT NULL,payment_id uuid NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 provider_request jsonb NOT NULL,provider_refund_id text,submitted_at timestamptz,
 state text NOT NULL DEFAULT 'READY' CHECK(state IN ('READY','SUBMITTING','PENDING','REQUIRES_ACTION','SUCCEEDED','FAILED','CANCELED','NEEDS_HUMAN')),
 error_code text,request_id uuid NOT NULL,request_hash text NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id,brand_id),UNIQUE(id,payment_id,organization_id,brand_id),UNIQUE(brand_id,request_id),UNIQUE(payment_id,provider_refund_id),
 FOREIGN KEY(payment_id,organization_id,brand_id) REFERENCES kff.refund_ledgers(payment_id,organization_id,brand_id),
 FOREIGN KEY(created_by,brand_id) REFERENCES kff.memberships(user_id,brand_id)
);
CREATE INDEX refund_requests_payment ON kff.refund_requests(payment_id,state,created_at);
CREATE TABLE kff.stripe_refunds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,payment_id uuid NOT NULL,connection_id uuid NOT NULL,
 provider_refund_id text NOT NULL,provider_charge_id text NOT NULL,provider_intent_id text NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 request_id uuid,provider_status text NOT NULL CHECK(provider_status IN ('pending','requires_action','succeeded','failed','canceled','unknown')),
 failure_reason text,version integer NOT NULL DEFAULT 1 CHECK(version>0),proof jsonb NOT NULL,proof_hash text NOT NULL,observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,organization_id,brand_id),UNIQUE(id,payment_id,organization_id,brand_id),UNIQUE(connection_id,provider_refund_id),UNIQUE(payment_id,provider_refund_id),
 FOREIGN KEY(payment_id,connection_id,organization_id,brand_id) REFERENCES kff.refund_ledgers(payment_id,connection_id,organization_id,brand_id),
 FOREIGN KEY(request_id,payment_id,organization_id,brand_id) REFERENCES kff.refund_requests(id,payment_id,organization_id,brand_id)
);
CREATE INDEX stripe_refunds_payment ON kff.stripe_refunds(payment_id,provider_status);
CREATE TABLE kff.stripe_disputes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,payment_id uuid NOT NULL,connection_id uuid NOT NULL,
 provider_dispute_id text NOT NULL,provider_charge_id text NOT NULL,provider_intent_id text NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>=0),currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),provider_status text NOT NULL,
 is_charge_refundable boolean NOT NULL,reason text NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),proof jsonb NOT NULL,proof_hash text NOT NULL,observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,organization_id,brand_id),UNIQUE(id,payment_id,organization_id,brand_id),UNIQUE(connection_id,provider_dispute_id),
 FOREIGN KEY(payment_id,connection_id,organization_id,brand_id) REFERENCES kff.refund_ledgers(payment_id,connection_id,organization_id,brand_id)
);
CREATE INDEX stripe_disputes_payment ON kff.stripe_disputes(payment_id);
CREATE TABLE kff.financial_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,payment_id uuid NOT NULL,
 refund_id uuid,dispute_id uuid,object_version integer NOT NULL CHECK(object_version>0),proof jsonb NOT NULL,proof_hash text NOT NULL,source_event_id uuid,observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,organization_id,brand_id),UNIQUE(id,payment_id,organization_id,brand_id),UNIQUE(refund_id,object_version),UNIQUE(dispute_id,object_version),CHECK((refund_id IS NULL)<>(dispute_id IS NULL)),
 FOREIGN KEY(refund_id,payment_id,organization_id,brand_id) REFERENCES kff.stripe_refunds(id,payment_id,organization_id,brand_id),
 FOREIGN KEY(dispute_id,payment_id,organization_id,brand_id) REFERENCES kff.stripe_disputes(id,payment_id,organization_id,brand_id),
 FOREIGN KEY(source_event_id,organization_id,brand_id) REFERENCES kff.stripe_events(id,organization_id,brand_id)
);
CREATE INDEX financial_observations_payment ON kff.financial_observations(payment_id,observed_at);
CREATE TABLE kff.refund_postings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,payment_id uuid NOT NULL,refund_id uuid NOT NULL,observation_id uuid NOT NULL UNIQUE,
 amount_minor bigint NOT NULL CHECK(amount_minor<>0),kind text NOT NULL CHECK((kind='REFUND' AND amount_minor<0) OR (kind='REFUND_REVERSAL' AND amount_minor>0)),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(refund_id,payment_id,organization_id,brand_id) REFERENCES kff.stripe_refunds(id,payment_id,organization_id,brand_id),
 FOREIGN KEY(observation_id,payment_id,organization_id,brand_id) REFERENCES kff.financial_observations(id,payment_id,organization_id,brand_id)
);
CREATE INDEX refund_postings_payment ON kff.refund_postings(payment_id);
CREATE TABLE kff.dispute_balance_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,payment_id uuid NOT NULL,connection_id uuid NOT NULL,dispute_id uuid NOT NULL,
 provider_transaction_id text NOT NULL,amount_minor bigint NOT NULL,fee_minor bigint NOT NULL,net_minor bigint NOT NULL,currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 proof jsonb NOT NULL,proof_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(connection_id,provider_transaction_id),
 FOREIGN KEY(dispute_id,payment_id,organization_id,brand_id) REFERENCES kff.stripe_disputes(id,payment_id,organization_id,brand_id),
 FOREIGN KEY(payment_id,connection_id,organization_id,brand_id) REFERENCES kff.refund_ledgers(payment_id,connection_id,organization_id,brand_id),CHECK(amount_minor-fee_minor=net_minor)
);
CREATE INDEX dispute_balance_payment ON kff.dispute_balance_entries(payment_id);
CREATE TABLE kff.financial_adjustments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,brand_id uuid NOT NULL,payment_id uuid NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor<>0),currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),minor_unit_exponent integer NOT NULL CHECK(minor_unit_exponent BETWEEN 0 AND 6),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),evidence_ref text NOT NULL CHECK(length(evidence_ref) BETWEEN 1 AND 300),dispute_id uuid,reverses_id uuid UNIQUE,
 request_id uuid NOT NULL,request_hash text NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,organization_id,brand_id),UNIQUE(id,payment_id,organization_id,brand_id),UNIQUE(brand_id,request_id),UNIQUE(payment_id,evidence_ref),
 FOREIGN KEY(payment_id,organization_id,brand_id) REFERENCES kff.refund_ledgers(payment_id,organization_id,brand_id),
 FOREIGN KEY(dispute_id,payment_id,organization_id,brand_id) REFERENCES kff.stripe_disputes(id,payment_id,organization_id,brand_id),
 FOREIGN KEY(reverses_id,payment_id,organization_id,brand_id) REFERENCES kff.financial_adjustments(id,payment_id,organization_id,brand_id),
 FOREIGN KEY(created_by,brand_id) REFERENCES kff.memberships(user_id,brand_id)
);
CREATE INDEX financial_adjustments_payment ON kff.financial_adjustments(payment_id);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['refund_ledgers','refund_requests','stripe_refunds','stripe_disputes','financial_observations','refund_postings','dispute_balance_entries','financial_adjustments'] LOOP
  EXECUTE format('ALTER TABLE kff.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY scoped_access ON kff.%I TO kff_app USING (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid) WITH CHECK (organization_id=nullif(current_setting(''kff.organization_id'',true),'''')::uuid AND brand_id=nullif(current_setting(''kff.brand_id'',true),'''')::uuid)',tab);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON kff.%I TO kff_app',tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['financial_observations','refund_postings','dispute_balance_entries','financial_adjustments'] LOOP
  EXECUTE format('REVOKE UPDATE ON kff.%I FROM kff_app',tab);
  EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE ON kff.%I FOR EACH ROW EXECUTE FUNCTION kff.protect_owned_record()',tab);
 END LOOP;
END $$;
CREATE FUNCTION kff.initialize_refund_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO kff.refund_ledgers(payment_id,organization_id,brand_id,connection_id) VALUES(NEW.id,NEW.organization_id,NEW.brand_id,NEW.connection_id);RETURN NEW;
END $$;
CREATE TRIGGER payment_refund_ledger AFTER INSERT ON kff.verified_payments FOR EACH ROW EXECUTE FUNCTION kff.initialize_refund_ledger();
INSERT INTO kff.refund_ledgers(payment_id,organization_id,brand_id,connection_id) SELECT id,organization_id,brand_id,connection_id FROM kff.verified_payments;
CREATE FUNCTION kff.protect_refund_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.payment_id,NEW.organization_id,NEW.brand_id,NEW.connection_id) IS DISTINCT FROM ROW(OLD.payment_id,OLD.organization_id,OLD.brand_id,OLD.connection_id) OR NEW.version NOT IN (OLD.version,OLD.version+1) OR (OLD.provider_charge_id IS NOT NULL AND NEW.provider_charge_id IS DISTINCT FROM OLD.provider_charge_id) THEN RAISE EXCEPTION 'IMMUTABLE_REFUND_LEDGER';END IF;RETURN NEW;
END $$;
CREATE TRIGGER refund_ledger_identity BEFORE UPDATE ON kff.refund_ledgers FOR EACH ROW EXECUTE FUNCTION kff.protect_refund_ledger();
CREATE FUNCTION kff.protect_refund_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-ARRAY['state','error_code','provider_refund_id','submitted_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','error_code','provider_refund_id','submitted_at']) OR (OLD.provider_refund_id IS NOT NULL AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id) OR (OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at) THEN RAISE EXCEPTION 'IMMUTABLE_REFUND_REQUEST';END IF;RETURN NEW;
END $$;
CREATE TRIGGER refund_request_identity BEFORE UPDATE ON kff.refund_requests FOR EACH ROW EXECUTE FUNCTION kff.protect_refund_request();
CREATE FUNCTION kff.protect_stripe_financial_object() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='stripe_refunds' THEN
  IF (to_jsonb(NEW)-ARRAY['provider_status','failure_reason','version','proof','proof_hash','observed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['provider_status','failure_reason','version','proof','proof_hash','observed_at']) THEN RAISE EXCEPTION 'IMMUTABLE_REFUND_OBJECT';END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['amount_minor','currency','provider_status','is_charge_refundable','reason','version','proof','proof_hash','observed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['amount_minor','currency','provider_status','is_charge_refundable','reason','version','proof','proof_hash','observed_at']) THEN RAISE EXCEPTION 'IMMUTABLE_DISPUTE_OBJECT';END IF;
 END IF;
 IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'FINANCIAL_VERSION_CONFLICT';END IF;RETURN NEW;
END $$;
CREATE TRIGGER stripe_refund_identity BEFORE UPDATE ON kff.stripe_refunds FOR EACH ROW EXECUTE FUNCTION kff.protect_stripe_financial_object();
CREATE TRIGGER stripe_dispute_identity BEFORE UPDATE ON kff.stripe_disputes FOR EACH ROW EXECUTE FUNCTION kff.protect_stripe_financial_object();
CREATE FUNCTION kff.validate_refund_posting() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE refund_amount bigint; existing numeric; total numeric; original bigint; status text; BEGIN
 PERFORM payment_id FROM kff.refund_ledgers WHERE payment_id=NEW.payment_id FOR UPDATE;
 SELECT r.amount_minor,o.proof->>'status' INTO refund_amount,status FROM kff.stripe_refunds r JOIN kff.financial_observations o ON o.refund_id=r.id AND o.object_version=r.version WHERE r.id=NEW.refund_id AND o.id=NEW.observation_id FOR UPDATE OF r;
 IF refund_amount IS NULL OR abs(NEW.amount_minor)<>refund_amount THEN RAISE EXCEPTION 'REFUND_POSTING_PROOF_MISMATCH';END IF;
 SELECT coalesce(sum(amount_minor),0) INTO existing FROM kff.refund_postings WHERE refund_id=NEW.refund_id;
 IF (NEW.amount_minor<0 AND (status IS DISTINCT FROM 'succeeded' OR existing<>0)) OR (NEW.amount_minor>0 AND (status IS NULL OR status NOT IN ('pending','requires_action','failed','canceled') OR existing<>-refund_amount)) THEN RAISE EXCEPTION 'REFUND_POSTING_STATE_MISMATCH';END IF;
 SELECT amount_minor INTO original FROM kff.verified_payments WHERE id=NEW.payment_id;
 SELECT coalesce(sum(amount_minor),0)+NEW.amount_minor INTO total FROM kff.refund_postings WHERE payment_id=NEW.payment_id;
 IF total>0 OR -total>original THEN RAISE EXCEPTION 'REFUND_TOTAL_EXCEEDED';END IF;RETURN NEW;
END $$;
CREATE TRIGGER refund_posting_contract BEFORE INSERT ON kff.refund_postings FOR EACH ROW EXECUTE FUNCTION kff.validate_refund_posting();
CREATE FUNCTION kff.validate_financial_adjustment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM kff.verified_payments p WHERE p.id=NEW.payment_id AND p.currency=NEW.currency AND p.minor_unit_exponent=NEW.minor_unit_exponent) THEN RAISE EXCEPTION 'ADJUSTMENT_CURRENCY_MISMATCH';END IF;
 IF NEW.reverses_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM kff.financial_adjustments a WHERE a.id=NEW.reverses_id AND a.reverses_id IS NULL AND a.payment_id=NEW.payment_id AND a.amount_minor=-NEW.amount_minor) THEN RAISE EXCEPTION 'ADJUSTMENT_REVERSAL_MISMATCH';END IF;RETURN NEW;
END $$;
CREATE TRIGGER financial_adjustment_contract BEFORE INSERT ON kff.financial_adjustments FOR EACH ROW EXECUTE FUNCTION kff.validate_financial_adjustment();
