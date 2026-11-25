-- Board decision: affiliates receive 10% of each referred card sale (it was
-- 2.5%–5%). Fees stay switched off until two people switch them on with the
-- legal approval's reference; the rate they would switch on is now 10%.
--
-- Prize catalogue (SRS WEB-003): each prize page shows its picture,
-- description, quantity, value, supplier, warranty and redemption
-- conditions, and an ordinary retail link so the product can be bought
-- without playing.
BEGIN;

ALTER TABLE affiliate_programme DROP CONSTRAINT affiliate_programme_rate_bp_check;
ALTER TABLE affiliate_programme ADD CONSTRAINT affiliate_programme_rate_bp_check CHECK (rate_bp BETWEEN 0 AND 1000);
ALTER TABLE affiliate_programme ALTER COLUMN rate_bp SET DEFAULT 1000;
UPDATE affiliate_programme SET rate_bp = 1000, updated_at = now() WHERE NOT remuneration_enabled;
ALTER TABLE affiliate_programme_changes DROP CONSTRAINT affiliate_programme_changes_rate_bp_check;
ALTER TABLE affiliate_programme_changes ADD CONSTRAINT affiliate_programme_changes_rate_bp_check CHECK (rate_bp BETWEEN 0 AND 1000);
ALTER TABLE affiliate_fees DROP CONSTRAINT affiliate_fees_rate_bp_check;
ALTER TABLE affiliate_fees ADD CONSTRAINT affiliate_fees_rate_bp_check CHECK (rate_bp BETWEEN 0 AND 1000);

ALTER TABLE skus ADD COLUMN retail_url text CHECK (retail_url ~ '^https://[^\s<>"]+$');
ALTER TABLE skus ADD COLUMN redemption_notes text CHECK (length(redemption_notes) <= 1000);

COMMIT;
