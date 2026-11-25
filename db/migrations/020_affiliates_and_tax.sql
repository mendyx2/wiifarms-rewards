-- The SRS affiliate model (section 13) and statutory deductions on winnings (PAY-009).
--
-- Affiliates replace customer referral commissions. A player no longer earns
-- anything for inviting friends (invite codes stay, for sharing). Earning
-- marketing fees is for authorised affiliates only: a separate application
-- with a verified identity, contact details, territory, a bank account in
-- their own verified name, the agreement and compliance training; Compliance
-- approves or rejects it and can suspend or end it. Each approved affiliate
-- has a unique attribution code (8 characters, so it can never be confused
-- with a player's 7-character invite code); sign-ups made with it are
-- attributed to the affiliate for good. Fees are a percentage of the sales
-- of attributed players in the affiliate's territory, paid from the
-- operator's share, and only while the fee programme is switched on, which
-- takes two people and the reference of the legal approval. There are no
-- downlines: an affiliate earns on the players they bring, nothing else.
BEGIN;

CREATE TABLE affiliates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL UNIQUE REFERENCES users(id),
  reference             text NOT NULL UNIQUE,                        -- AFF-000001
  attribution_code      text UNIQUE CHECK (attribution_code ~ '^[A-HJ-NP-Z2-9]{8}$'), -- issued on approval
  business_name         text NOT NULL CHECK (length(business_name) BETWEEN 2 AND 120),
  contact_email         text NOT NULL CHECK (contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  contact_phone         text NOT NULL,
  territory_state       text NOT NULL,
  territory_area        text CHECK (length(territory_area) <= 120),
  channels              text NOT NULL CHECK (length(channels) BETWEEN 2 AND 500), -- where they will market
  bank_account_id       uuid NOT NULL REFERENCES bank_accounts(id),
  agreement_version     text NOT NULL,
  agreement_accepted_at timestamptz NOT NULL,
  training_completed_at timestamptz NOT NULL,
  status                text NOT NULL DEFAULT 'APPLIED' CHECK (status IN ('APPLIED','APPROVED','REJECTED','SUSPENDED','TERMINATED')),
  decided_by            uuid REFERENCES admin_users(id),
  decided_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'APPLIED') = (decided_by IS NULL)),
  CHECK (status IN ('APPLIED','REJECTED') OR attribution_code IS NOT NULL)
);
CREATE SEQUENCE affiliate_reference_seq;

-- Every status change, permanently (AFF-012).
CREATE TABLE affiliate_history (
  id            bigserial PRIMARY KEY,
  affiliate_id  uuid NOT NULL REFERENCES affiliates(id),
  status        text NOT NULL,
  by_admin      uuid REFERENCES admin_users(id),
  reason        text,
  at            timestamptz NOT NULL DEFAULT now()
);

-- The attribution code cannot change once issued; nor can the identity or bank details of an application.
CREATE FUNCTION protect_affiliate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DELETE on affiliates is not allowed'; END IF;
  IF OLD.attribution_code IS NOT NULL AND NEW.attribution_code IS DISTINCT FROM OLD.attribution_code THEN
    RAISE EXCEPTION 'an attribution code cannot be changed once issued' USING ERRCODE = '23000';
  END IF;
  IF (NEW.user_id, NEW.reference, NEW.bank_account_id, NEW.agreement_version, NEW.created_at) IS DISTINCT FROM (OLD.user_id, OLD.reference, OLD.bank_account_id, OLD.agreement_version, OLD.created_at) THEN
    RAISE EXCEPTION 'the applicant, reference, bank account and agreement of an affiliate cannot be changed' USING ERRCODE = '23000';
  END IF;
  IF OLD.status IN ('TERMINATED','REJECTED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a rejected or terminated affiliate cannot be reinstated; a new application is needed' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER affiliates_protect BEFORE UPDATE OR DELETE ON affiliates FOR EACH ROW EXECUTE FUNCTION protect_affiliate();

-- Which affiliate brought a player: set when the account is opened, never changed.
ALTER TABLE users ADD COLUMN affiliate_id uuid REFERENCES affiliates(id);
CREATE INDEX users_affiliate ON users (affiliate_id) WHERE affiliate_id IS NOT NULL;
CREATE FUNCTION protect_attribution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.affiliate_id IS DISTINCT FROM OLD.affiliate_id THEN
    RAISE EXCEPTION 'which affiliate brought an account is set when it is opened and cannot be changed' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_protect_attribution BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION protect_attribution();

-- The fee programme: off until two people switch it on with the legal approval's reference.
CREATE TABLE affiliate_programme (
  id                   boolean PRIMARY KEY DEFAULT true CHECK (id),
  remuneration_enabled boolean NOT NULL DEFAULT false,
  rate_bp              integer NOT NULL DEFAULT 250 CHECK (rate_bp BETWEEN 0 AND 500), -- the SRS proposes 2.5%–5%
  legal_reference      text,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT remuneration_enabled OR legal_reference IS NOT NULL)
);
INSERT INTO affiliate_programme DEFAULT VALUES;

