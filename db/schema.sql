-- WiiFarm Rewards — core database design (Phase 1)
-- PostgreSQL 16. All money is integer kobo (bigint). All times are timestamptz (UTC).
--
-- The rules that protect players and the company are enforced HERE, in the
-- database, as well as in the application, so that a bug or a compromised
-- application server cannot break them:
--   * committed cycles, prize tiers and ticket outcomes cannot be changed
--   * a ticket is sold once, revealed once, claimed once
--   * ledger and audit rows cannot be edited or deleted, and every ledger
--     transaction balances to zero
--   * approvals and payouts need two different people
--
-- Not yet modelled (Phase 2): notifications, support tickets, sessions/devices.

BEGIN;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END $$;

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Players
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164        text NOT NULL UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  pin_hash          text,                         -- argon2id
  full_name         text,
  date_of_birth     date,
  kyc_tier          smallint NOT NULL DEFAULT 0 CHECK (kyc_tier BETWEEN 0 AND 2),
  -- Keyed hash (HMAC) of the verified NIN/BVN: enforces one account per person
  -- without storing the number in a searchable form.
  identity_hash     bytea UNIQUE,
  state_code        text,                         -- last confirmed state of residence/location, e.g. 'NG-NI'
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (kyc_tier = 0 OR (identity_hash IS NOT NULL AND date_of_birth IS NOT NULL AND full_name IS NOT NULL))
);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE kyc_verifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  kind            text NOT NULL CHECK (kind IN ('NIN','BVN','LIVENESS','LOCATION','SANCTIONS')),
  provider        text NOT NULL,
  provider_ref    text NOT NULL,
  result          text NOT NULL CHECK (result IN ('PASS','FAIL','REVIEW')),
  encrypted_payload bytea,                        -- field-level encrypted provider response
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);

CREATE TABLE next_of_kin (
  user_id         uuid PRIMARY KEY REFERENCES users(id),
  full_name       text NOT NULL,
  relationship    text NOT NULL,
  phone_e164      text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER next_of_kin_touch BEFORE UPDATE ON next_of_kin FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Responsible gaming. Limits cover total ticket spend across every payment method.
CREATE TABLE rg_limits (
  user_id             uuid PRIMARY KEY REFERENCES users(id),
  daily_kobo          bigint NOT NULL DEFAULT 500000   CHECK (daily_kobo   >= 0),   -- ₦5,000
  weekly_kobo         bigint NOT NULL DEFAULT 2000000  CHECK (weekly_kobo  >= 0),   -- ₦20,000
  monthly_kobo        bigint NOT NULL DEFAULT 5000000  CHECK (monthly_kobo >= 0),   -- ₦50,000
  -- A requested increase waits here until it takes effect (24h after request).
  pending_daily_kobo   bigint CHECK (pending_daily_kobo   >= 0),
  pending_weekly_kobo  bigint CHECK (pending_weekly_kobo  >= 0),
  pending_monthly_kobo bigint CHECK (pending_monthly_kobo >= 0),
  pending_effective_at timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (daily_kobo <= weekly_kobo AND weekly_kobo <= monthly_kobo)
);

CREATE TABLE self_exclusions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  kind        text NOT NULL CHECK (kind IN ('COOL_OFF','SELF_EXCLUSION')),
  starts_at   timestamptz NOT NULL DEFAULT now(),
  ends_at     timestamptz,                         -- NULL = indefinite
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
-- Exclusions can be added but never shortened or removed.
CREATE TRIGGER self_exclusions_append_only BEFORE UPDATE OR DELETE ON self_exclusions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Staff, contractors, auditors, supplier key staff and their households.
CREATE TABLE exclusion_register (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category        text NOT NULL CHECK (category IN ('STAFF','DIRECTOR','CONTRACTOR','AUDITOR','SUPPLIER','FAMILY')),
  identity_hash   bytea,
  phone_e164      text,
  bank_account_hash bytea,
  note            text,
  added_by        uuid NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (identity_hash IS NOT NULL OR phone_e164 IS NOT NULL OR bank_account_hash IS NOT NULL)
);

CREATE TABLE bank_accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id),
  bank_code         text NOT NULL,
  account_number_enc bytea NOT NULL,              -- field-level encrypted
  account_hash      bytea NOT NULL,               -- keyed hash, for duplicate/fraud matching
  resolved_name     text NOT NULL,                -- name returned by the bank
  name_match        boolean NOT NULL,             -- matches verified identity
  usable_from       timestamptz NOT NULL,         -- cooling-off after add/change
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REMOVED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, account_hash)
);

