-- Staff access changes and licence/certification records, each needing two people.
BEGIN;

-- Licences and certifications only count towards the real-money gate once a
-- second person has verified them, and stop counting when revoked.
ALTER TABLE licences
  ADD COLUMN status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFIED','REVOKED')),
  ADD COLUMN verified_by uuid REFERENCES admin_users(id), ADD COLUMN verified_at timestamptz,
  ADD COLUMN revoked_by uuid REFERENCES admin_users(id), ADD COLUMN revoked_at timestamptz, ADD COLUMN revoke_reason text,
  ADD CONSTRAINT licences_verifier_differs CHECK (verified_by IS NULL OR verified_by <> recorded_by),
  ADD CONSTRAINT licences_verified_has_verifier CHECK (status <> 'VERIFIED' OR verified_by IS NOT NULL),
  ADD CONSTRAINT licences_revoked_has_reason CHECK (status <> 'REVOKED' OR (revoked_by IS NOT NULL AND length(trim(coalesce(revoke_reason, ''))) > 0));
ALTER TABLE certifications
  ADD COLUMN status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFIED','REVOKED')),
  ADD COLUMN verified_by uuid REFERENCES admin_users(id), ADD COLUMN verified_at timestamptz,
  ADD COLUMN revoked_by uuid REFERENCES admin_users(id), ADD COLUMN revoked_at timestamptz, ADD COLUMN revoke_reason text,
  ADD CONSTRAINT certifications_verifier_differs CHECK (verified_by IS NULL OR verified_by <> recorded_by),
  ADD CONSTRAINT certifications_verified_has_verifier CHECK (status <> 'VERIFIED' OR verified_by IS NOT NULL),
  ADD CONSTRAINT certifications_revoked_has_reason CHECK (status <> 'REVOKED' OR (revoked_by IS NOT NULL AND length(trim(coalesce(revoke_reason, ''))) > 0));

-- The record itself never changes; only PENDING -> VERIFIED/REVOKED and VERIFIED -> REVOKED.
CREATE FUNCTION protect_compliance_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'licence and certification records cannot be deleted; revoke them instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','verified_by','verified_at','revoked_by','revoked_at','revoke_reason'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','verified_by','verified_at','revoked_by','revoked_at','revoke_reason'])
     OR (NEW.status <> OLD.status AND (OLD.status, NEW.status) NOT IN (('PENDING','VERIFIED'), ('PENDING','REVOKED'), ('VERIFIED','REVOKED')))
     OR (OLD.verified_by IS NOT NULL AND NEW.verified_by IS DISTINCT FROM OLD.verified_by) THEN
    RAISE EXCEPTION 'this record cannot be changed (it can only be verified once, or revoked)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER licences_protect BEFORE UPDATE OR DELETE ON licences FOR EACH ROW EXECUTE FUNCTION protect_compliance_record();
CREATE TRIGGER certifications_protect BEFORE UPDATE OR DELETE ON certifications FOR EACH ROW EXECUTE FUNCTION protect_compliance_record();

-- Added to the original gate: real-money sales need a VERIFIED, unrevoked licence and certification.
CREATE FUNCTION require_verified_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'OPEN' AND OLD.status <> 'OPEN' AND NEW.mode = 'REAL_MONEY' THEN
    IF NOT EXISTS (SELECT 1 FROM licences l WHERE l.state_code = NEW.state_code AND l.status = 'VERIFIED'
                   AND current_date BETWEEN l.valid_from AND l.valid_to) THEN
      RAISE EXCEPTION 'no verified licence for % — real-money sales cannot open', NEW.state_code USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM certifications ce JOIN cycle_commitments cc ON cc.cycle_id = NEW.id
                   WHERE ce.component = 'GAME_CORE' AND ce.component_version = cc.game_core_version AND ce.status = 'VERIFIED'
                     AND current_date >= ce.valid_from AND (ce.valid_to IS NULL OR current_date <= ce.valid_to)) THEN
      RAISE EXCEPTION 'game core version has no verified certification — real-money sales cannot open' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cycles_require_verified_gate BEFORE UPDATE ON cycles FOR EACH ROW EXECUTE FUNCTION require_verified_gate();

-- Requests to change someone's access. A different security administrator decides.
CREATE TABLE admin_access_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id   uuid NOT NULL REFERENCES admin_users(id),
  action          text NOT NULL CHECK (action IN ('GRANT_ROLE','REVOKE_ROLE','ENABLE')),
  role            text CHECK (role IN ('CYCLE_MANAGER','FINANCE','PAYOUT_APPROVER','FULFILMENT','SUPPORT','COMPLIANCE','AUDITOR','SECURITY_ADMIN')),
  reason          text NOT NULL CHECK (length(trim(reason)) > 0),
  requested_by    uuid NOT NULL REFERENCES admin_users(id),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  decided_by      uuid REFERENCES admin_users(id),
  decided_at      timestamptz,
  decision_reason text,
  CHECK ((action = 'ENABLE') = (role IS NULL)),
  CHECK (requested_by <> admin_user_id),                       -- nobody asks to change their own access
  CHECK (decided_by IS NULL OR (decided_by <> requested_by AND decided_by <> admin_user_id)),
  CHECK ((status = 'PENDING') = (decided_by IS NULL))
);
CREATE UNIQUE INDEX admin_access_requests_one_open ON admin_access_requests (admin_user_id, action, coalesce(role, '')) WHERE status = 'PENDING';
CREATE FUNCTION protect_access_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'PENDING'
     OR (NEW.admin_user_id, NEW.action, NEW.role, NEW.reason, NEW.requested_by, NEW.requested_at)
        IS DISTINCT FROM (OLD.admin_user_id, OLD.action, OLD.role, OLD.reason, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'access requests cannot be changed once decided' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admin_access_requests_protect BEFORE UPDATE OR DELETE ON admin_access_requests FOR EACH ROW EXECUTE FUNCTION protect_access_request();

ALTER TABLE admin_users ADD COLUMN disabled_at timestamptz, ADD COLUMN disabled_by uuid REFERENCES admin_users(id);

COMMIT;
