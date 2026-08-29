-- Rack Log — D1 schema (phase 1, single player)
--
-- Apply with:
--   npx wrangler d1 execute racklog --file worker/schema.sql --remote
--
-- Safe to re-run: every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,   -- lowercased; what you type to sign in
  display       TEXT NOT NULL,          -- how it is shown back to you
  initials      TEXT NOT NULL,          -- for the crew disc in phase 2
  pin_hash      TEXT NOT NULL,          -- PBKDF2-SHA256, hex
  pin_salt      TEXT NOT NULL,          -- 16 random bytes, hex
  email         TEXT,                   -- the Google allowlist; NULL = PIN only
  google_sub    TEXT,                   -- Google's permanent id, bound on first
                                        -- sign-in. Matching is on this, never
                                        -- on email: an address can change hands.
  fails         INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER NOT NULL DEFAULT 0,
  created       INTEGER NOT NULL
);

-- UNIQUE, but SQLite allows any number of NULLs in a unique index, so several
-- PIN-only accounts coexist fine.
CREATE UNIQUE INDEX IF NOT EXISTS users_by_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS users_by_google ON users(google_sub);

-- One row per workout. `ex` is the exercise array as JSON, stored verbatim:
-- the kind model (lift / machine / tread) goes over the wire unchanged, so
-- adding a kind never touches this schema.
--
-- Deletes are tombstones, not removals. Emptying a session out deletes it in
-- the app, and a second device has to learn that; a vanished row is
-- indistinguishable from one it has not seen yet.
CREATE TABLE IF NOT EXISTS sessions (
  user_id    TEXT NOT NULL,
  id         TEXT NOT NULL,             -- client-generated: "s1", "u<ts>"
  date       TEXT NOT NULL,             -- ISO day
  split      TEXT NOT NULL,
  ex         TEXT NOT NULL,             -- JSON array of Exercise
  shared     INTEGER NOT NULL DEFAULT 0,
  from_json  TEXT,                      -- lineage; unused until phase 2
  updated    INTEGER NOT NULL,          -- server clock, ms — drives sync
  deleted    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);

-- The sync pull is "everything for this user changed since N", so this index
-- is the one query that matters.
CREATE INDEX IF NOT EXISTS sessions_by_updated ON sessions(user_id, updated);

-- Sign-in tokens, stored as SHA-256 of the cookie value: a dump of this table
-- does not hand anyone a usable session.
CREATE TABLE IF NOT EXISTS tokens (
  token    TEXT PRIMARY KEY,
  user_id  TEXT NOT NULL,
  expires  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS tokens_by_user ON tokens(user_id);

-- Likes and comments, one row each, keyed by FEED-item id ("<user_id>:<id>").
-- Engagement is far more frequent than posts, which is why it is rows and not
-- a JSON blob hanging off the session.
--
-- `user_id` is always the signed-in user from the cookie, never anything the
-- client sent -- the same rule /api/feed follows.
--
-- A like's `id` is derived (user|item|like) so a double tap cannot make two
-- rows: the toggle is a delete on one known key, then an insert if the delete
-- found nothing. Comment ids are random.
--
-- Rows outlive the session being unshared or deleted; the feed joins through
-- `sessions`, so they simply stop being visible, and come back if it is
-- reshared.
CREATE TABLE IF NOT EXISTS social (
  id       TEXT PRIMARY KEY,
  item_id  TEXT NOT NULL,             -- "<user_id>:<session_id>"
  user_id  TEXT NOT NULL,             -- who liked or said it
  kind     TEXT NOT NULL,             -- 'like' | 'comment'
  body     TEXT NOT NULL DEFAULT '',  -- the comment text; '' for a like
  created  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS social_by_item ON social(item_id, created);

-- ---------------------------------------------------------------------------
-- Invites. Until these existed, worker/adduser.mjs run by hand was the only
-- way an account came into being. That is safe and it does not scale past the
-- person with the terminal, so an invite is a bearer credential that buys
-- exactly one account and then stops working.
--
-- The code itself is NOT stored -- only its SHA-256, the same treatment the
-- session tokens get, because anyone holding it can make an account on this
-- server and see every shared workout. `id` is what the UI addresses a row by,
-- and it is safe to show.
CREATE TABLE IF NOT EXISTS invites (
  id         TEXT PRIMARY KEY,          -- addresses the row; not a secret
  code_hash  TEXT NOT NULL UNIQUE,      -- SHA-256 of the code in the link
  created_by TEXT NOT NULL,             -- who sent it
  created    INTEGER NOT NULL,
  expires    INTEGER NOT NULL,          -- created + 48h; checked on redeem
  used_by    TEXT,                      -- the account it became, once redeemed
  used       INTEGER,
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS invites_by_created ON invites(created);