CREATE TABLE affiliate_programme_changes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enable           boolean NOT NULL,
  rate_bp          integer NOT NULL CHECK (rate_bp BETWEEN 0 AND 500),
  legal_reference  text,
  reason           text NOT NULL,
  requested_by     uuid NOT NULL REFERENCES admin_users(id),
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  decided_by       uuid REFERENCES admin_users(id),
  decided_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((status = 'PENDING') = (decided_by IS NULL)),
  CHECK (NOT enable OR legal_reference IS NOT NULL)
);
CREATE UNIQUE INDEX affiliate_programme_one_open ON affiliate_programme_changes ((true)) WHERE status = 'PENDING';

-- Every attributed purchase, with the fee it earned (0 while fees are off: the sales are still recorded).
CREATE TABLE affiliate_settlements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id   uuid NOT NULL REFERENCES affiliates(id),
  amount_kobo    bigint NOT NULL CHECK (amount_kobo > 0),
  fees_count     integer NOT NULL CHECK (fees_count > 0),
  period_to      timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','PAID','REJECTED')),
  prepared_by    uuid NOT NULL REFERENCES admin_users(id),
  decided_by     uuid REFERENCES admin_users(id),
  decided_at     timestamptz,
  payment_ref    text,
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (decided_by IS NULL OR decided_by <> prepared_by),
  CHECK ((status = 'PROPOSED') = (decided_by IS NULL)),
  CHECK ((status = 'PAID') = (payment_ref IS NOT NULL))
);
CREATE UNIQUE INDEX affiliate_settlements_one_open ON affiliate_settlements (affiliate_id) WHERE status = 'PROPOSED';

