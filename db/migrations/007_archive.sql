-- Closing out a cycle: two people, and the full ticket list published.
BEGIN;

ALTER TABLE cycles
  ADD COLUMN archive_requested_by uuid REFERENCES admin_users(id),
  ADD COLUMN archive_requested_at timestamptz,
  ADD COLUMN archived_by uuid REFERENCES admin_users(id),
  ADD COLUMN archived_at timestamptz;
-- SETTLING means "close-out requested"; ARCHIVED needs a second, different person.
ALTER TABLE cycles ADD CONSTRAINT cycles_settling_requested
  CHECK (status NOT IN ('SETTLING','ARCHIVED') OR archive_requested_by IS NOT NULL);
ALTER TABLE cycles ADD CONSTRAINT cycles_archive_two_people
  CHECK (status <> 'ARCHIVED' OR (archived_by IS NOT NULL AND archived_by <> archive_requested_by));

CREATE FUNCTION lock_archive_fields() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.archive_requested_by IS NOT NULL AND (NEW.archive_requested_by, NEW.archive_requested_at) IS DISTINCT FROM (OLD.archive_requested_by, OLD.archive_requested_at))
     OR (OLD.archived_by IS NOT NULL AND (NEW.archived_by, NEW.archived_at) IS DISTINCT FROM (OLD.archived_by, OLD.archived_at)) THEN
    RAISE EXCEPTION 'close-out records cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cycles_lock_archive_fields BEFORE UPDATE ON cycles FOR EACH ROW EXECUTE FUNCTION lock_archive_fields();

-- Every card's outcome and salt, published when the cycle is archived, so the
-- whole fingerprint can be rebuilt by anyone.
CREATE TABLE published_tickets (
  cycle_id     uuid NOT NULL REFERENCES cycles(id),
  leaf_index   integer NOT NULL,
  serial       text NOT NULL,
  outcome      text NOT NULL,
  salt         bytea NOT NULL CHECK (octet_length(salt) = 16),
  sale_status  text NOT NULL CHECK (sale_status IN ('UNSOLD','SOLD','REVEALED','CANCELLED')),
  PRIMARY KEY (cycle_id, leaf_index),
  UNIQUE (cycle_id, serial)
);
CREATE TRIGGER published_tickets_append_only BEFORE UPDATE OR DELETE ON published_tickets
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- A cycle cannot be archived until every one of its cards is published.
CREATE FUNCTION require_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'ARCHIVED' AND OLD.status <> 'ARCHIVED'
     AND (SELECT count(*) FROM published_tickets WHERE cycle_id = NEW.id) <> NEW.total_tickets THEN
    RAISE EXCEPTION 'every card must be published before the cycle is archived' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cycles_require_publication BEFORE UPDATE ON cycles FOR EACH ROW EXECUTE FUNCTION require_publication();

COMMIT;
