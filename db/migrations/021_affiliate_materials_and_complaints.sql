-- The affiliate portal (SRS section 13): the approved content library with
-- version control (AFF-005, AFF-011), and complaints and investigations
-- (AFF-009).
--
-- Materials: whoever writes a version cannot approve it; Compliance approves.
-- An approved version is never changed: a correction is a new version, and
-- approving it retires the previous one. Affiliates only ever see the current
-- approved version, with their own attribution link put in.
--
-- Complaints: anyone (a player, the public through support, or staff) can
-- report an affiliate. Compliance investigates and records findings and the
-- outcome; suspending or ending the affiliate goes through the usual decision.
BEGIN;

CREATE TABLE marketing_materials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  channel     text NOT NULL CHECK (channel IN ('WHATSAPP','SMS','SOCIAL','PRINT','RADIO')),
  created_by  uuid NOT NULL REFERENCES admin_users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketing_material_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id   uuid NOT NULL REFERENCES marketing_materials(id),
  version       integer NOT NULL CHECK (version > 0),
  body_en       text NOT NULL CHECK (length(body_en) BETWEEN 10 AND 1000),
  body_ha       text CHECK (length(body_ha) <= 1000),
  image         bytea CHECK (octet_length(image) <= 1048576),
  content_type  text CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
  sha256        bytea NOT NULL,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','RETIRED')),
  written_by    uuid NOT NULL REFERENCES admin_users(id),
  decided_by    uuid REFERENCES admin_users(id),
  decided_at    timestamptz,
  retired_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (material_id, version),
  CHECK (decided_by IS NULL OR decided_by <> written_by),
  CHECK ((status = 'PENDING') = (decided_by IS NULL)),
  CHECK ((image IS NULL) = (content_type IS NULL)),
  -- Every message must carry the responsible-play line.
  CHECK (body_en ~* '18\+')
);
CREATE UNIQUE INDEX marketing_material_one_current ON marketing_material_versions (material_id) WHERE status = 'APPROVED';
CREATE UNIQUE INDEX marketing_material_one_pending ON marketing_material_versions (material_id) WHERE status = 'PENDING';

-- Versions are never edited or deleted; only their status moves forward.
CREATE FUNCTION protect_material_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DELETE on marketing_material_versions is not allowed: table is append-only'; END IF;
  IF (NEW.material_id, NEW.version, NEW.body_en, NEW.body_ha, NEW.image, NEW.content_type, NEW.sha256, NEW.written_by, NEW.created_at)
     IS DISTINCT FROM (OLD.material_id, OLD.version, OLD.body_en, OLD.body_ha, OLD.image, OLD.content_type, OLD.sha256, OLD.written_by, OLD.created_at)
     OR NOT ((OLD.status = 'PENDING' AND NEW.status IN ('APPROVED','REJECTED')) OR (OLD.status = 'APPROVED' AND NEW.status = 'RETIRED')) THEN
    RAISE EXCEPTION 'an approved or submitted marketing text cannot be edited: write a new version' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER marketing_material_versions_protect BEFORE UPDATE OR DELETE ON marketing_material_versions FOR EACH ROW EXECUTE FUNCTION protect_material_version();

CREATE TABLE affiliate_complaints (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference        text NOT NULL UNIQUE,
  affiliate_id     uuid REFERENCES affiliates(id),          -- NULL when the reporter could not say which affiliate
  reported_code    text,
  source           text NOT NULL CHECK (source IN ('PLAYER','STAFF')),
  reporter_user_id uuid REFERENCES users(id),
  reporter_admin_id uuid REFERENCES admin_users(id),
  category         text NOT NULL CHECK (category IN ('MISLEADING','UNDERAGE','PRESSURE','UNAPPROVED_MATERIAL','PAID_SIGNUPS','IMPERSONATION','OTHER')),
  description      text NOT NULL CHECK (length(description) BETWEEN 5 AND 2000),
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','INVESTIGATING','UPHELD','DISMISSED')),
  investigator_id  uuid REFERENCES admin_users(id),
  findings         text,
  outcome          text CHECK (outcome IN ('NO_ACTION','WARNING','SUSPENDED','TERMINATED')),
  decided_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((source = 'PLAYER') = (reporter_user_id IS NOT NULL)),
  CHECK ((source = 'STAFF') = (reporter_admin_id IS NOT NULL)),
  CHECK ((status IN ('UPHELD','DISMISSED')) = (findings IS NOT NULL AND outcome IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status = 'OPEN' OR investigator_id IS NOT NULL),
  CHECK (status <> 'DISMISSED' OR outcome = 'NO_ACTION'),
  -- Nobody investigates a complaint they made.
  CHECK (investigator_id IS NULL OR investigator_id IS DISTINCT FROM reporter_admin_id)
);
CREATE SEQUENCE affiliate_complaint_seq;
CREATE INDEX affiliate_complaints_open ON affiliate_complaints (created_at) WHERE status IN ('OPEN','INVESTIGATING');

-- A concluded complaint is final.
CREATE FUNCTION protect_complaint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DELETE on affiliate_complaints is not allowed'; END IF;
  IF OLD.status IN ('UPHELD','DISMISSED') OR (NEW.reference, NEW.source, NEW.reporter_user_id, NEW.reporter_admin_id, NEW.category, NEW.description, NEW.created_at)
     IS DISTINCT FROM (OLD.reference, OLD.source, OLD.reporter_user_id, OLD.reporter_admin_id, OLD.category, OLD.description, OLD.created_at) THEN
    RAISE EXCEPTION 'a complaint''s report cannot be changed, and a concluded complaint is final' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER affiliate_complaints_protect BEFORE UPDATE OR DELETE ON affiliate_complaints FOR EACH ROW EXECUTE FUNCTION protect_complaint();

COMMIT;
