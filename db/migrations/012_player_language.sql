-- The language a player reads: texts and in-app messages are written in it.
-- Set from the player app's English/Hausa switch.
BEGIN;
ALTER TABLE users ADD COLUMN language text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ha'));
COMMIT;
