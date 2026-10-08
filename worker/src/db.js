// Database access (Cloudflare D1). Every query is parameterised; nothing user-supplied is concatenated into SQL.

export const PUBLIC_STATUSES = ["active", "disputed", "withdrawn"]; // shown in lookup; "removed" never is

export function recordFromRow(row) {
  if (!row) return null;
  return { id: row.id, status: row.status, registered: row.registered, updated: row.updated, ...JSON.parse(row.doc) };
}

// ---- daily counters -------------------------------------------------------------------------------------------
// Adds `weight` and returns the new total. Once the total has reached `max` the row is left alone (no write), so
// requests over the limit cost no database writes.
export async function bump(db, key, weight, expSeconds, max) {
  const row = await db.prepare(
    "INSERT INTO counters (k, n, exp) VALUES (?1, ?2, ?3) ON CONFLICT (k) DO UPDATE SET n = n + ?2 WHERE n < ?4 RETURNING n"
  ).bind(key, weight, expSeconds, max).first();
  return row ? row.n : max + 1;
}
export async function peek(db, key) {
  const row = await db.prepare("SELECT n FROM counters WHERE k = ?").bind(key).first();
  return row ? row.n : 0;
}

// ---- pending confirmations ------------------------------------------------------------------------------------
export function insertPending(db, p) {
  return db.prepare("INSERT INTO pending (token_hash, created_at, expires_at, email, email_hash, doc) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(p.tokenHash, p.now, p.expires, p.email, p.emailHash, JSON.stringify(p.doc)).run();
}
export async function getPending(db, tokenHash, now) {
  const row = await db.prepare("SELECT * FROM pending WHERE token_hash = ? AND expires_at > ?").bind(tokenHash, now).first();
  return row ? { ...row, doc: JSON.parse(row.doc) } : null;
}
export const deletePending = (db, tokenHash) => db.prepare("DELETE FROM pending WHERE token_hash = ?").bind(tokenHash).run();

// ---- records --------------------------------------------------------------------------------------------------
export const getRecordRow = (db, id) => db.prepare("SELECT * FROM records WHERE id = ?").bind(id).first();
export const getRecordBySrc = (db, srcHash) => db.prepare("SELECT * FROM records WHERE src_hash = ?").bind(srcHash).first();
export const getRecordByManage = (db, manageHash) => db.prepare("SELECT * FROM records WHERE manage_hash = ?").bind(manageHash).first();

// The next number for the year is chosen inside the INSERT itself, so two simultaneous confirmations cannot share one.
export async function createRecord(db, r) {
  const row = await db.prepare(
    `INSERT INTO records (id, yr, seq, status, registered, updated, isbn, search_key, work_key, email, email_hash, manage_hash, src_hash, doc)
     SELECT printf('ATI-%d-%06d-%s', ?1, n.s, ?2), ?1, n.s, 'active', ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
     FROM (SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM records WHERE yr = ?1) AS n
     RETURNING id`
  ).bind(r.year, r.suffix, r.today, r.isbn ?? null, r.searchKey, r.workKey, r.email, r.emailHash, r.manageHash, r.srcHash, JSON.stringify(r.doc)).first();
  return row.id;
}

// Optimistic concurrency: the update applies only if the record is still exactly as it was read (`prevDoc`).
// Returns the number of rows changed (0 = someone else changed it first).
// `manageHash` / `srcHash`, when given, replace the stored link hashes (used to retire them when a record is removed).
export async function updateRecord(db, id, f) {
  const res = await db.prepare(
    `UPDATE records SET status = ?, updated = ?, isbn = ?, search_key = ?, work_key = ?, email = ?, email_hash = ?, doc = ?,
       manage_hash = COALESCE(?, manage_hash), src_hash = COALESCE(?, src_hash) WHERE id = ? AND doc = ?`
  ).bind(f.status, f.updated, f.isbn ?? null, f.searchKey, f.workKey, f.email ?? null, f.emailHash, JSON.stringify(f.doc),
    f.manageHash ?? null, f.srcHash ?? null, id, f.prevDoc).run();
  return res.meta.changes;
}
export const isUniqueError = (e) => /UNIQUE constraint failed/i.test(String((e && e.message) || e));

// All replacements succeed or none does.
export const setManageHashes = (db, pairs) =>
  db.batch(pairs.map(([id, hash]) => db.prepare("UPDATE records SET manage_hash = ? WHERE id = ?").bind(hash, id)));

// An ISBN belongs to one live record (a withdrawn record releases it).
export function findIsbnOwner(db, isbn, exceptId = "") {
  return db.prepare("SELECT id FROM records WHERE isbn = ? AND status IN ('active', 'disputed') AND id != ? LIMIT 1").bind(isbn, exceptId).first();
}

// The same registrant declaring the same work twice (different ISBNs mean different editions).
export function findSameWork(db, emailHash, workKey, isbn, exceptId = "") {
  return db.prepare(
    `SELECT id FROM records WHERE email_hash = ?1 AND work_key = ?2 AND status IN ('active', 'disputed') AND id != ?4
       AND (isbn IS NULL OR ?3 IS NULL OR isbn = ?3) LIMIT 1`
  ).bind(emailHash, workKey, isbn ?? null, exceptId).first();
}

export const recordsByEmailHash = (db, emailHash) =>
  db.prepare("SELECT id, status FROM records WHERE email_hash = ? AND status != 'removed' ORDER BY id LIMIT 50").bind(emailHash).all().then((r) => r.results);

export function lookupIsbn(db, isbn, limit) {
  return db.prepare(`SELECT * FROM records WHERE isbn = ? AND status IN ('active', 'disputed', 'withdrawn') ORDER BY registered DESC, id LIMIT ?`)
    .bind(isbn, limit).all().then((r) => r.results);
}

// instr() rather than LIKE: D1 refuses LIKE patterns over 50 bytes, and instr needs no wildcard escaping.
export function searchWords(db, words, limit) {
  const like = words.map(() => "instr(search_key, ?) > 0").join(" AND ");
  return db.prepare(`SELECT * FROM records WHERE status IN ('active', 'disputed', 'withdrawn') AND ${like} ORDER BY registered DESC, id LIMIT ?`)
    .bind(...words, limit).all().then((r) => r.results);
}

// ---- reports --------------------------------------------------------------------------------------------------
export async function insertReport(db, r) {
  const row = await db.prepare(
    "INSERT INTO reports (created_at, record_id, reason, details, reporter_email) VALUES (?, ?, ?, ?, ?) RETURNING n"
  ).bind(r.now, r.recordId, r.reason, r.details, r.email ?? null).first();
  return row.n;
}
export const listReports = (db, status) =>
  db.prepare("SELECT * FROM reports WHERE status = ? ORDER BY n DESC LIMIT 100").bind(status).all().then((r) => r.results);
export const reportsFor = (db, recordId) =>
  db.prepare("SELECT * FROM reports WHERE record_id = ? ORDER BY n DESC LIMIT 50").bind(recordId).all().then((r) => r.results);
export const closeReport = (db, n, note) => db.prepare("UPDATE reports SET status = 'closed', note = ? WHERE n = ?").bind(note, n).run();

export const adminLog = (db, e) => db.prepare("INSERT INTO admin_log (at, record_id, action, note) VALUES (?, ?, ?, ?)").bind(e.at, e.recordId, e.action, e.note ?? null).run();
export const adminLogFor = (db, id) => db.prepare("SELECT * FROM admin_log WHERE record_id = ? ORDER BY n DESC LIMIT 50").bind(id).all().then((r) => r.results);

// ---- admin & upkeep -------------------------------------------------------------------------------------------
export const recentRecords = (db, limit) =>
  db.prepare("SELECT * FROM records ORDER BY registered DESC, id DESC LIMIT ?").bind(limit).all().then((r) => r.results);
export async function counts(db) {
  const r = await db.prepare(
    "SELECT status, COUNT(*) AS c FROM records GROUP BY status").all();
  const out = { active: 0, disputed: 0, withdrawn: 0, removed: 0 };
  for (const x of r.results) out[x.status] = x.c;
  return out;
}

export async function cleanup(db, now) {
  await db.batch([
    db.prepare("DELETE FROM pending WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM counters WHERE exp <= ?").bind(now),
    db.prepare("DELETE FROM reports WHERE status = 'closed' AND created_at < ?").bind(now - 365 * 86400),
  ]);
}
