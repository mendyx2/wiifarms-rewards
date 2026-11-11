-- Fix found by the Phase 2 load test: audit sequence numbers were handed out
-- BEFORE the chain lock was taken, so two simultaneous transactions could link
-- to the chain in a different order from their numbers, and verification then
-- reported a break that was not tampering.
--
-- Now the number is assigned inside the lock, directly after the previous
-- record, and is itself covered by the hash (so records cannot be reordered).
-- No environment holds audit data yet, so existing rows are not re-hashed.
BEGIN;

ALTER TABLE audit_log ALTER COLUMN seq DROP IDENTITY;

CREATE OR REPLACE FUNCTION audit_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prev_seq bigint;
  prev bytea;
BEGIN
  -- Held until the surrounding transaction ends: audit records are strictly ordered.
  PERFORM pg_advisory_xact_lock(hashtext('audit_log_chain'));
  SELECT seq, row_hash INTO prev_seq, prev FROM audit_log ORDER BY seq DESC LIMIT 1;
  NEW.seq := coalesce(prev_seq, 0) + 1;
  NEW.occurred_at := clock_timestamp();
  NEW.prev_hash := coalesce(prev, '\x00'::bytea);
  NEW.row_hash := sha256(
    NEW.prev_hash ||
    convert_to(jsonb_build_array(
      NEW.seq, (extract(epoch FROM NEW.occurred_at) * 1000000)::bigint, NEW.actor_type, NEW.actor_id, NEW.action,
      NEW.entity_type, NEW.entity_id, NEW.details, host(NEW.ip))::text, 'UTF8'));
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION audit_log_verify() RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE
  r audit_log%ROWTYPE;
  prev bytea := '\x00'::bytea;
  expected_seq bigint := 1;
BEGIN
  FOR r IN SELECT * FROM audit_log ORDER BY seq LOOP
    IF r.seq <> expected_seq OR r.prev_hash <> prev OR r.row_hash <> sha256(
         r.prev_hash ||
         convert_to(jsonb_build_array(
           r.seq, (extract(epoch FROM r.occurred_at) * 1000000)::bigint, r.actor_type, r.actor_id, r.action,
           r.entity_type, r.entity_id, r.details, host(r.ip))::text, 'UTF8')) THEN
      RETURN r.seq;
    END IF;
    prev := r.row_hash;
    expected_seq := expected_seq + 1;
  END LOOP;
  RETURN NULL;
END $$;

COMMIT;
