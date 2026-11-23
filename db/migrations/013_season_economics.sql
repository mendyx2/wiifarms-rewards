-- Season economics (first wave): the prize budget and the daily card limit are
-- fixed on each cycle when it is drafted, from company policy, so a season is
-- always judged against the rules it was approved under.
BEGIN;

-- Share of full sell-out sales that becomes prizes, and the share of that
-- which goes to instant cash wins, in basis points (5000 = 50%).
ALTER TABLE cycles ADD COLUMN prize_share_bp   integer NOT NULL DEFAULT 5000 CHECK (prize_share_bp BETWEEN 1 AND 10000);
ALTER TABLE cycles ADD COLUMN instant_share_bp integer NOT NULL DEFAULT 1000 CHECK (instant_share_bp BETWEEN 0 AND 10000);
-- Cards one person may buy in one Nigerian calendar day in this cycle.
ALTER TABLE cycles ADD COLUMN max_tickets_per_day integer NOT NULL DEFAULT 10 CHECK (max_tickets_per_day > 0);

-- Large seasons (400,000 cards): cards are taken from a random point in the
-- (already shuffled) inventory, so the unsold ones must be found in order fast.
DROP INDEX tickets_unsold;
CREATE INDEX tickets_unsold ON tickets (cycle_id, leaf_index) WHERE status = 'UNSOLD';
-- Today's purchases per person per cycle.
CREATE INDEX orders_user_cycle_created ON orders (user_id, cycle_id, created_at);

COMMIT;