-- ---------------------------------------------------------------------------
-- Administrators, roles, approvals
-- ---------------------------------------------------------------------------

CREATE TABLE admin_users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  full_name   text NOT NULL,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_roles (
  admin_user_id uuid NOT NULL REFERENCES admin_users(id),
  role          text NOT NULL CHECK (role IN (
                  'CYCLE_MANAGER','FINANCE','PAYOUT_APPROVER','FULFILMENT',
                  'SUPPORT','COMPLIANCE','AUDITOR','SECURITY_ADMIN')),
  granted_by    uuid NOT NULL REFERENCES admin_users(id),
  granted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (admin_user_id, role),
  CHECK (granted_by <> admin_user_id)             -- nobody grants themselves a role
);

-- Separation of duties: combinations that would let one person both do and approve.
CREATE FUNCTION check_role_conflicts() RETURNS trigger LANGUAGE plpgsql AS $$
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
        (NEW.role <> 'SECURITY_ADMIN' AND r.role = 'SECURITY_ADMIN')
      )
  ) INTO conflict;
  IF conflict THEN
    RAISE EXCEPTION 'role % conflicts with a role this administrator already holds', NEW.role
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admin_roles_conflicts BEFORE INSERT ON admin_roles
  FOR EACH ROW EXECUTE FUNCTION check_role_conflicts();

-- ---------------------------------------------------------------------------
-- Compliance records that gate real-money sales
-- ---------------------------------------------------------------------------

CREATE TABLE licences (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_code    text NOT NULL,                    -- e.g. 'NG-NI' (Niger State)
  authority     text NOT NULL,
  licence_number text NOT NULL,
  valid_from    date NOT NULL,
  valid_to      date NOT NULL,
  document_ref  text NOT NULL,
  recorded_by   uuid NOT NULL REFERENCES admin_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to > valid_from),
  UNIQUE (state_code, licence_number)
);

CREATE TABLE certifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  component       text NOT NULL CHECK (component IN ('GAME_CORE','DRAW','PLATFORM_SECURITY')),
  component_version text NOT NULL,                -- e.g. git commit hash of game-core
  lab             text NOT NULL,
  certificate_ref text NOT NULL,
  valid_from      date NOT NULL,
  valid_to        date,
  recorded_by     uuid NOT NULL REFERENCES admin_users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Prize cycles
-- ---------------------------------------------------------------------------

CREATE TABLE cycles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  mode                text NOT NULL DEFAULT 'SIMULATED' CHECK (mode IN ('SIMULATED','REAL_MONEY')),
  state_code          text NOT NULL DEFAULT 'NG-NI',
  status              text NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
                        'DRAFT','SUBMITTED','APPROVED','COMMITTED','OPEN','CLOSED',
                        'DRAWN','SETTLING','ARCHIVED','VOID')),
  ticket_price_kobo   bigint NOT NULL CHECK (ticket_price_kobo > 0),
  total_tickets       integer NOT NULL CHECK (total_tickets > 0),
  max_tickets_per_account integer NOT NULL CHECK (max_tickets_per_account > 0),
  sales_open_at       timestamptz NOT NULL,
  sales_close_at      timestamptz NOT NULL,       -- latest close; sell-out closes earlier
  draw_at             timestamptz NOT NULL,
  claim_window_days   integer NOT NULL DEFAULT 90 CHECK (claim_window_days > 0),
  rules_document_ref  text,
  rules_sha256        bytea,
  -- Evidence required for approval
  financial_model_ref text,
  escrow_reference    text,                       -- escrow/trust holding the cash-prize cover
  escrow_funded_kobo  bigint CHECK (escrow_funded_kobo >= 0),
  auditor_admin_id    uuid REFERENCES admin_users(id),
  created_by          uuid NOT NULL REFERENCES admin_users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (sales_close_at > sales_open_at AND draw_at >= sales_close_at)
);

