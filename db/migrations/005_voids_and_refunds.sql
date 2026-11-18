-- Cancelling ("voiding") a cycle and refunding individual purchases.
-- Both need two different people, and the database enforces it.
BEGIN;

-- Manual refunds wait for a second person before any money moves.
ALTER TABLE refunds DROP CONSTRAINT refunds_status_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_status_check
  CHECK (status IN ('AWAITING_APPROVAL','PENDING','SENT','CONFIRMED','FAILED','REJECTED'));
ALTER TABLE refunds
  ADD COLUMN order_id uuid REFERENCES orders(id),
  ADD COLUMN note text,
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN decision_reason text;
UPDATE refunds r SET order_id = p.order_id FROM payments p WHERE p.id = r.payment_id;
ALTER TABLE refunds ALTER COLUMN order_id SET NOT NULL;
-- A manual refund cannot be paid out until someone other than the requester approves it.
ALTER TABLE refunds ADD CONSTRAINT refunds_manual_needs_approval
  CHECK (requested_by IS NULL OR approved_by IS NOT NULL OR status IN ('AWAITING_APPROVAL','REJECTED'));
-- An order can be refunded at most once (a rejected request does not count).
CREATE UNIQUE INDEX refunds_one_per_order ON refunds (order_id) WHERE status <> 'REJECTED';

-- Once decided, a refund request cannot be reopened, re-decided or removed.
CREATE FUNCTION enforce_refund_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.payment_id, NEW.order_id, NEW.amount_kobo, NEW.reason, NEW.requested_by)
     IS DISTINCT FROM (OLD.payment_id, OLD.order_id, OLD.amount_kobo, OLD.reason, OLD.requested_by) THEN
    RAISE EXCEPTION 'a refund''s order, amount, reason and requester cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status, NEW.status) NOT IN (
       ('AWAITING_APPROVAL','CONFIRMED'), ('AWAITING_APPROVAL','PENDING'), ('AWAITING_APPROVAL','REJECTED'),
       ('PENDING','SENT'), ('PENDING','CONFIRMED'), ('SENT','CONFIRMED'), ('SENT','FAILED'), ('PENDING','FAILED')) THEN
    RAISE EXCEPTION 'refund cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refunds_rules BEFORE UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION enforce_refund_rules();
CREATE TRIGGER refunds_no_delete BEFORE DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Fix: the original rule "REVEALED exactly when revealed_at is set" made it
-- impossible to cancel a card that had already been revealed, although the
-- ticket transition rules allow REVEALED -> CANCELLED. A cancelled card keeps
-- the record of what it revealed; unrevealed states must have none.
ALTER TABLE tickets DROP CONSTRAINT tickets_check2;
ALTER TABLE tickets ADD CONSTRAINT tickets_revealed_has_time CHECK (status <> 'REVEALED' OR revealed_at IS NOT NULL);
ALTER TABLE tickets ADD CONSTRAINT tickets_unrevealed_has_no_time CHECK (status NOT IN ('UNSOLD','SOLD') OR revealed_at IS NULL);

-- Requests to cancel a cycle.
CREATE TABLE cycle_void_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id        uuid NOT NULL REFERENCES cycles(id),
  reason          text NOT NULL CHECK (length(trim(reason)) > 0),
  requested_by    uuid NOT NULL REFERENCES admin_users(id),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  decided_by      uuid REFERENCES admin_users(id),
  decided_at      timestamptz,
  decision_reason text,
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((status = 'PENDING') = (decided_by IS NULL))
);
-- At most one open or approved request per cycle.
CREATE UNIQUE INDEX cycle_void_requests_one_live ON cycle_void_requests (cycle_id) WHERE status IN ('PENDING','APPROVED');

CREATE FUNCTION enforce_void_request_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'PENDING' OR (NEW.cycle_id, NEW.reason, NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM (OLD.cycle_id, OLD.reason, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'a decided void request cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cycle_void_requests_rules BEFORE UPDATE ON cycle_void_requests FOR EACH ROW EXECUTE FUNCTION enforce_void_request_rules();
CREATE TRIGGER cycle_void_requests_no_delete BEFORE DELETE ON cycle_void_requests FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- No cycle can be cancelled without an approved request from two different people.
CREATE FUNCTION require_void_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'VOID' AND OLD.status <> 'VOID'
     AND NOT EXISTS (SELECT 1 FROM cycle_void_requests WHERE cycle_id = NEW.id AND status = 'APPROVED') THEN
    RAISE EXCEPTION 'a cycle can only be cancelled with an approved void request from two different people'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cycles_require_void_approval BEFORE UPDATE ON cycles FOR EACH ROW EXECUTE FUNCTION require_void_approval();

COMMIT;
