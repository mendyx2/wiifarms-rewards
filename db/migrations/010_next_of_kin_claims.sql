-- Next-of-kin claims: when a winner has died or cannot be reached, their
-- recorded next of kin may receive the prizes still waiting to be claimed,
-- after checks by two different people and a waiting period.
BEGIN;

CREATE TABLE next_of_kin_cases (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  winner_user_id    uuid NOT NULL REFERENCES users(id),
  claimant_user_id  uuid NOT NULL REFERENCES users(id),
  reason            text NOT NULL CHECK (reason IN ('DECEASED','UNREACHABLE')),
  documents         text[] NOT NULL CHECK (cardinality(documents) > 0),
  note              text NOT NULL CHECK (length(trim(note)) > 0),
  opened_by         uuid NOT NULL REFERENCES admin_users(id),
  opened_at         timestamptz NOT NULL DEFAULT now(),
  status            text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','APPROVED','REJECTED')),
  decided_by        uuid REFERENCES admin_users(id),
  decided_at        timestamptz,
  decision_reason   text,
  transferred       jsonb,                         -- what moved to the claimant, for the record
  CHECK (claimant_user_id <> winner_user_id),
  CHECK (decided_by IS NULL OR decided_by <> opened_by),
  CHECK ((status = 'OPEN') = (decided_by IS NULL)),
  CHECK (status <> 'REJECTED' OR length(trim(coalesce(decision_reason, ''))) > 0)
);
CREATE UNIQUE INDEX next_of_kin_cases_one_open ON next_of_kin_cases (winner_user_id) WHERE status = 'OPEN';

CREATE FUNCTION protect_nok_case() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'OPEN'
     OR (NEW.winner_user_id, NEW.claimant_user_id, NEW.reason, NEW.documents, NEW.note, NEW.opened_by)
        IS DISTINCT FROM (OLD.winner_user_id, OLD.claimant_user_id, OLD.reason, OLD.documents, OLD.note, OLD.opened_by) THEN
    RAISE EXCEPTION 'a next-of-kin case cannot be changed once decided, and its details cannot be edited'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER next_of_kin_cases_protect BEFORE UPDATE OR DELETE ON next_of_kin_cases FOR EACH ROW EXECUTE FUNCTION protect_nok_case();

-- While a case is open, the winner's waiting prizes do not lapse: the row is
-- simply left unchanged by any job that tries to expire it.
CREATE FUNCTION hold_claims_during_nok_case() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'EXPIRED' AND OLD.status = 'ENTITLED'
     AND EXISTS (SELECT 1 FROM next_of_kin_cases c WHERE c.winner_user_id = OLD.user_id AND c.status = 'OPEN') THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prize_claims_hold_for_nok BEFORE UPDATE ON prize_claims FOR EACH ROW EXECUTE FUNCTION hold_claims_during_nok_case();

COMMIT;