CREATE TABLE prize_tiers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id        uuid NOT NULL REFERENCES cycles(id),
  stage           text NOT NULL CHECK (stage IN ('INSTANT','FINAL_DRAW')),
  kind            text NOT NULL CHECK (kind IN ('CASH','MERCHANDISE')),
  outcome_code    text NOT NULL,                  -- e.g. 'CASH:100000' or 'SKU:<id>'
  title           text NOT NULL,
  cash_kobo       bigint CHECK (cash_kobo > 0),
  sku_id          uuid,                           -- FK added after skus is created
  quantity        integer NOT NULL CHECK (quantity > 0),
  draw_order      integer,                        -- final-draw prizes are drawn in this order
  UNIQUE (cycle_id, outcome_code),
  CHECK ((kind = 'CASH') = (cash_kobo IS NOT NULL)),
  CHECK ((kind = 'MERCHANDISE') = (sku_id IS NOT NULL)),
  CHECK ((stage = 'FINAL_DRAW') = (draw_order IS NOT NULL)),
  -- Instant prizes are cash only, ₦500–₦10,000 (brief section 2).
  CHECK (stage <> 'INSTANT' OR (kind = 'CASH' AND cash_kobo BETWEEN 50000 AND 1000000))
);

CREATE TABLE cycle_approvals (
  cycle_id      uuid NOT NULL REFERENCES cycles(id),
  approver_id   uuid NOT NULL REFERENCES admin_users(id),
  capacity      text NOT NULL CHECK (capacity IN ('OPERATIONS','FINANCE')),
  approved_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cycle_id, capacity)
);

CREATE FUNCTION check_cycle_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c cycles%ROWTYPE;
BEGIN
  SELECT * INTO c FROM cycles WHERE id = NEW.cycle_id FOR UPDATE;
  IF c.status <> 'SUBMITTED' THEN
    RAISE EXCEPTION 'cycle must be SUBMITTED to be approved' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.approver_id = c.created_by THEN
    RAISE EXCEPTION 'the person who drafted a cycle cannot approve it' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM cycle_approvals a WHERE a.cycle_id = NEW.cycle_id AND a.approver_id = NEW.approver_id) THEN
    RAISE EXCEPTION 'the two approvals must come from different people' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cycle_approvals_check BEFORE INSERT ON cycle_approvals
  FOR EACH ROW EXECUTE FUNCTION check_cycle_approval();
