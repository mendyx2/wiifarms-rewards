-- Two-step sign-in for staff (SRS: administrator authentication, mandatory MFA).
--
-- After the first step (single sign-on in production; email in the simulation)
-- a staff member has only a short "pending" session, good for nothing but the
-- second step: a 6-digit code from an authenticator app (TOTP, RFC 6238) or a
-- one-time recovery code. The authenticator secret is encrypted by the key
-- service; recovery codes are stored only as keyed hashes. A code can be used
-- once; five wrong codes lock the account for 15 minutes and alert Compliance.
-- Resetting someone's two-step sign-in (a lost phone) takes two security
-- administrators, like any other access change.
BEGIN;

ALTER TABLE admin_users
  ADD COLUMN totp_secret_enc   bytea,
  ADD COLUMN totp_pending_enc  bytea,
  ADD COLUMN totp_enabled_at   timestamptz,
  ADD COLUMN totp_last_step    bigint,
  ADD COLUMN mfa_failures      integer NOT NULL DEFAULT 0,
  ADD COLUMN mfa_locked_until  timestamptz,
  ADD CONSTRAINT admin_users_totp CHECK ((totp_secret_enc IS NULL) = (totp_enabled_at IS NULL));

CREATE TABLE admin_recovery_codes (
  id             bigserial PRIMARY KEY,
  admin_user_id  uuid NOT NULL REFERENCES admin_users(id),
  code_hash      text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  used_at        timestamptz,
  UNIQUE (admin_user_id, code_hash)
);

ALTER TABLE admin_sessions ADD COLUMN stage text NOT NULL DEFAULT 'ACTIVE' CHECK (stage IN ('MFA_PENDING','ACTIVE'));

ALTER TABLE admin_access_requests DROP CONSTRAINT admin_access_requests_action_check;
ALTER TABLE admin_access_requests ADD CONSTRAINT admin_access_requests_action_check CHECK (action IN ('GRANT_ROLE','REVOKE_ROLE','ENABLE','RESET_MFA'));
ALTER TABLE admin_access_requests DROP CONSTRAINT admin_access_requests_check;
ALTER TABLE admin_access_requests ADD CONSTRAINT admin_access_requests_check CHECK ((action IN ('ENABLE','RESET_MFA')) = (role IS NULL));

COMMIT;
