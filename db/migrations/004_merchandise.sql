-- Merchandise: prizes must physically exist before a cycle is approved, stock
-- promised to a live cycle cannot be taken away, and a prize is handed over
-- only against a one-time code.
BEGIN;

ALTER TABLE shipments
  ADD COLUMN handover_otp_enc bytea,                 -- so the winner can be shown their code
  ADD COLUMN handover_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN dispatched_at timestamptz,
  ADD COLUMN dispatched_by uuid REFERENCES admin_users(id),
  ADD COLUMN handed_over_by uuid REFERENCES admin_users(id);

ALTER TABLE stock_units ADD COLUMN received_at timestamptz;

-- A cycle with merchandise prizes cannot be approved until every one of those
-- prizes is covered by a unit that is in the warehouse and reserved to it.
CREATE FUNCTION require_stock_for_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  short record;
BEGIN
  IF NEW.status = 'APPROVED' AND OLD.status <> 'APPROVED' THEN
    SELECT s.name, need.qty AS needed, coalesce(have.qty, 0) AS reserved INTO short
    FROM (SELECT sku_id, sum(quantity) AS qty FROM prize_tiers WHERE cycle_id = NEW.id AND kind = 'MERCHANDISE' GROUP BY sku_id) need
    JOIN skus s ON s.id = need.sku_id
    LEFT JOIN (SELECT sku_id, count(*) AS qty FROM stock_units WHERE reserved_cycle_id = NEW.id AND status = 'RESERVED' GROUP BY sku_id) have
      ON have.sku_id = need.sku_id
    WHERE coalesce(have.qty, 0) < need.qty
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'merchandise prizes must be in stock and reserved before approval: % needs %, % reserved', short.name, short.needed, short.reserved
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cycles_require_stock BEFORE UPDATE ON cycles FOR EACH ROW EXECUTE FUNCTION require_stock_for_approval();

-- Stock units move only along the allowed path, and a unit promised to a
-- cycle can be released only if that cycle never went ahead or is finished.
CREATE FUNCTION enforce_stock_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cycle_status text;
BEGIN
  IF (NEW.sku_id, NEW.serial_number, NEW.acquisition_cost_kobo, NEW.landed_cost_kobo)
     IS DISTINCT FROM (OLD.sku_id, OLD.serial_number, OLD.acquisition_cost_kobo, OLD.landed_cost_kobo) THEN
    RAISE EXCEPTION 'a stock unit''s item, serial number and costs cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status, NEW.status) NOT IN (
       ('ON_ORDER','IN_STOCK'), ('IN_STOCK','RESERVED'), ('IN_STOCK','WRITTEN_OFF'), ('RESERVED','IN_STOCK'),
       ('RESERVED','ALLOCATED'), ('ALLOCATED','DISPATCHED'), ('DISPATCHED','DELIVERED'), ('DISPATCHED','ALLOCATED')) THEN
    RAISE EXCEPTION 'stock unit cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.reserved_cycle_id IS NOT NULL AND NEW.reserved_cycle_id IS DISTINCT FROM OLD.reserved_cycle_id THEN
    SELECT status INTO cycle_status FROM cycles WHERE id = OLD.reserved_cycle_id;
    IF NEW.reserved_cycle_id IS NOT NULL OR cycle_status NOT IN ('DRAFT','SUBMITTED','VOID','ARCHIVED') THEN
      RAISE EXCEPTION 'this unit is committed as a prize in a live cycle and cannot be released or moved'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_units_rules BEFORE UPDATE ON stock_units FOR EACH ROW EXECUTE FUNCTION enforce_stock_rules();
CREATE TRIGGER stock_units_no_delete BEFORE DELETE ON stock_units FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- A unit can only be reserved to a cycle that is still being prepared.
CREATE FUNCTION check_stock_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'RESERVED' AND OLD.status = 'IN_STOCK'
     AND (SELECT status FROM cycles WHERE id = NEW.reserved_cycle_id) NOT IN ('DRAFT','SUBMITTED') THEN
    RAISE EXCEPTION 'stock can only be reserved to a cycle that has not yet been approved' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_units_reservation BEFORE UPDATE ON stock_units FOR EACH ROW EXECUTE FUNCTION check_stock_reservation();

COMMIT;
