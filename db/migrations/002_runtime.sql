-- Phase 2 runtime tables: sign-in, per-cycle secrets, draw sign-offs.
BEGIN;

ALTER TABLE users
  ADD COLUMN pin_failed_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN pin_locked_until timestamptz;

-- One-time codes sent by SMS. Only a hash of the code is stored.
CREATE TABLE otp_challenges (
  phone_e164    text PRIMARY KEY,
  code_hash     bytea NOT NULL,
  expires_at    timestamptz NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  sends_in_window integer NOT NULL DEFAULT 1,
  window_started_at timestamptz NOT NULL DEFAULT now()
);

-- Session tokens are random; only their SHA-256 is stored, so a database leak
-- does not let anyone sign in.
CREATE TABLE sessions (
  token_hash  bytea PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);
CREATE TABLE admin_sessions (
  token_hash    bytea PRIMARY KEY,
  admin_user_id uuid NOT NULL REFERENCES admin_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);

-- Secrets created when a cycle is committed. Both values are encrypted; the
-- data key is wrapped by the key service (cloud KMS in production).
CREATE TABLE cycle_secrets (
  cycle_id              uuid PRIMARY KEY REFERENCES cycles(id),
  wrapped_data_key      bytea NOT NULL,
  draw_secret_ciphertext bytea NOT NULL,
  beacon_source         text NOT NULL,
  beacon_round          bigint NOT NULL
);
CREATE TRIGGER cycle_secrets_append_only BEFORE UPDATE OR DELETE ON cycle_secrets
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE draw_signoffs (
  cycle_id      uuid NOT NULL REFERENCES cycles(id),
  admin_user_id uuid NOT NULL REFERENCES admin_users(id),
  capacity      text NOT NULL CHECK (capacity IN ('OPERATOR','AUDITOR')),
  signed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cycle_id, admin_user_id)
);
CREATE TRIGGER draw_signoffs_append_only BEFORE UPDATE OR DELETE ON draw_signoffs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- The frozen list of entries a draw was run over, kept so anyone can re-run it.
CREATE TABLE draw_entry_snapshots (
  cycle_id    uuid PRIMARY KEY REFERENCES cycles(id),
  serials     text[] NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER draw_entry_snapshots_append_only BEFORE UPDATE OR DELETE ON draw_entry_snapshots
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Stand-in for a public randomness beacon while everything is simulated.
CREATE TABLE simulated_beacon_rounds (
  round   bigint PRIMARY KEY,
  value   bytea NOT NULL CHECK (octet_length(value) = 32)
);
CREATE TRIGGER simulated_beacon_append_only BEFORE UPDATE OR DELETE ON simulated_beacon_rounds
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMIT;
