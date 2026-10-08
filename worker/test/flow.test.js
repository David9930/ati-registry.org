import test from "node:test";
import assert from "node:assert/strict";
import { site, GOOD, T0 } from "./helpers.js";

const ID = /ATI-2026-\d{6}-[0-9A-HJKMNP-TV-Z]{4}/;
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("the register page shows the form, the bot check and strict headers", async () => {
  const s = site();
  const { res, text: html, status } = await s.get("/register");
  assert.equal(status, 200);
  assert.ok(html.includes('class="cf-turnstile" data-sitekey="site-key"'));
  assert.ok(html.includes('name="email"') && html.includes('name="attest"'));
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.ok(!html.includes("@@"), "unreplaced placeholder");
});

test("registration is closed until the bot check is configured", async () => {
  const s = site({ TURNSTILE_SITEKEY: "" });
  const g = await s.get("/register");
  assert.match(g.text, /not open yet/);
  assert.ok(!g.text.includes("<form method=\"post\" action=\"/register\""));
  assert.equal((await s.post("/register", { ...GOOD })).status, 503);
});

test("register, confirm by email, then the record is public", async () => {
  const s = site();
  const r = await s.post("/register", { ...GOOD, "cf-turnstile-response": "ok" });
  assert.equal(r.status, 200);
  assert.match(r.text, /Check your email/);
  assert.equal(s.mails.length, 1);
  assert.equal(s.mails[0].to, "author@example.com");
  assert.equal(s.env.DB.q("SELECT COUNT(*) AS c FROM records")[0].c, 0, "nothing is published before the link is opened");
  assert.equal(s.env.DB.q("SELECT COUNT(*) AS c FROM pending")[0].c, 1);

  const token = s.mails[0].text.match(/verify\?t=([A-Za-z0-9_-]{43})/)[1];
  const page = await s.get("/verify?t=" + token);
  assert.equal(page.status, 200);
  assert.equal(page.res.headers.get("referrer-policy"), "same-origin");
  assert.equal(s.env.DB.q("SELECT COUNT(*) AS c FROM records")[0].c, 0, "opening the link alone (a mail scanner) does not register");

  const v = await s.post("/verify", { t: token });
  assert.equal(v.status, 200);
  const id = v.text.match(/class="record-id">([^<]+)</)[1];
  assert.match(id, ID);
  assert.match(v.text, /Keep this link private/);
  assert.equal(s.mails.length, 2, "receipt email");
  assert.match(s.mails[1].text, new RegExp(id));
  assert.equal(s.env.DB.q("SELECT COUNT(*) AS c FROM pending")[0].c, 0);

  const rec = await s.get("/r/" + id);
  assert.equal(rec.status, 200);
  const plain = text(rec.text);
  assert.ok(plain.includes("Test Book") && plain.includes("AI Master Edited") && plain.includes("9780306406157"));
  assert.ok(!rec.text.includes("author@example.com"), "the email address is never public");
  assert.ok(!rec.text.includes("@@"));
  assert.match(rec.text, /declared by|Declared by/i);
  const row = s.env.DB.q("SELECT * FROM records")[0];
  assert.equal(row.email, "author@example.com");
  assert.ok(!row.doc.includes("author@example.com"), "the email is not part of the public document");
  assert.ok(!JSON.stringify(s.env.DB.q("SELECT * FROM counters")).includes("203.0.113.7"), "no raw IP address is stored");
});

test("confirming twice does not create a second record", async () => {
  const s = site();
  const a = await s.register();
  const again = await s.post("/verify", { t: a.verifyToken });
  assert.match(text(again.text), /already confirmed/i);
  assert.equal(s.env.DB.q("SELECT COUNT(*) AS c FROM records")[0].c, 1);
});

test("confirmation links expire after 48 hours", async () => {
  const s = site();
  await s.post("/register", { ...GOOD, "cf-turnstile-response": "ok" });
  const token = s.mails[0].text.match(/verify\?t=([A-Za-z0-9_-]{43})/)[1];
  s.now = T0 + 49 * 3600 * 1000;
  assert.equal((await s.get("/verify?t=" + token)).status, 404);
  assert.equal((await s.post("/verify", { t: token })).status, 404);
  assert.equal(s.env.DB.q("SELECT COUNT(*) AS c FROM records")[0].c, 0);
});

test("a bad or missing token is not found", async () => {
  const s = site();
  for (const t of ["", "abc", "x".repeat(43), "x".repeat(44)]) assert.equal((await s.get("/verify?t=" + t)).status, 404, t);
});

