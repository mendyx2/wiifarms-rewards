-- Instant cash released in levels, and cards held during payment so that every
-- payment gets its cards (no refunds for "sold out while paying").
BEGIN;

-- A season's cards are sold in equal levels, one after another. Each level
-- holds its own share of every instant prize, so the instant cash is released
-- level by level as cards sell. Fixed at approval, like the prize table.
ALTER TABLE cycles ADD COLUMN levels integer NOT NULL DEFAULT 1 CHECK (levels BETWEEN 1 AND 20);
ALTER TABLE cycles ADD CONSTRAINT cycles_levels_divide CHECK (total_tickets % levels = 0);

-- Cards are held (RESERVED) for an order while the player pays. A held card is
-- sold to that order when payment arrives, or released if the payment window
-- passes without payment.
ALTER TABLE tickets DROP CONSTRAINT tickets_status_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_status_check CHECK (status IN ('UNSOLD','RESERVED','SOLD','REVEALED','CANCELLED'));
CREATE INDEX tickets_reserved ON tickets (order_id) WHERE status = 'RESERVED';
-- A held card belongs to an order but has no owner yet.
ALTER TABLE tickets DROP CONSTRAINT tickets_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_owner_when_sold CHECK ((status IN ('UNSOLD','RESERVED')) = (owner_id IS NULL));
ALTER TABLE tickets DROP CONSTRAINT tickets_check1;
ALTER TABLE tickets ADD CONSTRAINT tickets_order_and_sale CHECK (((owner_id IS NULL) = (sold_at IS NULL)) AND ((status = 'UNSOLD') = (order_id IS NULL)));
ALTER TABLE tickets DROP CONSTRAINT tickets_unrevealed_has_no_time;
ALTER TABLE tickets ADD CONSTRAINT tickets_unrevealed_has_no_time CHECK (status NOT IN ('UNSOLD','RESERVED','SOLD') OR revealed_at IS NULL);

CREATE OR REPLACE FUNCTION enforce_ticket_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.cycle_id, NEW.serial, NEW.leaf_index, NEW.leaf_hash, NEW.outcome_ciphertext)
     IS DISTINCT FROM (OLD.cycle_id, OLD.serial, OLD.leaf_index, OLD.leaf_hash, OLD.outcome_ciphertext) THEN
    RAISE EXCEPTION 'ticket identity and outcome are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status, NEW.status) NOT IN (
       ('UNSOLD','SOLD'), ('UNSOLD','RESERVED'), ('RESERVED','UNSOLD'), ('RESERVED','SOLD'),
       ('SOLD','REVEALED'), ('SOLD','CANCELLED'), ('REVEALED','CANCELLED')) THEN
    RAISE EXCEPTION 'ticket cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.owner_id IS NOT NULL AND (NEW.owner_id, NEW.order_id, NEW.sold_at)
     IS DISTINCT FROM (OLD.owner_id, OLD.order_id, OLD.sold_at) THEN
    RAISE EXCEPTION 'a sold ticket cannot change owner' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- A held card can only be sold to the order holding it.
  IF OLD.status = 'RESERVED' AND NEW.status = 'SOLD' AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION 'a held card can only be sold to the order holding it' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.revealed_at IS NOT NULL AND (NEW.revealed_at, NEW.revealed_outcome, NEW.revealed_salt)
     IS DISTINCT FROM (OLD.revealed_at, OLD.revealed_outcome, OLD.revealed_salt) THEN
    RAISE EXCEPTION 'a revealed ticket cannot be revealed again or altered'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- New sales and holds only while the cycle is open; a card held before closing may still be paid for.
  IF OLD.status = 'UNSOLD' AND NEW.status IN ('SOLD','RESERVED')
     AND (SELECT status FROM cycles WHERE id = NEW.cycle_id) <> 'OPEN' THEN
    RAISE EXCEPTION 'tickets can only be sold while the cycle is OPEN'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
