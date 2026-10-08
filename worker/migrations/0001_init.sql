-- Private registry database. Nothing here is served in bulk; records are read one at a time by the Worker.

-- A registration waiting for the email link to be opened. Deleted on confirmation or after 48 hours.
CREATE TABLE pending (
  token_hash TEXT PRIMARY KEY,          -- sha256 of the emailed token (the token itself is never stored)
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  email      TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  doc        TEXT NOT NULL              -- validated declaration, JSON
);
CREATE INDEX pending_expires ON pending (expires_at);

CREATE TABLE records (
  id          TEXT PRIMARY KEY,         -- ATI-YYYY-NNNNNN-XXXX
  yr          INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('active', 'disputed', 'withdrawn', 'removed')),
  registered  TEXT NOT NULL,
  updated     TEXT NOT NULL,
  isbn        TEXT,
  search_key  TEXT NOT NULL DEFAULT '',
  work_key    TEXT NOT NULL DEFAULT '',
  email       TEXT,                     -- private; deleted when a record is removed
  email_hash  TEXT NOT NULL,
  manage_hash TEXT NOT NULL UNIQUE,     -- sha256 of the private management token
  src_hash    TEXT UNIQUE,              -- the confirmation token hash this record came from (makes confirming idempotent)
  doc         TEXT NOT NULL,            -- the public declaration and its history, JSON
  UNIQUE (yr, seq)
);
CREATE INDEX records_isbn ON records (isbn);
-- An ISBN belongs to one live record; the database enforces it even when two confirmations race.
CREATE UNIQUE INDEX records_isbn_live ON records (isbn) WHERE isbn IS NOT NULL AND status IN ('active', 'disputed');
CREATE INDEX records_email ON records (email_hash);

CREATE TABLE reports (
  n              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at     INTEGER NOT NULL,
  record_id      TEXT NOT NULL,
  reason         TEXT NOT NULL,
  details        TEXT NOT NULL,
  reporter_email TEXT,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  note           TEXT
);
CREATE INDEX reports_status ON reports (status);

-- The maintainer's private notes on actions taken (never shown publicly).
CREATE TABLE admin_log (
  n         INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  record_id TEXT NOT NULL,
  action    TEXT NOT NULL,
  note      TEXT
);
CREATE INDEX admin_log_record ON admin_log (record_id);

-- Daily limits. Keys contain a date and a salted hash, never a raw IP address or email address.
CREATE TABLE counters (
  k   TEXT PRIMARY KEY,
  n   INTEGER NOT NULL,
  exp INTEGER NOT NULL
);
CREATE INDEX counters_exp ON counters (exp);
