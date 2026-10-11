-- Public feedback: submitted by visitors, shown on /feedback only after the maintainer approves it.
-- email is private (never shown) and is deleted with the row. Rejected comments are deleted outright.
CREATE TABLE feedback (
  n            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   INTEGER NOT NULL,
  name         TEXT,
  role         TEXT NOT NULL,
  topic        TEXT NOT NULL,
  body         TEXT NOT NULL,
  email        TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published')),
  reply        TEXT,
  published_at INTEGER
);
CREATE INDEX feedback_status ON feedback (status, n);
