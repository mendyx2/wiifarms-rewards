-- Simple referrals and wallet deposits.
--
-- The board replaced the separate affiliate programme with something simpler:
-- every player has a link, and 10% of every card bought by friends who joined
-- with it is paid into the player's wallet, withdrawable together with their
-- winnings. The affiliate tables stay, unchanged, for the records made under
-- the earlier model.
--
-- Players can also add money to their wallet (deposits) and buy cards from it.
-- Deposits are for buying cards: only winnings and referral earnings can be
-- withdrawn.
BEGIN;

-- A player whose promotion broke the rules can have their referral earnings stopped (after an investigation).
ALTER TABLE users ADD COLUMN referral_earnings_blocked boolean NOT NULL DEFAULT false;

-- Complaints about promoters now name the player whose link it was.
ALTER TABLE affiliate_complaints ADD COLUMN referrer_id uuid REFERENCES users(id);

-- Deposits into the wallet, through the payment provider.
CREATE TABLE deposits (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id),
  amount_kobo      bigint NOT NULL CHECK (amount_kobo >= 10000 AND amount_kobo <= 10000000), -- ₦100 to ₦100,000
  method           text NOT NULL CHECK (method IN ('BANK_TRANSFER','CARD','USSD','OPAY','SIMULATED')),
  provider         text NOT NULL,
  provider_ref     text NOT NULL UNIQUE,
  idempotency_key  text NOT NULL UNIQUE,
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIRMED','FAILED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  confirmed_at     timestamptz,
  CHECK ((status = 'CONFIRMED') = (confirmed_at IS NOT NULL))
);
CREATE INDEX deposits_user ON deposits (user_id, created_at DESC);
CREATE INDEX deposits_confirmed ON deposits (confirmed_at) WHERE status = 'CONFIRMED';

-- A confirmed deposit is final.
CREATE FUNCTION protect_deposit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DELETE on deposits is not allowed'; END IF;
  IF OLD.status <> 'PENDING' OR (NEW.user_id, NEW.amount_kobo, NEW.method, NEW.provider, NEW.provider_ref, NEW.idempotency_key, NEW.created_at)
     IS DISTINCT FROM (OLD.user_id, OLD.amount_kobo, OLD.method, OLD.provider, OLD.provider_ref, OLD.idempotency_key, OLD.created_at) THEN
    RAISE EXCEPTION 'a deposit can only be confirmed or marked failed, once' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deposits_protect BEFORE UPDATE OR DELETE ON deposits FOR EACH ROW EXECUTE FUNCTION protect_deposit();

-- How much of a wallet purchase came from deposits (the rest came from winnings), so a refund goes back where it came from.
ALTER TABLE orders ADD COLUMN from_deposits_kobo bigint NOT NULL DEFAULT 0 CHECK (from_deposits_kobo >= 0 AND from_deposits_kobo <= amount_kobo);

ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check CHECK (kind IN (
  'TICKET_SALE','INSTANT_PRIZE','DRAW_PRIZE','PAYOUT','PAYOUT_REVERSAL','REFUND','FEE','TAX','ESCROW_FUNDING','ADJUSTMENT','EXPENSE','EXPENSE_REVERSAL',
  'REFERRAL_COMMISSION','REFERRAL_REVERSAL','AFFILIATE_FEE','AFFILIATE_FEE_REVERSAL','AFFILIATE_SETTLEMENT','TAX_REVERSAL','STOCKIST_FEE','STOCKIST_SETTLEMENT','DEPOSIT'));

COMMIT;
