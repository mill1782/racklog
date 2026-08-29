-- Follows, and passwords instead of PINs. Apply BEFORE deploying that version:
--
--   npx wrangler d1 execute racklog --remote --file worker/migrate-follows.sql
--
-- NOT re-runnable: the two RENAME COLUMN statements fail the second time,
-- exactly like worker/migrate-google.sql. The renames are cosmetic in the
-- sense that the bytes do not change -- a PIN was already PBKDF2-SHA256 with
-- a per-user salt, and a password is the same hash of a longer secret, so
-- everybody who had a PIN can sign in with those digits as their password
-- until they change it on the profile screen.
ALTER TABLE users RENAME COLUMN pin_hash TO pass_hash;
ALTER TABLE users RENAME COLUMN pin_salt TO pass_salt;

-- ---------------------------------------------------------------------------
-- The follow graph. Added 2026-08-29, when "the crew" stopped meaning "every
-- account on this server" and started meaning "the people you follow".
--
-- Instant, not approved: tapping Follow is a write, not a request. Mark's
-- call, Twitter's model. The consequence lives in the feed query -- a shared
-- session is visible to its owner and to every follower, and to nobody else.
--
-- No row for following yourself. Your own workouts are in your own feed
-- because the query says so, not because of a self-edge that every count
-- would then have to subtract.
CREATE TABLE IF NOT EXISTS follows (
  follower TEXT NOT NULL,             -- who is doing the following
  followee TEXT NOT NULL,             -- who they follow
  created  INTEGER NOT NULL,
  PRIMARY KEY (follower, followee)    -- makes a double tap idempotent
);
-- "who follows me" -- the count on the profile screen, and nothing else yet.
CREATE INDEX IF NOT EXISTS follows_by_followee ON follows(followee);
