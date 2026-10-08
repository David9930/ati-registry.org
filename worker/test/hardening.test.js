// Regression tests for the findings of the independent security review.
import test from "node:test";
import assert from "node:assert/strict";
import { site, GOOD } from "./helpers.js";
import { ipKey } from "../src/util.js";
import { updateRecord, isUniqueError } from "../src/db.js";
import { resetKeyCache } from "../src/admin.js";
import { T0 } from "./helpers.js";

const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const plain = (over = {}) => site({ MAX_EMAILS_PER_ADDR_DAY: "99", MAX_REG_PER_IP_DAY: "99", MAX_EMAILS_TOTAL_DAY: "999", ...over });
const b64u = (buf) => Buffer.from(buf).toString("base64url");

// ---- search ------------------------------------------------------------------------------------------------------
test("a long word (CJK title, 60 bytes) can be registered and searched without an error", async () => {
  const s = plain();
  const title = "三体三体三体三体三体三体三体三体三体三体";
  const { id } = await s.register({ title, isbn: "" });
  const r = await s.get("/lookup?q=" + encodeURIComponent(title));
  assert.equal(r.status, 200);
  assert.ok(r.text.includes(id));
});

test("an ISBN cannot be found by its digits in a text search, only exactly", async () => {
  const s = plain();
  const { id } = await s.register();
  assert.ok(!s.env.DB.q("SELECT search_key FROM records")[0].search_key.match(/\d{4}/) || !s.env.DB.q("SELECT search_key FROM records")[0].search_key.includes("97803"));
  for (const frag of ["97803064", "0306406", "9780306", "306406157"]) {
    const r = await s.get("/lookup?q=" + frag);
    assert.ok(!r.text.includes(id), frag);
  }
  assert.ok((await s.get("/lookup?q=978-0-306-40615-7")).text.includes(id));
});

test("text searches have a global daily budget", async () => {
  const s = plain({ MAX_SEARCHES_TOTAL_DAY: "2", MAX_LOOKUPS_PER_IP_DAY: "99" });
  await s.register();
  assert.equal((await s.get("/lookup?q=test+book")).status, 200);
  assert.equal((await s.get("/lookup?q=test+book")).status, 200);
  assert.equal((await s.get("/lookup?q=test+book")).status, 503);
  assert.equal((await s.get("/lookup?q=9780306406157")).status, 200, "exact ISBN lookups are not text searches");
});