CREATE TRIGGER cycle_approvals_append_only BEFORE UPDATE OR DELETE ON cycle_approvals
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Published before sales open. One row per cycle, never changed.
CREATE TABLE cycle_commitments (
  cycle_id              uuid PRIMARY KEY REFERENCES cycles(id),
  game_core_version     text NOT NULL,
  ticket_merkle_root    bytea NOT NULL CHECK (octet_length(ticket_merkle_root) = 32),
  prize_table_sha256    bytea NOT NULL CHECK (octet_length(prize_table_sha256) = 32),
  draw_secret_commitment bytea NOT NULL CHECK (octet_length(draw_secret_commitment) = 32),
  kms_key_ref           text NOT NULL,            -- per-cycle key that encrypts outcomes
  published_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER cycle_commitments_append_only BEFORE UPDATE OR DELETE ON cycle_commitments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Cycle state machine and post-commit immutability.
CREATE FUNCTION enforce_cycle_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed boolean;
  instant_liability bigint;
BEGIN
  IF NEW.status <> OLD.status THEN
    allowed := (OLD.status, NEW.status) IN (
      ('DRAFT','SUBMITTED'), ('SUBMITTED','DRAFT'), ('SUBMITTED','APPROVED'),
      ('APPROVED','COMMITTED'), ('COMMITTED','OPEN'), ('OPEN','CLOSED'),
      ('CLOSED','DRAWN'), ('DRAWN','SETTLING'), ('SETTLING','ARCHIVED'),
      ('APPROVED','VOID'), ('COMMITTED','VOID'), ('OPEN','VOID'), ('CLOSED','VOID'));
    IF NOT allowed THEN
      RAISE EXCEPTION 'cycle cannot move from % to %', OLD.status, NEW.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF NEW.status = 'APPROVED' THEN
      IF (SELECT count(*) FROM cycle_approvals WHERE cycle_id = NEW.id) < 2 THEN
        RAISE EXCEPTION 'approval needs both an operations and a finance approver'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.financial_model_ref IS NULL OR NEW.rules_document_ref IS NULL OR NEW.rules_sha256 IS NULL
         OR NEW.auditor_admin_id IS NULL THEN
        RAISE EXCEPTION 'approval needs the financial model, published rules and an appointed auditor'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      SELECT coalesce(sum(cash_kobo * quantity), 0) INTO instant_liability
        FROM prize_tiers WHERE cycle_id = NEW.id AND kind = 'CASH';
      IF NEW.escrow_reference IS NULL OR coalesce(NEW.escrow_funded_kobo, 0) < instant_liability THEN
        RAISE EXCEPTION 'all cash prizes (% kobo) must be fully funded in escrow/trust before approval', instant_liability
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF (SELECT coalesce(sum(quantity), 0) FROM prize_tiers WHERE cycle_id = NEW.id AND stage = 'INSTANT')
           > NEW.total_tickets THEN
        RAISE EXCEPTION 'more instant prizes than tickets' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;

    IF NEW.status = 'COMMITTED' AND NOT EXISTS (SELECT 1 FROM cycle_commitments WHERE cycle_id = NEW.id) THEN
      RAISE EXCEPTION 'commitments must be published before a cycle is COMMITTED'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- Hard gate: no real-money sales without a valid licence for the state and a
    -- current certification of the game core that generated this cycle.
    IF NEW.status = 'OPEN' AND NEW.mode = 'REAL_MONEY' THEN
      IF NOT EXISTS (SELECT 1 FROM licences l
                     WHERE l.state_code = NEW.state_code AND current_date BETWEEN l.valid_from AND l.valid_to) THEN
        RAISE EXCEPTION 'no valid licence for % — real-money sales cannot open', NEW.state_code
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM certifications ce
                     JOIN cycle_commitments cc ON cc.cycle_id = NEW.id
                     WHERE ce.component = 'GAME_CORE' AND ce.component_version = cc.game_core_version
                       AND current_date >= ce.valid_from AND (ce.valid_to IS NULL OR current_date <= ce.valid_to)) THEN
        RAISE EXCEPTION 'game core version is not certified — real-money sales cannot open'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
  END IF;

  -- Once approved, the game cannot be edited. Only status moves forward.
  IF OLD.status NOT IN ('DRAFT','SUBMITTED') THEN
    IF (NEW.name, NEW.mode, NEW.state_code, NEW.ticket_price_kobo, NEW.total_tickets, NEW.max_tickets_per_account,
        NEW.sales_open_at, NEW.sales_close_at, NEW.draw_at, NEW.claim_window_days,
        NEW.rules_document_ref, NEW.rules_sha256, NEW.financial_model_ref,
        NEW.escrow_reference, NEW.escrow_funded_kobo, NEW.auditor_admin_id, NEW.created_by)
       IS DISTINCT FROM
       (OLD.name, OLD.mode, OLD.state_code, OLD.ticket_price_kobo, OLD.total_tickets, OLD.max_tickets_per_account,
        OLD.sales_open_at, OLD.sales_close_at, OLD.draw_at, OLD.claim_window_days,
        OLD.rules_document_ref, OLD.rules_sha256, OLD.financial_model_ref,
        OLD.escrow_reference, OLD.escrow_funded_kobo, OLD.auditor_admin_id, OLD.created_by) THEN
      RAISE EXCEPTION 'cycle % is locked: its rules cannot be changed after approval', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER cycles_rules BEFORE UPDATE ON cycles FOR EACH ROW EXECUTE FUNCTION enforce_cycle_rules();
CREATE TRIGGER cycles_no_delete BEFORE DELETE ON cycles FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- New cycles always start as DRAFT.
CREATE FUNCTION cycles_start_as_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'a cycle must be created as DRAFT' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cycles_insert BEFORE INSERT ON cycles FOR EACH ROW EXECUTE FUNCTION cycles_start_as_draft();

CREATE FUNCTION lock_prize_tiers() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  s text;
BEGIN
  SELECT status INTO s FROM cycles WHERE id = coalesce(NEW.cycle_id, OLD.cycle_id);
  IF s NOT IN ('DRAFT','SUBMITTED') THEN
    RAISE EXCEPTION 'prize schedule is locked once the cycle is approved'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER prize_tiers_lock BEFORE INSERT OR UPDATE OR DELETE ON prize_tiers
  FOR EACH ROW EXECUTE FUNCTION lock_prize_tiers();

-- ---------------------------------------------------------------------------
-- Orders and payments
-- ---------------------------------------------------------------------------

CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  cycle_id        uuid NOT NULL REFERENCES cycles(id),
  quantity        integer NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  amount_kobo     bigint NOT NULL CHECK (amount_kobo > 0),
  idempotency_key text NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN (
                    'PENDING','PAID','FULFILLED','EXPIRED','REFUND_DUE','REFUNDED','CANCELLED')),
  reserved_until  timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX orders_user_created ON orders (user_id, created_at);
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES orders(id),
  provider        text NOT NULL,                  -- 'SIMULATED' during Phase 2
  provider_ref    text NOT NULL,
  method          text CHECK (method IN ('CARD','BANK_TRANSFER','USSD','SIMULATED')),
  amount_kobo     bigint NOT NULL CHECK (amount_kobo > 0),
  currency        text NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status          text NOT NULL CHECK (status IN ('INITIATED','SUCCEEDED','FAILED','REVERSED')),
  verified_at     timestamptz,                    -- set only after server-to-server re-query
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref),
  CHECK (status <> 'SUCCEEDED' OR verified_at IS NOT NULL)
);
-- At most one successful payment per order.
CREATE UNIQUE INDEX payments_one_success_per_order ON payments (order_id) WHERE status = 'SUCCEEDED';

-- Raw gateway webhooks, kept verbatim. The unique key makes redelivery harmless.
CREATE TABLE payment_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL,
  provider_event_id text NOT NULL,
  signature_valid   boolean NOT NULL,
  payload           jsonb NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE refunds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id      uuid NOT NULL REFERENCES payments(id),
  amount_kobo     bigint NOT NULL CHECK (amount_kobo > 0),
  reason          text NOT NULL CHECK (reason IN (
                    'NO_TICKET_ISSUED','DUPLICATE_CHARGE','CYCLE_VOID','INELIGIBLE_PURCHASE','DISPUTED_PAYMENT')),
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','CONFIRMED','FAILED')),
  provider_ref    text,
  requested_by    uuid REFERENCES admin_users(id),   -- NULL = automatic
  approved_by     uuid REFERENCES admin_users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (requested_by IS NULL OR approved_by IS NULL OR requested_by <> approved_by),
  -- Manual refunds need a second person; automatic ones are limited to the mechanical cases.
  CHECK (requested_by IS NOT NULL OR reason IN ('NO_TICKET_ISSUED','DUPLICATE_CHARGE','CYCLE_VOID'))
);

-- ---------------------------------------------------------------------------
-- Tickets
-- ---------------------------------------------------------------------------

CREATE TABLE tickets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id          uuid NOT NULL REFERENCES cycles(id),
  serial            text NOT NULL,                -- public, random, non-sequential
  leaf_index        integer NOT NULL CHECK (leaf_index >= 0),
  leaf_hash         bytea NOT NULL CHECK (octet_length(leaf_hash) = 32),
  -- Outcome and salt, encrypted with the cycle's KMS key. The role that sells
  -- tickets has no decrypt permission on that key.
  outcome_ciphertext bytea NOT NULL,
  status            text NOT NULL DEFAULT 'UNSOLD' CHECK (status IN ('UNSOLD','SOLD','REVEALED','CANCELLED')),
  owner_id          uuid REFERENCES users(id),
  order_id          uuid REFERENCES orders(id),
  sold_at           timestamptz,
  revealed_at       timestamptz,
  revealed_outcome  text,                         -- plaintext only after reveal
  revealed_salt     bytea,
  UNIQUE (cycle_id, serial),
  UNIQUE (cycle_id, leaf_index),
  CHECK ((status = 'UNSOLD') = (owner_id IS NULL)),
  CHECK ((owner_id IS NULL) = (order_id IS NULL) AND (owner_id IS NULL) = (sold_at IS NULL)),
  CHECK ((status = 'REVEALED') = (revealed_at IS NOT NULL)),
  CHECK ((revealed_at IS NULL) = (revealed_outcome IS NULL) AND (revealed_at IS NULL) = (revealed_salt IS NULL))
);
CREATE INDEX tickets_unsold ON tickets (cycle_id) WHERE status = 'UNSOLD';
CREATE INDEX tickets_owner ON tickets (owner_id, cycle_id);

