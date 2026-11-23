-- Instant prizes are accepted by the player. Scratching reveals the prize; the
-- player taps Accept to move it into their wallet. Prizes not accepted by the
-- time the season closes (or is cancelled) are accepted automatically, so no
-- winner ever loses a prize by not tapping.
BEGIN;

ALTER TABLE tickets ADD COLUMN prize_accepted_at timestamptz;

CREATE FUNCTION enforce_prize_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.prize_accepted_at IS NOT NULL AND NEW.prize_accepted_at IS DISTINCT FROM OLD.prize_accepted_at THEN
    RAISE EXCEPTION 'an accepted prize cannot be accepted again or altered' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.prize_accepted_at IS NULL AND NEW.prize_accepted_at IS NOT NULL
     AND (NEW.revealed_at IS NULL OR NEW.revealed_outcome NOT LIKE 'CASH:%' OR NEW.status <> 'REVEALED') THEN
    RAISE EXCEPTION 'only a revealed winning card can have its prize accepted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tickets_prize_acceptance BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION enforce_prize_acceptance();

-- Wins waiting to be accepted, per cycle, for the automatic acceptance at close.
CREATE INDEX tickets_prize_waiting ON tickets (cycle_id) WHERE revealed_outcome LIKE 'CASH:%' AND prize_accepted_at IS NULL;

-- Prizes already credited before this change count as accepted.
UPDATE tickets SET prize_accepted_at = revealed_at WHERE revealed_outcome LIKE 'CASH:%' AND status = 'REVEALED';

COMMIT;