// ---- limits ------------------------------------------------------------------------------------------------------
test("IPv6 visitors are limited per /64, not per address", () => {
  assert.equal(ipKey("2001:db8:1:2:3:4:5:6"), ipKey("2001:db8:1:2:ffff:eeee:dddd:cccc"));
  assert.equal(ipKey("2001:db8:1:2::1"), ipKey("2001:DB8:1:2:0:0:0:9"));
  assert.notEqual(ipKey("2001:db8:1:2::1"), ipKey("2001:db8:1:3::1"));
  assert.equal(ipKey("203.0.113.7"), "203.0.113.7");
  assert.equal(ipKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(ipKey("::1"), "0000:0000:0000:0000");
  assert.equal(ipKey("unknown"), "unknown");
});

test("addresses in one /64 share a limit; another network does not", async () => {
  const s = plain({ MAX_LOOKUPS_PER_IP_DAY: "2" });
  const get = (ip) => s.get("/lookup?q=nothing+here", { ip });
  assert.equal((await get("2001:db8:aa:bb::1")).status, 200);
  assert.equal((await get("2001:db8:aa:bb:1111:2222:3333:4444")).status, 200);
  assert.equal((await get("2001:db8:aa:bb:5::6")).status, 429);
  assert.equal((await get("2001:db8:aa:cc::1")).status, 200);
});

test("requests over a limit cost no database writes", async () => {
  const s = plain({ MAX_LOOKUPS_PER_IP_DAY: "2" });
  for (let i = 0; i < 3; i++) await s.get("/lookup?q=nothing+here");
  const n = () => s.env.DB.q("SELECT n FROM counters WHERE k LIKE 'look:%'")[0].n;
  const before = n();
  for (let i = 0; i < 5; i++) assert.equal((await s.get("/lookup?q=nothing+here")).status, 429);
  assert.equal(n(), before);
});

test("text that cannot be a record ID costs no database write", async () => {
  const s = plain();
  assert.equal((await s.get("/r/not-an-id")).status, 404);
  assert.equal(s.env.DB.q("SELECT COUNT(*) AS c FROM counters")[0].c, 0);
  assert.equal((await s.get("/r/ATI-2026-000999-AAAA")).status, 404);
  assert.equal(s.env.DB.q("SELECT COUNT(*) AS c FROM counters")[0].c, 1);
});

test("name+tag@ addresses count as one mailbox for the email limit", async () => {
  const s = plain({ MAX_EMAILS_PER_ADDR_DAY: "2" });
  const go = (email, n) => s.post("/register", { ...GOOD, email, isbn: "", title: "T" + n, "cf-turnstile-response": "ok" });
  assert.equal((await go("me@example.com", 1)).status, 200);
  assert.equal((await go("me+one@example.com", 2)).status, 200);
  assert.equal((await go("me+two@example.com", 3)).status, 429);
});

test("lost-link requests and registration emails have separate budgets", async () => {
  const s = plain({ MAX_EMAILS_PER_ADDR_DAY: "1", MAX_LOST_PER_ADDR_DAY: "1" });
  await s.register(); // uses the address's one registration email
  const n = s.mails.length;
  await s.post("/manage/lost", { email: "author@example.com", "cf-turnstile-response": "ok" });
  assert.equal(s.mails.length, n + 1, "the lost-link mail is still sent");
});

test("the lost-link reply is the same for every address, and the work happens after it", async () => {
  const s = plain();
  await s.register();
  const known = await s.post("/manage/lost", { email: "author@example.com", "cf-turnstile-response": "ok" });
  assert.equal(s.waits, 1, "mailing is deferred");
  const unknown = await s.post("/manage/lost", { email: "nobody@example.com", "cf-turnstile-response": "ok" });
  assert.equal(s.waits, 1);
  assert.equal(known.status, unknown.status);
  assert.equal(known.text, unknown.text);
});

test("a confirmation that cannot create a record does not use up the daily registration budget", async () => {
  const s = plain({ MAX_REG_TOTAL_DAY: "2" });
  // two people start registering the same ISBN before either confirms
  const link = async (email, over = {}) => {
    const before = s.mails.length;
    await s.post("/register", { ...GOOD, email, ...over, "cf-turnstile-response": "ok" });
    return s.mails[before].text.match(/verify\?t=([A-Za-z0-9_-]{43})/)[1];
  };
  const a = await link("a@example.com"), b = await link("b@example.com"), c = await link("c@example.com", { isbn: "", title: "Other" });
  assert.equal((await s.post("/verify", { t: a })).status, 200);
  assert.equal((await s.post("/verify", { t: b })).status, 409);
  assert.equal((await s.post("/verify", { t: c })).status, 200, "the failed confirmation did not use a slot");
  const d = await link("d@example.com", { isbn: "", title: "Fourth" });
  assert.equal((await s.post("/verify", { t: d })).status, 503, "two records exist, so the day's budget is spent");
});

// ---- races -------------------------------------------------------------------------------------------------------
// Runs `action` once, directly on the database, immediately before the first statement matching `re` executes.
function beforeStatement(s, re, action) {
  const db = s.env.DB, prepare = db.prepare.bind(db);
  let done = false;
  db.prepare = (sql) => { if (!done && re.test(sql)) { done = true; action(); } return prepare(sql); };
}

test("an edit made from a stale read cannot undo a maintainer's removal", async () => {
  const s = plain();
  const { id, token } = await s.register();
  beforeStatement(s, /^UPDATE records SET status/, () => {
    s.env.DB.sqlite.prepare("UPDATE records SET status = 'removed', email = NULL, doc = ? WHERE id = ?").run('{"removed":true}', id);
  });
  const r = await s.post(`/manage/${token}/edit`, { ...GOOD, title: "Brought Back", attest: GOOD.attest });
  assert.equal(r.status, 409);
  assert.match(text(r.text), /changed while you were working/);
  const row = s.env.DB.q("SELECT status, doc FROM records")[0];
  assert.equal(row.status, "removed");
  assert.ok(!row.doc.includes("Brought Back"));
});

test("a withdrawal made from a stale read is refused too", async () => {
  const s = plain();
  const { id, token } = await s.register();
  beforeStatement(s, /^UPDATE records SET status/, () => {
    s.env.DB.sqlite.prepare("UPDATE records SET doc = doc || ' ' WHERE id = ?").run(id);
  });
  assert.equal((await s.post(`/manage/${token}/withdraw`, { confirm: "yes" })).status, 409);
  assert.equal(s.env.DB.q("SELECT status FROM records")[0].status, "active");
});

test("updateRecord applies only to the version that was read", async () => {
  const s = plain();
  const { id } = await s.register();
  const row = s.env.DB.q("SELECT * FROM records")[0];
  const f = { status: "active", updated: "2026-10-08", isbn: row.isbn, searchKey: row.search_key, workKey: row.work_key, email: row.email, emailHash: row.email_hash, doc: JSON.parse(row.doc) };
  assert.equal(await updateRecord(s.env.DB, id, { ...f, prevDoc: row.doc + "x" }), 0);
  assert.equal(await updateRecord(s.env.DB, id, { ...f, prevDoc: row.doc }), 1);
});

test("two live records cannot share an ISBN, even when confirmations race", async () => {
  const s = plain();
  const before = s.mails.length;
  await s.post("/register", { ...GOOD, email: "slow@example.com", "cf-turnstile-response": "ok" });
  const t = s.mails[before].text.match(/verify\?t=([A-Za-z0-9_-]{43})/)[1];
  // someone else's record takes the ISBN after the checks pass but before the insert
  beforeStatement(s, /^INSERT INTO records/, () => {
    s.env.DB.sqlite.prepare(`INSERT INTO records (id, yr, seq, status, registered, updated, isbn, search_key, work_key, email, email_hash, manage_hash, src_hash, doc)
      VALUES ('ATI-2026-000001-RACE', 2026, 1, 'active', '2026-10-08', '2026-10-08', '9780306406157', '', '', 'x@example.com', 'h', 'm', 's', '{}')`).run();
  });
  const r = await s.post("/verify", { t });
  assert.equal(r.status, 409);
  assert.match(r.text, /ATI-2026-000001-RACE/);
  assert.equal(s.env.DB.q("SELECT COUNT(*) AS c FROM records WHERE isbn = '9780306406157'")[0].c, 1);
  assert.equal(s.env.DB.q("SELECT COUNT(*) AS c FROM pending")[0].c, 0);
});

test("the database itself refuses a second live record with the same ISBN, but allows it once the first is withdrawn", async () => {
  const s = plain();
  await s.register();
  const ins = (id, seq, status) => s.env.DB.sqlite.prepare(`INSERT INTO records (id, yr, seq, status, registered, updated, isbn, search_key, work_key, email, email_hash, manage_hash, src_hash, doc)
    VALUES (?, 2026, ?, ?, 'd', 'd', '9780306406157', '', '', 'e', 'h', ?, ?, '{}')`).run(id, seq, status, "m" + seq, "s" + seq);
  assert.throws(() => ins("ATI-2026-000009-AAAA", 9, "active"), (e) => isUniqueError(e));
  assert.doesNotThrow(() => ins("ATI-2026-000008-AAAA", 8, "withdrawn"));
  assert.doesNotThrow(() => ins("ATI-2026-000007-AAAA", 7, "removed"));
});

// ---- bot check -----------------------------------------------------------------------------------------------------
test("the bot check must be for this site and for this form", async () => {
  const s = plain();
  const reg = () => s.post("/register", { ...GOOD, "cf-turnstile-response": "ok" });
  s.turnstileHost = "evil.example";
  assert.equal((await reg()).status, 400, "token issued for another site");
  s.turnstileHost = undefined;
  s.turnstileAction = "report";
  assert.equal((await reg()).status, 400, "token issued for another form");
  s.turnstileAction = undefined;
  assert.equal((await reg()).status, 200);
});

test("each form's widget names its action", async () => {
  const s = plain();
  assert.ok((await s.get("/register")).text.includes('data-action="register"'));
  assert.ok((await s.get("/report")).text.includes('data-action="report"'));
  assert.ok((await s.get("/manage/lost")).text.includes('data-action="lost"'));
});

// ---- the maintainer's notes ----------------------------------------------------------------------------------------
const TEAM = "team.cloudflareaccess.com", AUD = "aud-tag";
async function adminHeaders(s) {
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  s.jwks = [{ ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1" }];
  const head = b64u(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const claims = b64u(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], email: "admin@example.org", exp: Math.floor(T0 / 1000) + 600 }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(`${head}.${claims}`));
  return { headers: { "cf-access-jwt-assertion": `${head}.${claims}.${b64u(sig)}` } };
}

test("private notes stay private; a dispute note is public by design", async () => {
  resetKeyCache();
  const s = plain();
  const { id } = await s.register();
  const h = await adminHeaders(s);
  await s.post(`/admin/r/${id}`, { act: "dispute", note: "PUBLIC-DISPUTE-NOTE about the translation" }, h);
  await s.post(`/admin/r/${id}`, { act: "resolve", note: "PRIVATE-RESOLVE-NOTE" }, h);
  await s.post(`/admin/r/${id}`, { act: "withdraw", note: "PRIVATE-WITHDRAW-NOTE" }, h);
  await s.post(`/admin/r/${id}`, { act: "reinstate", note: "PRIVATE-REINSTATE-NOTE" }, h);
  const pub = (await s.get("/r/" + id)).text;
  assert.ok(!pub.includes("PRIVATE-"), "no private note on the public page");
  assert.ok(!s.env.DB.q("SELECT doc FROM records")[0].doc.includes("PRIVATE-"), "none in the stored public record");
  const view = (await s.get(`/admin/r/${id}`, h)).text;
  for (const n of ["PRIVATE-RESOLVE-NOTE", "PRIVATE-WITHDRAW-NOTE", "PRIVATE-REINSTATE-NOTE"]) assert.ok(view.includes(n), n);
  assert.equal(s.env.DB.q("SELECT COUNT(*) AS c FROM admin_log")[0].c, 4);
});

test("a maintainer action made from a stale page is refused", async () => {
  resetKeyCache();
  const s = plain();
  const { id } = await s.register();
  const h = await adminHeaders(s);
  beforeStatement(s, /^UPDATE records SET status/, () => {
    s.env.DB.sqlite.prepare("UPDATE records SET doc = doc || ' ' WHERE id = ?").run(id);
  });
  const r = await s.post(`/admin/r/${id}`, { act: "remove", note: "x" }, h);
  assert.equal(r.status, 409);
  assert.equal(s.env.DB.q("SELECT status FROM records")[0].status, "active");
  assert.equal(s.env.DB.q("SELECT COUNT(*) AS c FROM admin_log")[0].c, 0);
});

test("reinstating a record whose ISBN has since been taken is refused with a message", async () => {
  resetKeyCache();
  const s = plain();
  const a = await s.register();
  const h = await adminHeaders(s);
  await s.post(`/manage/${a.token}/withdraw`, { confirm: "yes" });
  await s.register({ email: "other@example.com", title: "Other Edition" }); // same ISBN, now free
  const r = await s.post(`/admin/r/${a.id}`, { act: "reinstate" }, h);
  assert.equal(r.status, 409);
  assert.match(text(r.text), /Another live record already has this ISBN/);
  assert.equal(s.env.DB.q("SELECT status FROM records WHERE id = ?", a.id)[0].status, "withdrawn");
});

// ---- history and honeypot ------------------------------------------------------------------------------------------
test("an edit says in the public history which parts changed", async () => {
  const s = plain();
  const { id, token } = await s.register();
  const edit = (over) => s.post(`/manage/${token}/edit`, { ...GOOD, ...over });
  assert.equal((await edit({ title: "A Different Book", label: "human-authored", ai_tools: "", cover: "none" })).status, 200);
  const history = JSON.parse(s.env.DB.q("SELECT doc FROM records WHERE id = ?", id)[0].doc).history;
  const note = history.at(-1).note;
  assert.match(note, /^Changed: .*title/);
  assert.match(note, /label/);
  assert.equal((await edit({ title: "A Different Book", label: "human-authored", ai_tools: "", cover: "none" })).status, 200);
  assert.equal(JSON.parse(s.env.DB.q("SELECT doc FROM records WHERE id = ?", id)[0].doc).history.at(-1).note, "No change to the declaration itself.");
});

test("the hidden trap field has an unremarkable-to-autofill name and is on every form", async () => {
  const s = plain();
  for (const p of ["/register", "/report", "/manage/lost"]) {
    const html = (await s.get(p)).text;
    assert.ok(html.includes('name="ati_trap"'), p);
    assert.ok(!html.includes('name="website"'), p);
  }
});

test("a missing HASH_SECRET fails loudly in the log and not with a silent wrong answer", async () => {
  const s = plain({ HASH_SECRET: "" });
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    assert.equal((await s.get("/lookup?q=some+title")).status, 500);
  } finally { console.error = orig; }
  assert.ok(errors.some((e) => e.includes("HASH_SECRET is not set")));
});
