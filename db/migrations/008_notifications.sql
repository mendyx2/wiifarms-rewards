-- Notifications: an outbox written in the same transaction as the event, so a
-- message is never sent for something that did not happen, and never twice.
BEGIN;

CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  channel      text NOT NULL CHECK (channel IN ('IN_APP','SMS')),
  kind         text NOT NULL,
  title        text NOT NULL,
  body         text NOT NULL,
  link         text,                      -- screen in the app the message refers to
  dedupe_key   text NOT NULL,
  status       text NOT NULL CHECK (status IN ('QUEUED','SENT','FAILED')),
  attempts     integer NOT NULL DEFAULT 0,
  not_before   timestamptz NOT NULL DEFAULT now(),   -- quiet hours: non-urgent texts wait for daytime
  provider_ref text,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  read_at      timestamptz,
  UNIQUE (dedupe_key, channel),
  CHECK ((status = 'SENT') = (sent_at IS NOT NULL))
);
CREATE INDEX notifications_inbox ON notifications (user_id, created_at DESC) WHERE channel = 'IN_APP';
CREATE INDEX notifications_queue ON notifications (not_before) WHERE status = 'QUEUED';

-- Messages are never deleted and their text is never changed.
CREATE FUNCTION protect_notifications() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (NEW.user_id, NEW.channel, NEW.kind, NEW.title, NEW.body, NEW.dedupe_key, NEW.created_at)
     IS DISTINCT FROM (OLD.user_id, OLD.channel, OLD.kind, OLD.title, OLD.body, OLD.dedupe_key, OLD.created_at) THEN
    RAISE EXCEPTION 'a notification''s recipient and text cannot be changed or removed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notifications_protect BEFORE UPDATE OR DELETE ON notifications FOR EACH ROW EXECUTE FUNCTION protect_notifications();

COMMIT;
