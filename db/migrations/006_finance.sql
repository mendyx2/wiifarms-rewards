-- Operating expenses and daily reconciliation.
BEGIN;

-- Expenses are recorded, never edited: a mistake is corrected by a reversing entry.
CREATE TABLE operating_expenses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id      uuid REFERENCES cycles(id),          -- NULL = company overhead, not tied to one cycle
  category      text NOT NULL CHECK (category IN ('STAFF','TECHNOLOGY','MARKETING','LOGISTICS','LICENSING','PROFESSIONAL_FEES','PAYMENT_FEES','OTHER')),
  description   text NOT NULL CHECK (length(trim(description)) > 0),
  payee         text,
  amount_kobo   bigint NOT NULL CHECK (amount_kobo > 0),
  incurred_on   date NOT NULL,
  document_ref  text,
  recorded_by   uuid NOT NULL REFERENCES admin_users(id),
  reverses      uuid UNIQUE REFERENCES operating_expenses(id),   -- each entry can be reversed once
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER operating_expenses_append_only BEFORE UPDATE OR DELETE ON operating_expenses
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- A reversal must match the entry it reverses, and a reversal cannot itself be reversed.
CREATE FUNCTION check_expense_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  orig operating_expenses%ROWTYPE;
BEGIN
  IF NEW.reverses IS NOT NULL THEN
    SELECT * INTO orig FROM operating_expenses WHERE id = NEW.reverses;
    IF orig.reverses IS NOT NULL THEN
      RAISE EXCEPTION 'a reversal cannot itself be reversed' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF (NEW.amount_kobo, NEW.category, NEW.cycle_id) IS DISTINCT FROM (orig.amount_kobo, orig.category, orig.cycle_id) THEN
      RAISE EXCEPTION 'a reversal must have the same amount, category and cycle as the entry it reverses' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER operating_expenses_reversal BEFORE INSERT ON operating_expenses FOR EACH ROW EXECUTE FUNCTION check_expense_reversal();

ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check CHECK (kind IN (
  'TICKET_SALE','INSTANT_PRIZE','DRAW_PRIZE','PAYOUT','PAYOUT_REVERSAL','REFUND','FEE','TAX','ESCROW_FUNDING','ADJUSTMENT','EXPENSE','EXPENSE_REVERSAL'));

-- One reconciliation per calendar day (Nigerian time). It can be re-run until
-- Finance signs it off; after that it is permanent.
CREATE TABLE reconciliations (
  day             date PRIMARY KEY,
  figures         jsonb NOT NULL,      -- records, ledger and (if entered) statement totals
  statement       jsonb,               -- totals reported by the payment provider for the day
  status          text NOT NULL CHECK (status IN ('MATCHED','MISMATCH')),
  run_at          timestamptz NOT NULL DEFAULT now(),
  run_by          uuid REFERENCES admin_users(id),      -- NULL = scheduled run
  signed_off_by   uuid REFERENCES admin_users(id),
  signed_off_at   timestamptz,
  note            text,
  CHECK ((signed_off_by IS NULL) = (signed_off_at IS NULL)),
  -- A day that does not match can only be signed off with a written explanation.
  CHECK (signed_off_by IS NULL OR status = 'MATCHED' OR length(trim(coalesce(note, ''))) > 0)
);
CREATE FUNCTION enforce_reconciliation_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.signed_off_by IS NOT NULL THEN
    RAISE EXCEPTION 'a signed-off reconciliation cannot be changed or removed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reconciliations_rules BEFORE UPDATE OR DELETE ON reconciliations FOR EACH ROW EXECUTE FUNCTION enforce_reconciliation_rules();

COMMIT;
