-- Rack Log — add Google sign-in to an existing database.
--
--   npx wrangler d1 execute racklog --remote --file worker/migrate-google.sql
--
-- Run this ONCE per database. Unlike schema.sql this is NOT re-runnable:
-- SQLite has no "ADD COLUMN IF NOT EXISTS", so a second run fails with
-- "duplicate column name". That failure is harmless — it means it already ran.
--
-- A fresh database does not need this file at all; schema.sql has the columns.

ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN google_sub TEXT;

-- UNIQUE, but SQLite allows any number of NULLs in a unique index, so PIN-only
-- accounts with neither field set coexist fine.
CREATE UNIQUE INDEX IF NOT EXISTS users_by_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS users_by_google ON users(google_sub);