CREATE FUNCTION enforce_ticket_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.cycle_id, NEW.serial, NEW.leaf_index, NEW.leaf_hash, NEW.outcome_ciphertext)
     IS DISTINCT FROM (OLD.cycle_id, OLD.serial, OLD.leaf_index, OLD.leaf_hash, OLD.outcome_ciphertext) THEN
    RAISE EXCEPTION 'ticket identity and outcome are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status, NEW.status) NOT IN (
       ('UNSOLD','SOLD'), ('SOLD','REVEALED'), ('SOLD','CANCELLED'), ('REVEALED','CANCELLED')) THEN
    RAISE EXCEPTION 'ticket cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.owner_id IS NOT NULL AND (NEW.owner_id, NEW.order_id, NEW.sold_at)
     IS DISTINCT FROM (OLD.owner_id, OLD.order_id, OLD.sold_at) THEN
    RAISE EXCEPTION 'a sold ticket cannot change owner' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.revealed_at IS NOT NULL AND (NEW.revealed_at, NEW.revealed_outcome, NEW.revealed_salt)
     IS DISTINCT FROM (OLD.revealed_at, OLD.revealed_outcome, OLD.revealed_salt) THEN
    RAISE EXCEPTION 'a revealed ticket cannot be revealed again or altered'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'UNSOLD' AND NEW.status = 'SOLD'
     AND (SELECT status FROM cycles WHERE id = NEW.cycle_id) <> 'OPEN' THEN
    RAISE EXCEPTION 'tickets can only be sold while the cycle is OPEN'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tickets_rules BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION enforce_ticket_rules();
CREATE TRIGGER tickets_no_delete BEFORE DELETE ON tickets FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Tickets are created only while the cycle is APPROVED (the generation job), unsold.
CREATE FUNCTION tickets_insert_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'UNSOLD' OR (SELECT status FROM cycles WHERE id = NEW.cycle_id) <> 'APPROVED' THEN
    RAISE EXCEPTION 'tickets can only be generated, unsold, for an APPROVED cycle'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tickets_insert BEFORE INSERT ON tickets FOR EACH ROW EXECUTE FUNCTION tickets_insert_rules();

-- ---------------------------------------------------------------------------
-- Double-entry ledger
-- ---------------------------------------------------------------------------