test("submitted text is escaped everywhere", async () => {
  const s = site();
  const evil = '</title><script>alert("t")</script>';
  const { id } = await s.register({
    title: evil, author: '"><img src=x onerror=alert(1)>', statement: "x".repeat(10) + "</script><script>alert(2)</script>" + "y".repeat(10),
    ai_tools: "<b>bold</b> tool", url: "https://example.com/?a=1&b=2", subtitle: "&amp; <i>x</i>", edition: "<u>1st</u>",
  });
  const html = (await s.get("/r/" + id)).text;
  assert.ok(!html.includes("<script>alert"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("<b>bold</b>"));
  assert.ok(!html.includes("<i>x</i>") && !html.includes("<u>1st"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  const ld = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)];
  assert.equal(ld.length, 1);
  assert.ok(!ld[0][1].includes("<"));
  JSON.parse(ld[0][1]);
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.deepEqual(scripts, ['<script type="application/ld+json">']);
  assert.ok(!/\son[a-z]+="/.test(html));
  assert.match(html, /rel="nofollow noopener noreferrer ugc"/);
  // the redisplayed form also escapes what was typed
  const bad = await s.post("/register", { ...GOOD, title: '"><script>alert(9)</script>', year: "1", "cf-turnstile-response": "ok" });
  assert.equal(bad.status, 400);
  assert.ok(!bad.text.includes("<script>alert(9)"));
});

test("a placeholder in submitted text is not interpreted", async () => {
  const s = site();
  const { id } = await s.register({ title: "@@CONTENT@@ $& $1 @@ID@@ @@U@@", statement: "I wrote this: @@TITLE@@ and $& and $` and $'. Fine." });
  const html = (await s.get("/r/" + id)).text;
  assert.ok(html.includes("@@CONTENT@@ $&amp; $1 @@ID@@ @@U@@"));
  assert.ok(html.includes("@@TITLE@@ and $&amp; and $` and $&#39;."));
});

test("invalid submissions are redisplayed with the entries kept and nothing stored", async () => {
  const s = site();
  const r = await s.post("/register", { ...GOOD, title: "Kept title", year: "20", "cf-turnstile-response": "ok" });
  assert.equal(r.status, 400);
  assert.match(r.text, /four-digit year/);
  assert.ok(r.text.includes('value="Kept title"'));
  assert.ok(/value="ai-master-edited" checked/.test(r.text));
  assert.equal(s.mails.length, 0);
  assert.equal(s.env.DB.q("SELECT COUNT(*) AS c FROM pending")[0].c, 0);
});

test("a failed bot check stores nothing", async () => {
  const s = site();
  s.turnstileOk = false;
  const r = await s.post("/register", { ...GOOD, "cf-turnstile-response": "bad" });
  assert.equal(r.status, 400);
  assert.match(r.text, /bot check/);
  assert.equal(s.mails.length, 0);
  const none = await s.post("/register", { ...GOOD });
  assert.equal(none.status, 400);
});

test("the honeypot gets a fake success and stores nothing", async () => {
  const s = site();
  const r = await s.post("/register", { ...GOOD, ati_trap: "http://spam.example", "cf-turnstile-response": "ok" });
  assert.equal(r.status, 200);
  assert.match(r.text, /Check your email/);
  assert.equal(s.mails.length, 0);
  assert.equal(s.env.DB.q("SELECT COUNT(*) AS c FROM pending")[0].c, 0);
});

test("an email failure leaves nothing pending", async () => {
  const s = site();
  s.mailFails = true;
  const r = await s.post("/register", { ...GOOD, "cf-turnstile-response": "ok" });
  assert.equal(r.status, 503);
  assert.equal(s.env.DB.q("SELECT COUNT(*) AS c FROM pending")[0].c, 0);
});

test("an ISBN can be registered once; a withdrawn record releases it", async () => {
  const s = site();
  const first = await s.register();
  const dup = await s.post("/register", { ...GOOD, email: "other@example.com", "cf-turnstile-response": "ok" });
  assert.equal(dup.status, 400);
  assert.ok(dup.text.includes(first.id));
  await s.post(`/manage/${first.token}/withdraw`, { confirm: "yes" });
  const again = await s.post("/register", { ...GOOD, email: "other@example.com", "cf-turnstile-response": "ok" });
  assert.equal(again.status, 200);
});

test("the same registrant cannot declare the same work twice, but another edition is fine", async () => {
  const s = site();
  await s.register({ isbn: "" });
  const t = s.mails.length;
  await s.post("/register", { ...GOOD, isbn: "", "cf-turnstile-response": "ok" });
  const token = s.mails[t].text.match(/verify\?t=([A-Za-z0-9_-]{43})/)[1];
  const v = await s.post("/verify", { t: token });
  assert.equal(v.status, 409);
  assert.match(text(v.text), /already registered this work/);
  const ok = await s.register({ isbn: "", edition: "Second Edition" });
  assert.match(ok.id, ID);
});

test("IDs count up per year and carry a random suffix", async () => {
  const s = site();
  const a = await s.register({ isbn: "", title: "One" });
  const b = await s.register({ isbn: "", title: "Two" });
  assert.match(a.id, /^ATI-2026-000001-/);
  assert.match(b.id, /^ATI-2026-000002-/);
  s.now = Date.parse("2027-01-02T00:00:00Z");
  const c = await s.register({ isbn: "", title: "Three", year: "2027" });
  assert.match(c.id, /^ATI-2027-000001-/);
});

test("daily limits: registrations per visitor, messages per address, views and searches", async () => {
  let s = site({ MAX_REG_PER_IP_DAY: "2" });
  for (let i = 0; i < 2; i++) assert.equal((await s.post("/register", { ...GOOD, email: `a${i}@example.com`, isbn: "", title: "T" + i, "cf-turnstile-response": "ok" })).status, 200);
  assert.equal((await s.post("/register", { ...GOOD, email: "a9@example.com", "cf-turnstile-response": "ok" })).status, 429);
  assert.equal((await s.post("/register", { ...GOOD, email: "a9@example.com", "cf-turnstile-response": "ok" }, { ip: "198.51.100.9" })).status, 200, "another visitor is not limited");

  s = site({ MAX_EMAILS_PER_ADDR_DAY: "2" });
  for (let i = 0; i < 2; i++) await s.post("/register", { ...GOOD, isbn: "", title: "T" + i, "cf-turnstile-response": "ok" });
  assert.equal((await s.post("/register", { ...GOOD, isbn: "", title: "T9", "cf-turnstile-response": "ok" })).status, 429);

  s = site({ MAX_VIEWS_PER_IP_DAY: "3" });
  const { id } = await s.register();
  for (let i = 0; i < 3; i++) assert.equal((await s.get("/r/" + id)).status, 200);
  assert.equal((await s.get("/r/" + id)).status, 429);
  s.now += 86400000; // the next day
  assert.equal((await s.get("/r/" + id)).status, 200);

  s = site({ MAX_VIEWS_PER_IP_DAY: "7" });
  assert.equal((await s.get("/r/ATI-2026-000001-AAAA")).status, 404); // a miss costs 5
  assert.equal((await s.get("/r/ATI-2026-000001-AAAB")).status, 429);

  s = site({ MAX_LOOKUPS_PER_IP_DAY: "2" });
  for (let i = 0; i < 2; i++) assert.equal((await s.get("/lookup?q=something")).status, 200);
  assert.equal((await s.get("/lookup?q=something")).status, 429);
});

test("the daily cap on confirmed registrations holds the confirmation until tomorrow", async () => {
  const s = site({ MAX_REG_TOTAL_DAY: "1" });
  await s.register({ isbn: "", title: "One" });
  await s.post("/register", { ...GOOD, isbn: "", title: "Two", email: "two@example.com", "cf-turnstile-response": "ok" });
  const token = s.mails.at(-1).text.match(/verify\?t=([A-Za-z0-9_-]{43})/)[1];
  assert.equal((await s.post("/verify", { t: token })).status, 503);
  s.now += 86400000;
  assert.equal((await s.post("/verify", { t: token })).status, 200);
});

test("lookup by ID, ISBN and words; short queries and removed records give nothing", async () => {
  const s = site();
  const a = await s.register({ title: "The Lighthouse Keeper", author: "Mary Fenwick", isbn: "978-0-306-40615-7" });
  await s.register({ title: "Lighthouse Nights", author: "Pat Lowe", isbn: "" });
  assert.equal((await s.get("/lookup?q=" + a.id.toLowerCase())).location, "/r/" + a.id);
  assert.match((await s.get("/lookup?q=0-306-40615-2")).text, /The Lighthouse Keeper/);
  const words = (await s.get("/lookup?q=lighthouse")).text;
  assert.ok(words.includes("The Lighthouse Keeper") && words.includes("Lighthouse Nights"));
  const one = (await s.get("/lookup?q=lighthouse+fenwick")).text;
  assert.ok(one.includes("The Lighthouse Keeper") && !one.includes("Lighthouse Nights"));
  assert.match((await s.get("/lookup?q=abc")).text, /at least four characters/);
  assert.match((await s.get("/lookup?q=zzzzzz")).text, /No matching record/);
  assert.equal((await s.get("/lookup")).location, "/registry/");
  assert.ok(!(await s.get("/lookup?q=%25%25%25%25")).text.includes("Lighthouse"), "wildcards are not interpreted");
  assert.ok(!(await s.get("/lookup?q=____")).text.includes("Lighthouse"));
});

test("a title search shows at most five records and nothing in bulk is served", async () => {
  const s = site({ MAX_REG_PER_IP_DAY: "99", MAX_EMAILS_PER_ADDR_DAY: "99", MAX_REG_TOTAL_DAY: "99" });
  for (let i = 0; i < 7; i++) await s.register({ title: "Common Title " + i, isbn: "" });
  const html = (await s.get("/lookup?q=common+title")).text;
  assert.equal((html.match(/class="record-id"|class="mono">ATI-/g) || []).length, 5);
  assert.match(html, /first 5 matches/);
  for (const p of ["/api/records.json", "/api/records", "/records", "/registry/all", "/sitemap.xml"]) {
    const r = await s.get(p);
    assert.ok(!/Common Title/.test(r.text), p);
  }
});

test("missing and malformed record IDs are not found", async () => {
  const s = site();
  for (const p of ["/r/nope", "/r/ATI-2026-000001", "/r/ATI-2026-000001-ZZZZ", "/r/%E0%A4%A", "/r/ATI-2026-000001-ILOU"]) {
    const r = await s.get(p);
    assert.equal(r.status, 404, p);
    assert.match(text(r.text), /not found/i, p);
  }
});

test("HEAD works and other methods are refused", async () => {
  const s = site();
  assert.equal((await s.req("HEAD", "/lookup?q=zzzzzz")).status, 200);
  assert.equal((await s.req("PUT", "/register")).status, 405);
  assert.equal((await s.req("DELETE", "/r/x")).status, 405);
});

test("form posts must come from this site", async () => {
  const s = site();
  const form = { ...GOOD, "cf-turnstile-response": "ok" };
  assert.equal((await s.post("/register", form, { origin: "https://evil.example" })).status, 403);
  assert.equal((await s.post("/register", form, { origin: false })).status, 403);
  assert.equal((await s.post("/register", form, { origin: "null" })).status, 403); // sandboxed frames and data: pages
  assert.equal((await s.post("/register", form, { origin: false, headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await s.post("/register", form, { origin: false, headers: { "sec-fetch-site": "same-origin" } })).status, 200);
  assert.equal(s.mails.length, 1);
});

test("oversized, unreadable and mistyped bodies are refused", async () => {
  const s = site();
  assert.equal((await s.post("/register", "x=" + "y".repeat(50000))).status, 413);
  assert.equal((await s.req("POST", "/register", { form: "a=b", headers: { "content-length": "999999" } })).status, 413);
  const r = await s.req("POST", "/register", { headers: { "content-type": "application/json", "content-length": "2" }, form: undefined });
  assert.equal(r.status, 415);
});

test("a very long field cannot overflow the form handling", async () => {
  const s = site();
  const r = await s.post("/register", { ...GOOD, statement: "word ".repeat(7000), "cf-turnstile-response": "ok" });
  assert.equal(r.status, 400);
  assert.match(r.text, /1,500/);
});

test("www redirects to the main address", async () => {
  const s = site();
  const res = await (await import("../src/index.js")).handle(new Request("https://www.ati-registry.org/labels/?x=1"), s.env, {}, s.deps());
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "https://ati-registry.org/labels/?x=1");
});

test("unknown paths get the site-styled not-found page", async () => {
  const s = site();
  const r = await s.get("/nothing-here");
  assert.equal(r.status, 404);
  assert.match(r.text, /Page not found/);
});

test("static pages are served by the assets binding (the site, labels, terms)", async () => {
  const s = site();
  assert.equal((await s.get("/labels/")).status, 200);
  assert.match((await s.get("/terms/")).text, /Terms of use/);
  assert.match((await s.get("/")).text, /Authorship Transparency Identifier/);
});

test("scheduled clean-up removes expired confirmations and counters", async () => {
  const s = site();
  await s.post("/register", { ...GOOD, "cf-turnstile-response": "ok" });
  const { cleanup } = await import("../src/db.js");
  await cleanup(s.env.DB, Math.floor(T0 / 1000));
  assert.equal(s.env.DB.q("SELECT COUNT(*) AS c FROM pending")[0].c, 1);
  assert.ok(s.env.DB.q("SELECT COUNT(*) AS c FROM counters")[0].c > 0);
  await cleanup(s.env.DB, Math.floor(T0 / 1000) + 3 * 86400);
  assert.equal(s.env.DB.q("SELECT COUNT(*) AS c FROM pending")[0].c, 0);
  assert.equal(s.env.DB.q("SELECT COUNT(*) AS c FROM counters")[0].c, 0);
});
