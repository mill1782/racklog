-- Persistent likes/comments inbox. Safe to run repeatedly.
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  workout_date TEXT NOT NULL,
  workout_split TEXT NOT NULL,
  created INTEGER NOT NULL,
  unread INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS notifications_by_user ON notifications(user_id, created DESC);
