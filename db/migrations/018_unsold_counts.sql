-- Unsold cards per cycle and level, kept by the database itself as cards change
-- state, so "cards left" is a lookup rather than a count over millions of rows.
-- Statement-level triggers see each statement's changed rows at once (a 20,000-
-- card insert is one counter update, not 20,000).
BEGIN;

CREATE TABLE cycle_unsold (
  cycle_id  uuid NOT NULL REFERENCES cycles(id),
  level     integer NOT NULL CHECK (level >= 0),
  unsold    integer NOT NULL CHECK (unsold >= 0),
  PRIMARY KEY (cycle_id, level)
);

CREATE FUNCTION count_unsold_inserted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO cycle_unsold (cycle_id, level, unsold)
  SELECT n.cycle_id, n.leaf_index / (c.total_tickets / c.levels), count(*)
  FROM new_rows n JOIN cycles c ON c.id = n.cycle_id WHERE n.status = 'UNSOLD' GROUP BY 1, 2
  ON CONFLICT (cycle_id, level) DO UPDATE SET unsold = cycle_unsold.unsold + EXCLUDED.unsold;
  RETURN NULL;
END $$;
CREATE TRIGGER tickets_count_inserted AFTER INSERT ON tickets REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION count_unsold_inserted();

CREATE FUNCTION count_unsold_updated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE cycle_unsold u SET unsold = u.unsold + s.delta
  FROM (SELECT n.cycle_id, n.leaf_index / (c.total_tickets / c.levels) AS level,
               sum((n.status = 'UNSOLD')::int - (o.status = 'UNSOLD')::int) AS delta
        FROM new_rows n JOIN old_rows o ON o.id = n.id JOIN cycles c ON c.id = n.cycle_id
        WHERE n.status IS DISTINCT FROM o.status GROUP BY 1, 2) s
  WHERE u.cycle_id = s.cycle_id AND u.level = s.level AND s.delta <> 0;
  RETURN NULL;
END $$;
CREATE TRIGGER tickets_count_updated AFTER UPDATE ON tickets REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION count_unsold_updated();

-- Cycles that already have cards.
INSERT INTO cycle_unsold (cycle_id, level, unsold)
SELECT t.cycle_id, t.leaf_index / (c.total_tickets / c.levels), count(*) FILTER (WHERE t.status = 'UNSOLD')
FROM tickets t JOIN cycles c ON c.id = t.cycle_id GROUP BY 1, 2;

COMMIT;
