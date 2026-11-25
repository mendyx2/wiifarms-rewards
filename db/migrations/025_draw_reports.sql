-- The independent draw report (SRS DRW-010). Generated once after the draw
-- from the records alone; it re-checks every step (the frozen register, the
-- reconciliation of entries, the committed secret, the seed, a re-run of the
-- draw, the multiple-win rule, the sign-offs) and is fingerprinted (SHA-256 of
-- its canonical form). The cycle's appointed auditor then attests to that
-- exact fingerprint. Neither the report nor the attestation can be changed.
BEGIN;

CREATE TABLE draw_reports (
  cycle_id       uuid PRIMARY KEY REFERENCES draws(cycle_id),
  report         jsonb NOT NULL,
  sha256         bytea NOT NULL CHECK (octet_length(sha256) = 32),
  all_checks_pass boolean NOT NULL,
  generated_by   uuid NOT NULL REFERENCES admin_users(id),
  generated_at   timestamptz NOT NULL DEFAULT now(),
  attested_by    uuid REFERENCES admin_users(id),
  attested_sha256 bytea,
  attestation    text CHECK (length(attestation) <= 2000),
  attested_at    timestamptz,
  CHECK ((attested_by IS NULL) = (attested_at IS NULL) AND (attested_by IS NULL) = (attested_sha256 IS NULL) AND (attested_by IS NULL) = (attestation IS NULL)),
  CHECK (attested_sha256 IS NULL OR attested_sha256 = sha256)
);

CREATE FUNCTION protect_draw_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DELETE on draw_reports is not allowed'; END IF;
  IF (NEW.cycle_id, NEW.report, NEW.sha256, NEW.all_checks_pass, NEW.generated_by, NEW.generated_at)
     IS DISTINCT FROM (OLD.cycle_id, OLD.report, OLD.sha256, OLD.all_checks_pass, OLD.generated_by, OLD.generated_at)
     OR OLD.attested_by IS NOT NULL THEN
    RAISE EXCEPTION 'a draw report cannot be changed, and an attestation is final' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER draw_reports_protect BEFORE UPDATE OR DELETE ON draw_reports FOR EACH ROW EXECUTE FUNCTION protect_draw_report();

COMMIT;
