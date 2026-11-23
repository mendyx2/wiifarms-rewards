-- Customer support: players' requests and staff replies, and account locks
-- for suspected takeovers (one person locks; a different Compliance officer unlocks).
BEGIN;

CREATE TABLE support_tickets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  topic        text NOT NULL CHECK (topic IN ('PAYMENT','PRIZE','ACCOUNT','TECHNICAL','COMPLAINT','OTHER')),
  subject      text NOT NULL CHECK (length(trim(subject)) > 0),
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','WAITING_PLAYER','CLOSED')),
  escalated    boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  closed_by    uuid REFERENCES admin_users(id),
  CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);
CREATE INDEX support_tickets_queue ON support_tickets (status, updated_at);
CREATE INDEX support_tickets_user ON support_tickets (user_id, created_at DESC);
CREATE TRIGGER support_tickets_no_delete BEFORE DELETE ON support_tickets FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- The conversation is a permanent record: messages are never edited or removed.
CREATE TABLE support_messages (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id       uuid NOT NULL REFERENCES support_tickets(id),
  author          text NOT NULL CHECK (author IN ('PLAYER','STAFF')),
  admin_user_id   uuid REFERENCES admin_users(id),
  body            text NOT NULL CHECK (length(trim(body)) > 0 AND length(body) <= 2000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((author = 'STAFF') = (admin_user_id IS NOT NULL))
);
CREATE INDEX support_messages_ticket ON support_messages (ticket_id, id);
CREATE TRIGGER support_messages_append_only BEFORE UPDATE OR DELETE ON support_messages FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE player_locks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  reason       text NOT NULL CHECK (length(trim(reason)) > 0),
  locked_by    uuid NOT NULL REFERENCES admin_users(id),
  locked_at    timestamptz NOT NULL DEFAULT now(),
  lifted_by    uuid REFERENCES admin_users(id),
  lifted_at    timestamptz,
  lift_reason  text,
  CHECK (lifted_by IS NULL OR lifted_by <> locked_by),
  CHECK ((lifted_by IS NULL) = (lifted_at IS NULL)),
  CHECK (lifted_by IS NULL OR length(trim(coalesce(lift_reason, ''))) > 0)
);
CREATE UNIQUE INDEX player_locks_one_active ON player_locks (user_id) WHERE lifted_at IS NULL;
CREATE FUNCTION protect_player_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.lifted_at IS NOT NULL
     OR (NEW.user_id, NEW.reason, NEW.locked_by, NEW.locked_at) IS DISTINCT FROM (OLD.user_id, OLD.reason, OLD.locked_by, OLD.locked_at) THEN
    RAISE EXCEPTION 'an account lock cannot be changed once lifted, and its details cannot be edited' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER player_locks_protect BEFORE UPDATE OR DELETE ON player_locks FOR EACH ROW EXECUTE FUNCTION protect_player_lock();

COMMIT;