CREATE TABLE affiliate_fees (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL UNIQUE REFERENCES orders(id),
  affiliate_id   uuid NOT NULL REFERENCES affiliates(id),
  buyer_id       uuid NOT NULL REFERENCES users(id),
  cycle_id       uuid NOT NULL REFERENCES cycles(id),
  cards          integer NOT NULL CHECK (cards > 0),
  sales_kobo     bigint NOT NULL CHECK (sales_kobo > 0),
  rate_bp        integer NOT NULL CHECK (rate_bp BETWEEN 0 AND 500),
  amount_kobo    bigint NOT NULL CHECK (amount_kobo >= 0),
  status         text NOT NULL DEFAULT 'ACCRUED' CHECK (status IN ('ACCRUED','REVERSED')),
  settlement_id  uuid REFERENCES affiliate_settlements(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  reversed_at    timestamptz,
  CHECK ((status = 'REVERSED') = (reversed_at IS NOT NULL))
);
CREATE INDEX affiliate_fees_affiliate ON affiliate_fees (affiliate_id, created_at DESC);

-- A fee only ever gets reversed or linked to (or unlinked from a rejected) settlement; it is never deleted.
CREATE FUNCTION protect_affiliate_fee() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DELETE on affiliate_fees is not allowed: table is append-only'; END IF;
  IF (NEW.order_id, NEW.affiliate_id, NEW.buyer_id, NEW.cycle_id, NEW.cards, NEW.sales_kobo, NEW.rate_bp, NEW.amount_kobo, NEW.created_at)
     IS DISTINCT FROM (OLD.order_id, OLD.affiliate_id, OLD.buyer_id, OLD.cycle_id, OLD.cards, OLD.sales_kobo, OLD.rate_bp, OLD.amount_kobo, OLD.created_at)
     OR (OLD.status = 'REVERSED' AND NEW.status <> 'REVERSED') THEN
    RAISE EXCEPTION 'an affiliate fee can only be reversed or settled' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER affiliate_fees_protect BEFORE UPDATE OR DELETE ON affiliate_fees FOR EACH ROW EXECUTE FUNCTION protect_affiliate_fee();

-- Statutory deductions on winnings: the rate is fixed on the cycle when it is created (and
-- published in its rules); every cash award records its gross, deduction and net.
ALTER TABLE cycles ADD COLUMN winnings_tax_bp integer NOT NULL DEFAULT 0 CHECK (winnings_tax_bp BETWEEN 0 AND 5000);
CREATE FUNCTION protect_tax_rate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.winnings_tax_bp IS DISTINCT FROM OLD.winnings_tax_bp AND OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'the deduction rate on winnings is fixed once a cycle is approved' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cycles_protect_tax_rate BEFORE UPDATE ON cycles FOR EACH ROW EXECUTE FUNCTION protect_tax_rate();

CREATE TABLE prize_deductions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       uuid NOT NULL REFERENCES tickets(id),
  stage           text NOT NULL CHECK (stage IN ('INSTANT','FINAL_DRAW')),
  user_id         uuid NOT NULL REFERENCES users(id),
  cycle_id        uuid NOT NULL REFERENCES cycles(id),
  gross_kobo      bigint NOT NULL CHECK (gross_kobo > 0),
  rate_bp         integer NOT NULL CHECK (rate_bp BETWEEN 0 AND 5000),
  deduction_kobo  bigint NOT NULL CHECK (deduction_kobo >= 0),
  net_kobo        bigint NOT NULL CHECK (net_kobo > 0),
  status          text NOT NULL DEFAULT 'DEDUCTED' CHECK (status IN ('DEDUCTED','REVERSED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  reversed_at     timestamptz,
  UNIQUE (ticket_id, stage),
  CHECK (gross_kobo = deduction_kobo + net_kobo),
  CHECK ((status = 'REVERSED') = (reversed_at IS NOT NULL))
);
CREATE INDEX prize_deductions_created ON prize_deductions (created_at);
CREATE FUNCTION protect_deduction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DELETE on prize_deductions is not allowed: table is append-only'; END IF;
  IF OLD.status <> 'DEDUCTED' OR NEW.status <> 'REVERSED' OR (NEW.ticket_id, NEW.stage, NEW.user_id, NEW.cycle_id, NEW.gross_kobo, NEW.rate_bp, NEW.deduction_kobo, NEW.net_kobo, NEW.created_at)
     IS DISTINCT FROM (OLD.ticket_id, OLD.stage, OLD.user_id, OLD.cycle_id, OLD.gross_kobo, OLD.rate_bp, OLD.deduction_kobo, OLD.net_kobo, OLD.created_at) THEN
    RAISE EXCEPTION 'a recorded deduction can only be reversed' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prize_deductions_protect BEFORE UPDATE OR DELETE ON prize_deductions FOR EACH ROW EXECUTE FUNCTION protect_deduction();

ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check CHECK (kind IN (
  'TICKET_SALE','INSTANT_PRIZE','DRAW_PRIZE','PAYOUT','PAYOUT_REVERSAL','REFUND','FEE','TAX','ESCROW_FUNDING','ADJUSTMENT','EXPENSE','EXPENSE_REVERSAL',
  'REFERRAL_COMMISSION','REFERRAL_REVERSAL','AFFILIATE_FEE','AFFILIATE_FEE_REVERSAL','AFFILIATE_SETTLEMENT','TAX_REVERSAL'));

COMMIT;
