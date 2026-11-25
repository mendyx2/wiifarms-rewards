-- Stockist fulfilment (SRS section 14, STK-001 to STK-012).
--
-- Authorised collection centres: Mega Stockists (regional), Sub Stockists
-- (local, under a Mega Stockist) and specialist partners (vehicles,
-- appliances). Fulfilment registers a centre, Compliance approves it. Staff of
-- a centre sign in to the admin app with the STOCKIST role, which can be held
-- with no other role and only by someone linked to a centre.
--
-- Prize units keep their separate prize-stock records (reserved to a cycle);
-- where a unit physically is (warehouse or centre) is tracked separately, and
-- every move is kept. A winner who collects chooses a centre; dispatching moves
-- the unit there and issues a digital voucher (a reference plus the one-time
-- handover code only the winner sees). The centre verifies the voucher and the
-- winner's identity, records proof (photo) and hands over; a voucher can be
-- redeemed once. Each handover earns the centre its approved fee, invoiced and
-- paid after Finance approves.
BEGIN;

CREATE TABLE stockists (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE,                        -- STK-0001
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  tier             text NOT NULL CHECK (tier IN ('MEGA','SUB','SPECIALIST')),
  parent_id        uuid REFERENCES stockists(id),
  state_code       text NOT NULL,
  area             text NOT NULL CHECK (length(area) BETWEEN 2 AND 120),
  address          text NOT NULL CHECK (length(address) BETWEEN 5 AND 300),
  phone            text NOT NULL,
  coverage         text[] NOT NULL DEFAULT '{}',               -- local government areas served
  opening_hours    text,
  fee_kobo         bigint NOT NULL CHECK (fee_kobo >= 0),       -- approved fee per prize handed over
  pending_fee_kobo bigint CHECK (pending_fee_kobo >= 0),
  fee_requested_by uuid REFERENCES admin_users(id),
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','SUSPENDED','REJECTED')),
  registered_by    uuid NOT NULL REFERENCES admin_users(id),
  approved_by      uuid REFERENCES admin_users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by IS NULL OR approved_by <> registered_by),
  CHECK (status IN ('PENDING','REJECTED') OR approved_by IS NOT NULL),
  CHECK ((tier = 'SUB') = (parent_id IS NOT NULL)),
  CHECK ((pending_fee_kobo IS NULL) = (fee_requested_by IS NULL))
);
CREATE SEQUENCE stockist_code_seq;

-- The centre a STOCKIST account belongs to.
ALTER TABLE admin_users ADD COLUMN stockist_id uuid REFERENCES stockists(id);

ALTER TABLE admin_roles DROP CONSTRAINT admin_roles_role_check;
ALTER TABLE admin_roles ADD CONSTRAINT admin_roles_role_check CHECK (role IN (
  'CYCLE_MANAGER','FINANCE','PAYOUT_APPROVER','FULFILMENT','SUPPORT','COMPLIANCE','AUDITOR','SECURITY_ADMIN','STOCKIST'));
ALTER TABLE admin_access_requests DROP CONSTRAINT admin_access_requests_role_check;
ALTER TABLE admin_access_requests ADD CONSTRAINT admin_access_requests_role_check CHECK (role IN (
  'CYCLE_MANAGER','FINANCE','PAYOUT_APPROVER','FULFILMENT','SUPPORT','COMPLIANCE','AUDITOR','SECURITY_ADMIN','STOCKIST'));

-- A stockist's staff hold no other role, and must belong to a centre.
CREATE OR REPLACE FUNCTION check_role_conflicts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  conflict boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM admin_roles r
    WHERE r.admin_user_id = NEW.admin_user_id
      AND (
        (NEW.role = 'FINANCE'         AND r.role = 'PAYOUT_APPROVER') OR
        (NEW.role = 'PAYOUT_APPROVER' AND r.role = 'FINANCE') OR
        (NEW.role = 'AUDITOR'         AND r.role <> 'AUDITOR') OR
        (NEW.role <> 'AUDITOR'        AND r.role = 'AUDITOR') OR
        (NEW.role = 'SECURITY_ADMIN'  AND r.role <> 'SECURITY_ADMIN') OR
        (NEW.role <> 'SECURITY_ADMIN' AND r.role = 'SECURITY_ADMIN') OR
        (NEW.role = 'STOCKIST'        AND r.role <> 'STOCKIST') OR
        (NEW.role <> 'STOCKIST'       AND r.role = 'STOCKIST')
      )
  ) INTO conflict;
  IF conflict THEN
    RAISE EXCEPTION 'role % conflicts with a role this administrator already holds', NEW.role
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.role = 'STOCKIST' AND NOT EXISTS (SELECT 1 FROM admin_users WHERE id = NEW.admin_user_id AND stockist_id IS NOT NULL) THEN
    RAISE EXCEPTION 'the stockist role is only for staff linked to a collection centre' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

