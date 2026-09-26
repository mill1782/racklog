-- Android Web Push subscriptions and quiet-notification throttling.
-- Safe to run repeatedly.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subscriptions_by_user ON push_subscriptions(user_id);
CREATE TABLE IF NOT EXISTS push_throttle (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  last_sent INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id, kind)
);
