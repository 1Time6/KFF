-- Index the existing event ledger; do not create a second intake queue.
CREATE INDEX facebook_ingress_account_window ON kff.inbound_events((split_part(source_key,'/',1)),received_at) WHERE source_kind='facebook';
CREATE INDEX lead_messages_period ON kff.messages(received_at,conversation_id,direction);
CREATE INDEX lead_referral_period ON kff.whatsapp_referrals(sent_at,customer_id) WHERE sent_at IS NOT NULL;
CREATE INDEX lead_audit_period ON kff.audit_events(brand_id,created_at DESC,id DESC);
CREATE FUNCTION kff.check_reception_payload_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.kind='RECEPTION' AND NOT EXISTS(
  SELECT 1 FROM kff.conversations v JOIN kff.messages m ON m.conversation_id=v.id
  JOIN kff.facebook_connections f ON f.account_id=v.account_id JOIN kff.environments e ON e.id=f.environment_id
  WHERE v.id=NEW.conversation_id AND m.id=NEW.message_id AND m.direction='INBOUND' AND m.message_kind='MESSAGE'
  AND NEW.payload->>'conversation_id'=v.id::text AND NEW.payload->>'message_id'=m.id::text
  AND NEW.payload->>'account_id'=v.account_id::text AND NEW.payload->>'organization_id'=v.organization_id::text
  AND NEW.payload->>'brand_id'=v.brand_id::text AND NEW.payload->>'agent_id'=e.agent_id::text
  AND NEW.payload->>'actor_id'=f.created_by::text AND (NEW.payload->>'trigger_sequence')::int=m.sequence
 ) THEN RAISE EXCEPTION 'RECEPTION_PAYLOAD_SCOPE_MISMATCH'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reception_payload_scope BEFORE INSERT ON kff.jobs FOR EACH ROW EXECUTE FUNCTION kff.check_reception_payload_scope();