-- Where each prize unit physically is (NULL = the company warehouse), and every move.
ALTER TABLE stock_units ADD COLUMN stockist_id uuid REFERENCES stockists(id);
CREATE INDEX stock_units_stockist ON stock_units (stockist_id) WHERE stockist_id IS NOT NULL;
CREATE TABLE stock_movements (
  id             bigserial PRIMARY KEY,
  stock_unit_id  uuid NOT NULL REFERENCES stock_units(id),
  from_stockist  uuid REFERENCES stockists(id),
  to_stockist    uuid REFERENCES stockists(id),
  reason         text NOT NULL,
  moved_by       uuid NOT NULL REFERENCES admin_users(id),
  moved_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (from_stockist IS DISTINCT FROM to_stockist)
);
CREATE TRIGGER stock_movements_no_update BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- A unit's location changes only with a recorded move.
CREATE FUNCTION require_stock_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stockist_id IS DISTINCT FROM OLD.stockist_id AND NOT EXISTS (
       SELECT 1 FROM stock_movements m WHERE m.stock_unit_id = NEW.id AND m.to_stockist IS NOT DISTINCT FROM NEW.stockist_id
         AND m.from_stockist IS NOT DISTINCT FROM OLD.stockist_id AND m.moved_at = now()) THEN
    RAISE EXCEPTION 'a prize unit can only be moved with a recorded stock movement' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_units_movement BEFORE UPDATE ON stock_units FOR EACH ROW EXECUTE FUNCTION require_stock_movement();

-- Collection at a centre: the digital voucher, and the proof recorded at handover.
ALTER TABLE shipments
  ADD COLUMN stockist_id uuid REFERENCES stockists(id),
  ADD COLUMN voucher_ref text UNIQUE,
  ADD COLUMN id_checked text CHECK (id_checked IN ('NIN_SLIP','VOTERS_CARD','DRIVERS_LICENCE','PASSPORT','OTHER'));
CREATE TABLE handover_proofs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id   uuid NOT NULL UNIQUE REFERENCES shipments(id),
  image         bytea NOT NULL CHECK (octet_length(image) <= 1048576),
  content_type  text NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
  sha256        bytea NOT NULL,
  recorded_by   uuid NOT NULL REFERENCES admin_users(id),
  recorded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER handover_proofs_no_update BEFORE UPDATE OR DELETE ON handover_proofs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Damaged, missing or wrong merchandise (STK-010).
CREATE TABLE stock_incidents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stockist_id    uuid REFERENCES stockists(id),
  stock_unit_id  uuid NOT NULL REFERENCES stock_units(id),
  kind           text NOT NULL CHECK (kind IN ('DAMAGED','MISSING','WRONG_ITEM','OTHER')),
  description    text NOT NULL CHECK (length(description) BETWEEN 5 AND 2000),
  status         text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  resolution     text,
  reported_by    uuid NOT NULL REFERENCES admin_users(id),
  resolved_by    uuid REFERENCES admin_users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  CHECK ((status = 'RESOLVED') = (resolution IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)),
  CHECK (resolved_by IS NULL OR resolved_by <> reported_by)
);
-- While an incident is open, the unit cannot be handed over.
CREATE UNIQUE INDEX stock_incidents_one_open ON stock_incidents (stock_unit_id) WHERE status = 'OPEN';

-- Invoices from centres for their fees (STK-009, STK-011).
CREATE TABLE stockist_invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stockist_id   uuid NOT NULL REFERENCES stockists(id),
  reference     text NOT NULL UNIQUE,
  their_reference text,
  amount_kobo   bigint NOT NULL CHECK (amount_kobo > 0),
  fees_count    integer NOT NULL CHECK (fees_count > 0),
  status        text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','PAID','REJECTED')),
  submitted_by  uuid NOT NULL REFERENCES admin_users(id),
  decided_by    uuid REFERENCES admin_users(id),
  decided_at    timestamptz,
  payment_ref   text,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (decided_by IS NULL OR decided_by <> submitted_by),
  CHECK ((status = 'SUBMITTED') = (decided_by IS NULL)),
  CHECK ((status = 'PAID') = (payment_ref IS NOT NULL))
);
CREATE SEQUENCE stockist_invoice_seq;
CREATE UNIQUE INDEX stockist_invoices_one_open ON stockist_invoices (stockist_id) WHERE status = 'SUBMITTED';

CREATE TABLE stockist_fees (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id   uuid NOT NULL UNIQUE REFERENCES shipments(id),   -- one fee per handover
  stockist_id   uuid NOT NULL REFERENCES stockists(id),
  cycle_id      uuid NOT NULL REFERENCES cycles(id),
  amount_kobo   bigint NOT NULL CHECK (amount_kobo > 0),
  invoice_id    uuid REFERENCES stockist_invoices(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION protect_stockist_fee() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (NEW.shipment_id, NEW.stockist_id, NEW.cycle_id, NEW.amount_kobo, NEW.created_at)
     IS DISTINCT FROM (OLD.shipment_id, OLD.stockist_id, OLD.cycle_id, OLD.amount_kobo, OLD.created_at) THEN
    RAISE EXCEPTION 'a stockist fee can only be invoiced' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stockist_fees_protect BEFORE UPDATE OR DELETE ON stockist_fees FOR EACH ROW EXECUTE FUNCTION protect_stockist_fee();

ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check CHECK (kind IN (
  'TICKET_SALE','INSTANT_PRIZE','DRAW_PRIZE','PAYOUT','PAYOUT_REVERSAL','REFUND','FEE','TAX','ESCROW_FUNDING','ADJUSTMENT','EXPENSE','EXPENSE_REVERSAL',
  'REFERRAL_COMMISSION','REFERRAL_REVERSAL','AFFILIATE_FEE','AFFILIATE_FEE_REVERSAL','AFFILIATE_SETTLEMENT','TAX_REVERSAL','STOCKIST_FEE','STOCKIST_SETTLEMENT'));

COMMIT;
