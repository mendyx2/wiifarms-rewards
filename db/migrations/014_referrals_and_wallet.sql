-- Referrals and paying from the wallet.
--
-- Every player has a referral code. Whoever's code was used when an account
-- was opened is its referrer, permanently; the referrer earns a commission on
-- each card purchase the referred player makes, paid into their wallet from the
-- operator's share of sales (never from prize money). Commissions are reversed
-- if the purchase is refunded.
BEGIN;

ALTER TABLE users ADD COLUMN referral_code text UNIQUE CHECK (referral_code ~ '^[A-HJ-NP-Z2-9]{7}$');
ALTER TABLE users ADD COLUMN referred_by uuid REFERENCES users(id) CHECK (referred_by <> id);
CREATE INDEX users_referred_by ON users (referred_by) WHERE referred_by IS NOT NULL;

-- Who referred whom is fixed when the account is opened.
CREATE FUNCTION protect_referral() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.referred_by IS DISTINCT FROM OLD.referred_by THEN
    RAISE EXCEPTION 'who referred an account is set when it is opened and cannot be changed' USING ERRCODE = '23000';
  END IF;
  IF OLD.referral_code IS NOT NULL AND NEW.referral_code IS DISTINCT FROM OLD.referral_code THEN
    RAISE EXCEPTION 'a referral code cannot be changed once issued' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_protect_referral BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION protect_referral();

CREATE TABLE referral_commissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL UNIQUE REFERENCES orders(id),   -- one commission per purchase
  referrer_id   uuid NOT NULL REFERENCES users(id),
  buyer_id      uuid NOT NULL REFERENCES users(id),
  cycle_id      uuid NOT NULL REFERENCES cycles(id),
  cards         integer NOT NULL CHECK (cards > 0),
  rate_bp       integer NOT NULL CHECK (rate_bp > 0 AND rate_bp <= 1000),
  amount_kobo   bigint NOT NULL CHECK (amount_kobo > 0),
  status        text NOT NULL DEFAULT 'EARNED' CHECK (status IN ('EARNED','REVERSED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  reversed_at   timestamptz,
  CHECK (referrer_id <> buyer_id),
  CHECK ((status = 'REVERSED') = (reversed_at IS NOT NULL))
);
CREATE INDEX referral_commissions_referrer ON referral_commissions (referrer_id, created_at DESC);

-- A commission can only ever be reversed; nothing else about it changes, and it is never deleted.
CREATE FUNCTION protect_commission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DELETE on referral_commissions is not allowed: table is append-only'; END IF;
  IF OLD.status <> 'EARNED' OR NEW.status <> 'REVERSED' OR (NEW.order_id, NEW.referrer_id, NEW.buyer_id, NEW.cycle_id, NEW.cards, NEW.rate_bp, NEW.amount_kobo, NEW.created_at)
     IS DISTINCT FROM (OLD.order_id, OLD.referrer_id, OLD.buyer_id, OLD.cycle_id, OLD.cards, OLD.rate_bp, OLD.amount_kobo, OLD.created_at) THEN
    RAISE EXCEPTION 'a referral commission can only be reversed' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER referral_commissions_protect BEFORE UPDATE OR DELETE ON referral_commissions FOR EACH ROW EXECUTE FUNCTION protect_commission();

-- Paying for cards from the wallet.
ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (method IN ('CARD','BANK_TRANSFER','USSD','SIMULATED','WALLET'));

ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check CHECK (kind IN (
  'TICKET_SALE','INSTANT_PRIZE','DRAW_PRIZE','PAYOUT','PAYOUT_REVERSAL','REFUND','FEE','TAX','ESCROW_FUNDING','ADJUSTMENT','EXPENSE','EXPENSE_REVERSAL',
  'REFERRAL_COMMISSION','REFERRAL_REVERSAL'));

COMMIT;
