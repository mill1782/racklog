-- Adds the invite table to a database made before invites existed.
-- Re-runnable: every statement is IF NOT EXISTS.
--
--   npx wrangler d1 execute racklog --remote --file worker/migrate-invites.sql

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
