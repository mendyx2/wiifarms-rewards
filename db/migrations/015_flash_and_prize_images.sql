-- Pop-up announcements in the player app, and pictures of prizes.
BEGIN;

-- Announcements ("flash" pop-ups). One person writes, a Compliance officer who
-- did not write it approves, because anything shown to players about a
-- gambling product must be accurate. Approved text cannot be edited; it can
-- only be withdrawn.
CREATE TABLE flash_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_en      text NOT NULL CHECK (length(trim(title_en)) BETWEEN 1 AND 80),
  body_en       text NOT NULL CHECK (length(trim(body_en)) BETWEEN 1 AND 400),
  title_ha      text CHECK (title_ha IS NULL OR length(trim(title_ha)) BETWEEN 1 AND 80),
  body_ha       text CHECK (body_ha IS NULL OR length(trim(body_ha)) BETWEEN 1 AND 400),
  link          text CHECK (link IS NULL OR link ~ '^#/(home|buy|cards|wallet|draw|me|invite|support|inbox)$'),
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN')),
  created_by    uuid NOT NULL REFERENCES admin_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid REFERENCES admin_users(id),
  decided_at    timestamptz,
  CHECK (ends_at > starts_at),
  CHECK (decided_by IS NULL OR decided_by <> created_by)
);
CREATE INDEX flash_messages_live ON flash_messages (status, starts_at, ends_at);

CREATE FUNCTION protect_flash() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DELETE on flash_messages is not allowed: table is append-only'; END IF;
  IF (NEW.title_en, NEW.body_en, NEW.title_ha, NEW.body_ha, NEW.link, NEW.starts_at, NEW.ends_at, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.title_en, OLD.body_en, OLD.title_ha, OLD.body_ha, OLD.link, OLD.starts_at, OLD.ends_at, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'an announcement cannot be edited; withdraw it and write a new one' USING ERRCODE = '23000';
  END IF;
  IF NOT ((OLD.status = 'PENDING' AND NEW.status IN ('APPROVED','REJECTED','WITHDRAWN')) OR (OLD.status = 'APPROVED' AND NEW.status = 'WITHDRAWN')) THEN
    RAISE EXCEPTION 'an announcement cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER flash_messages_protect BEFORE UPDATE OR DELETE ON flash_messages FOR EACH ROW EXECUTE FUNCTION protect_flash();

-- One picture per prize. It can be added or replaced until sales open; after
-- that it is part of what players were shown and stays as it is.
CREATE TABLE prize_images (
  prize_tier_id uuid PRIMARY KEY REFERENCES prize_tiers(id),
  content_type  text NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
  bytes         bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 1048576),
  sha256        bytea NOT NULL,
  uploaded_by   uuid NOT NULL REFERENCES admin_users(id),
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION lock_prize_images() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT c.status INTO st FROM prize_tiers p JOIN cycles c ON c.id = p.cycle_id WHERE p.id = coalesce(NEW.prize_tier_id, OLD.prize_tier_id);
  IF st NOT IN ('DRAFT','SUBMITTED','APPROVED','COMMITTED') THEN
    RAISE EXCEPTION 'prize pictures cannot be changed once sales have opened' USING ERRCODE = '23000';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER prize_images_lock BEFORE INSERT OR UPDATE OR DELETE ON prize_images FOR EACH ROW EXECUTE FUNCTION lock_prize_images();

-- Latest instant wins for the home screen, without scanning a 400,000-card season.
CREATE INDEX tickets_recent_wins ON tickets (cycle_id, revealed_at DESC) WHERE revealed_outcome LIKE 'CASH:%';

COMMIT;