CREATE TABLE ledger_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,               -- e.g. 'GATEWAY_CLEARING', 'TICKET_REVENUE', 'PLAYER_WINNINGS:<user>'
  kind        text NOT NULL CHECK (kind IN ('ASSET','LIABILITY','REVENUE','EXPENSE')),
  user_id     uuid REFERENCES users(id),
  cycle_id    uuid REFERENCES cycles(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN (
                    'TICKET_SALE','INSTANT_PRIZE','DRAW_PRIZE','PAYOUT','PAYOUT_REVERSAL',
                    'REFUND','FEE','TAX','ESCROW_FUNDING','ADJUSTMENT')),
  -- Natural key of the business event; makes posting the same event twice impossible.
  reference       text NOT NULL UNIQUE,
  cycle_id        uuid REFERENCES cycles(id),
  memo            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id  uuid NOT NULL REFERENCES ledger_transactions(id),
  account_id      uuid NOT NULL REFERENCES ledger_accounts(id),
  -- Signed amount: debits positive, credits negative. Entries of a transaction sum to zero.
  amount_kobo     bigint NOT NULL CHECK (amount_kobo <> 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_account ON ledger_entries (account_id);
CREATE INDEX ledger_entries_tx ON ledger_entries (transaction_id);

CREATE FUNCTION check_ledger_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  total bigint;
  n integer;
BEGIN
  SELECT coalesce(sum(amount_kobo), 0), count(*) INTO total, n
    FROM ledger_entries WHERE transaction_id = NEW.id;
  IF n < 2 OR total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % does not balance (entries %, sum %)', NEW.id, n, total
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;
-- Checked at commit, after all entries of the transaction have been written.
CREATE CONSTRAINT TRIGGER ledger_tx_balanced AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ledger_balanced();

-- The same check runs for every entry, so entries added to an existing
-- transaction later cannot unbalance it either.
CREATE FUNCTION check_ledger_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  total bigint;
BEGIN
  SELECT coalesce(sum(amount_kobo), 0) INTO total FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % does not balance (sum %)', NEW.transaction_id, total
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_entry_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ledger_entry_balanced();

CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE VIEW ledger_balances AS
  SELECT a.id AS account_id, a.code, a.kind, coalesce(sum(e.amount_kobo), 0)::bigint AS balance_kobo
  FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
  GROUP BY a.id;

-- ---------------------------------------------------------------------------
-- Final draw
-- ---------------------------------------------------------------------------

CREATE TABLE draws (
  cycle_id            uuid PRIMARY KEY REFERENCES cycles(id),
  entries_count       integer NOT NULL CHECK (entries_count >= 0),
  entries_sha256      bytea NOT NULL CHECK (octet_length(entries_sha256) = 32),
  entries_snapshot_ref text NOT NULL,             -- write-once object holding the frozen entry list
  beacon_source       text NOT NULL,
  beacon_round        bigint NOT NULL,            -- announced before close
  beacon_value        bytea NOT NULL,
  revealed_secret     bytea NOT NULL CHECK (octet_length(revealed_secret) = 32),
  seed                bytea NOT NULL CHECK (octet_length(seed) = 32),
  game_core_version   text NOT NULL,
  operator_1          uuid NOT NULL REFERENCES admin_users(id),
  operator_2          uuid NOT NULL REFERENCES admin_users(id),
  auditor_id          uuid NOT NULL REFERENCES admin_users(id),
  auditor_signed_at   timestamptz NOT NULL,
  report_ref          text,
  executed_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (operator_1 <> operator_2 AND auditor_id <> operator_1 AND auditor_id <> operator_2)
);

CREATE FUNCTION check_draw() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c cycles%ROWTYPE;
BEGIN
  SELECT * INTO c FROM cycles WHERE id = NEW.cycle_id FOR UPDATE;
  IF c.status <> 'CLOSED' THEN
    RAISE EXCEPTION 'a draw can only run on a CLOSED cycle' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.auditor_id <> c.auditor_admin_id THEN
    RAISE EXCEPTION 'the draw must be countersigned by the auditor appointed for this cycle'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER draws_check BEFORE INSERT ON draws FOR EACH ROW EXECUTE FUNCTION check_draw();
CREATE TRIGGER draws_append_only BEFORE UPDATE OR DELETE ON draws FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE draw_winners (
  cycle_id        uuid NOT NULL REFERENCES draws(cycle_id),
  prize_tier_id   uuid NOT NULL REFERENCES prize_tiers(id),
  position        integer NOT NULL CHECK (position >= 1),
  ticket_id       uuid NOT NULL REFERENCES tickets(id),
  PRIMARY KEY (cycle_id, prize_tier_id, position),
  UNIQUE (ticket_id)                               -- one final-draw prize per ticket
);
CREATE TRIGGER draw_winners_append_only BEFORE UPDATE OR DELETE ON draw_winners
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Merchandise inventory
-- ---------------------------------------------------------------------------

CREATE TABLE suppliers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  country     text,
  contact     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE skus (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  description           text,
  specifications        jsonb NOT NULL DEFAULT '{}',
  advertised_value_kobo bigint NOT NULL CHECK (advertised_value_kobo > 0),
  serialised            boolean NOT NULL DEFAULT false,
  warranty_months       integer CHECK (warranty_months >= 0),
  image_refs            text[] NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE prize_tiers ADD CONSTRAINT prize_tiers_sku_fk FOREIGN KEY (sku_id) REFERENCES skus(id);

CREATE TABLE warehouses (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name      text NOT NULL,
  address   text NOT NULL,
  state_code text NOT NULL
);

CREATE TABLE purchase_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id   uuid NOT NULL REFERENCES suppliers(id),
  reference     text NOT NULL UNIQUE,
  ordered_at    date NOT NULL,
  received_at   date,
  document_ref  text
);

CREATE TABLE stock_units (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id            uuid NOT NULL REFERENCES skus(id),
  purchase_order_id uuid REFERENCES purchase_orders(id),
  warehouse_id      uuid REFERENCES warehouses(id),
  serial_number     text,
  acquisition_cost_kobo bigint NOT NULL CHECK (acquisition_cost_kobo >= 0),
  landed_cost_kobo  bigint NOT NULL CHECK (landed_cost_kobo >= acquisition_cost_kobo),
  status            text NOT NULL DEFAULT 'ON_ORDER' CHECK (status IN (
                      'ON_ORDER','IN_STOCK','RESERVED','ALLOCATED','DISPATCHED','DELIVERED','WRITTEN_OFF')),
  reserved_cycle_id uuid REFERENCES cycles(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sku_id, serial_number),
  CHECK ((status IN ('RESERVED','ALLOCATED','DISPATCHED','DELIVERED')) = (reserved_cycle_id IS NOT NULL)
         OR status = 'WRITTEN_OFF')
);

-- ---------------------------------------------------------------------------
-- Prize claims, payouts, fulfilment
-- ---------------------------------------------------------------------------

CREATE TABLE prize_claims (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       uuid NOT NULL REFERENCES tickets(id),
  stage           text NOT NULL CHECK (stage IN ('INSTANT','FINAL_DRAW')),
  prize_tier_id   uuid NOT NULL REFERENCES prize_tiers(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  -- Set when the next of kin claims on the winner's behalf (after their own verification).
  claimed_by_next_of_kin boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'ENTITLED' CHECK (status IN (
                    'ENTITLED','ON_HOLD','VERIFIED','PAID','DISPATCHED','DELIVERED','EXPIRED','VOID')),
  hold_reason     text,
  expires_at      timestamptz NOT NULL,
  stock_unit_id   uuid UNIQUE REFERENCES stock_units(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, stage),                       -- a ticket is claimed at most once per stage
  CHECK ((status = 'ON_HOLD') = (hold_reason IS NOT NULL))
);
CREATE TRIGGER prize_claims_touch BEFORE UPDATE ON prize_claims FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER prize_claims_no_delete BEFORE DELETE ON prize_claims FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE payouts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id),
  amount_kobo     bigint NOT NULL CHECK (amount_kobo > 0),
  idempotency_key text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN (
                    'REQUESTED','PENDING_APPROVAL','APPROVED','SENT','CONFIRMED','FAILED','REJECTED')),
  requires_approval boolean NOT NULL,
  initiated_by    uuid REFERENCES admin_users(id),  -- NULL = player-initiated withdrawal
  approved_by     uuid REFERENCES admin_users(id),
  provider        text,
  provider_ref    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref),
  CHECK (initiated_by IS NULL OR approved_by IS NULL OR initiated_by <> approved_by),
  -- Money cannot leave on an approval-required payout until someone has approved it.
  CHECK (NOT requires_approval OR approved_by IS NOT NULL OR status IN ('REQUESTED','PENDING_APPROVAL','REJECTED'))
);
CREATE TRIGGER payouts_touch BEFORE UPDATE ON payouts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE shipments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prize_claim_id  uuid NOT NULL UNIQUE REFERENCES prize_claims(id),
  method          text NOT NULL CHECK (method IN ('DELIVERY','COLLECTION')),
  carrier         text,
  tracking_ref    text,
  address         text,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','IN_TRANSIT','HANDED_OVER','FAILED')),
  handover_otp_hash text,
  handover_photo_ref text,
  handed_over_at  timestamptz,
  warranty_document_ref text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'HANDED_OVER' OR (handed_over_at IS NOT NULL AND handover_photo_ref IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- Tamper-evident audit log
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  seq           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_type    text NOT NULL CHECK (actor_type IN ('PLAYER','ADMIN','SYSTEM')),
  actor_id      uuid,
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text NOT NULL,
  details       jsonb NOT NULL DEFAULT '{}',
  ip            inet,
  prev_hash     bytea NOT NULL,
  row_hash      bytea NOT NULL
);

