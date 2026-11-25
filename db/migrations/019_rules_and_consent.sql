-- Game rules players accept, and consent and privacy choices (SRS REG-007, REG-008).
BEGIN;

-- The approved rules text itself is stored and published, not only its fingerprint.
ALTER TABLE cycles ADD COLUMN rules_text text;

CREATE FUNCTION protect_rules_text() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('DRAFT','SUBMITTED') AND NEW.rules_text IS DISTINCT FROM OLD.rules_text THEN
    RAISE EXCEPTION 'the game rules cannot be changed after approval' USING ERRCODE = '23000';
  END IF;
  IF NEW.rules_text IS NOT NULL AND NEW.rules_sha256 IS DISTINCT FROM sha256(convert_to(NEW.rules_text, 'UTF8')) THEN
    RAISE EXCEPTION 'the game rules text must match its published fingerprint' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cycles_protect_rules_text BEFORE UPDATE ON cycles FOR EACH ROW EXECUTE FUNCTION protect_rules_text();

-- Which version of a campaign's rules each player accepted, and when. Permanent.
CREATE TABLE rule_acceptances (
  user_id       uuid NOT NULL REFERENCES users(id),
  cycle_id      uuid NOT NULL REFERENCES cycles(id),
  rules_sha256  bytea NOT NULL,
  accepted_at   timestamptz NOT NULL DEFAULT now(),
  ip            inet,
  PRIMARY KEY (user_id, cycle_id, rules_sha256)
);
CREATE TRIGGER rule_acceptances_append_only BEFORE UPDATE OR DELETE ON rule_acceptances FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Consent history: every grant or withdrawal is a new row; the latest per kind is current. Permanent.
CREATE TABLE consents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  kind        text NOT NULL CHECK (kind IN ('PRIVACY_POLICY','MARKETING')),
  granted     boolean NOT NULL,
  version     text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  ip          inet
);
CREATE INDEX consents_user ON consents (user_id, kind, recorded_at DESC);
CREATE TRIGGER consents_append_only BEFORE UPDATE OR DELETE ON consents FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMIT;
