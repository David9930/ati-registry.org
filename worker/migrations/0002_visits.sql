-- A short log of page views, only to produce the maintainer's daily summary email: time, page, approximate place
-- (from Cloudflare) and a coarse visitor type. No IP address and no user-agent text. Rows are deleted once they have
-- been emailed, and in any case after three days.
CREATE TABLE visits (
  n       INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  region  TEXT NOT NULL DEFAULT '',
  path    TEXT NOT NULL,
  kind    TEXT NOT NULL,
  sent    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX visits_unsent ON visits (sent, n);
CREATE INDEX visits_at ON visits (at);