-- Each row's hash covers the previous row's hash, so removing or editing any
-- row breaks every hash after it. The chain head is exported daily to
-- write-once storage outside the database.
CREATE FUNCTION audit_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prev bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit_log_chain'));
  SELECT row_hash INTO prev FROM audit_log ORDER BY seq DESC LIMIT 1;
  NEW.occurred_at := now();
  NEW.prev_hash := coalesce(prev, '\x00'::bytea);
  NEW.row_hash := sha256(
    NEW.prev_hash ||
    convert_to(jsonb_build_array(
      (extract(epoch FROM NEW.occurred_at) * 1000000)::bigint, NEW.actor_type, NEW.actor_id, NEW.action,
      NEW.entity_type, NEW.entity_id, NEW.details, host(NEW.ip))::text, 'UTF8'));
  RETURN NEW;
END $$;
CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_chain();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Returns the seq of the first broken link, or NULL if the chain is intact.
CREATE FUNCTION audit_log_verify() RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE
  r audit_log%ROWTYPE;
  prev bytea := '\x00'::bytea;
BEGIN
  FOR r IN SELECT * FROM audit_log ORDER BY seq LOOP
    IF r.prev_hash <> prev OR r.row_hash <> sha256(
         r.prev_hash ||
         convert_to(jsonb_build_array(
           (extract(epoch FROM r.occurred_at) * 1000000)::bigint, r.actor_type, r.actor_id, r.action,
           r.entity_type, r.entity_id, r.details, host(r.ip))::text, 'UTF8')) THEN
      RETURN r.seq;
    END IF;
    prev := r.row_hash;
  END LOOP;
  RETURN NULL;
END $$;

CREATE TABLE compliance_alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL,                       -- e.g. 'RECONCILIATION_MISMATCH', 'FUNDING_SHORTFALL', 'FRAUD_SIGNAL'
  severity    text NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  entity_type text,
  entity_id   text,
  details     jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  resolved_by uuid REFERENCES admin_users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMIT;
