import test from "node:test";
import assert from "node:assert/strict";
import { site, GOOD } from "./helpers.js";

const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const row = (s, id) => s.env.DB.q("SELECT * FROM records WHERE id = ?", id)[0];

test("the private link shows the record and offers the actions", async () => {
  const s = site();
  const { id, token } = await s.register();
  const m = await s.get("/manage/" + token);
  assert.equal(m.status, 200);
  assert.ok(m.text.includes(id) && m.text.includes(`/manage/${token}/edit`) && m.text.includes(`/manage/${token}/withdraw`));
  assert.equal(m.res.headers.get("referrer-policy"), "same-origin");
  assert.match(m.res.headers.get("x-robots-tag"), /noindex/);
});

test("wrong, malformed and replaced links are not found, and guessing is limited", async () => {
  const s = site();
  await s.register();
  for (const t of ["x".repeat(43), "short", "x".repeat(44)]) assert.equal((await s.get("/manage/" + t)).status, 404);
  assert.equal((await s.post(`/manage/${"y".repeat(43)}/withdraw`, { confirm: "yes" })).status, 404);
  let last = 0;
  for (let i = 0; i < 20; i++) last = (await s.get("/manage/" + "z".repeat(43))).status;
  assert.equal(last, 429);
});

test("correcting a record updates it, searches and the history", async () => {
  const s = site();
  const { id, token } = await s.register();
  const form = await s.get(`/manage/${token}/edit`);
  assert.equal(form.status, 200);
  assert.ok(form.text.includes('value="Test Book"') && /value="ai-master-edited" checked/.test(form.text));
  assert.ok(!/name="attest"[^>]*checked/.test(form.text), "confirmations must be ticked again");
  assert.ok(!form.text.includes('name="email"'));
  assert.ok(/<option value="author" selected>/.test(form.text), "the role is prefilled");
  assert.ok(/<option value="generated" selected>/.test(form.text), "the components are prefilled");

  const bad = await s.post(`/manage/${token}/edit`, { ...GOOD, title: "", attest: [] });
  assert.equal(bad.status, 400);
  assert.equal(row(s, id).updated, "2026-10-08");

  s.now += 86400000;
  const ok = await s.post(`/manage/${token}/edit`, { ...GOOD, title: "Renamed Book", label: "ai-co-authored", statement: "Human and AI wrote this together, in several passes." });
  assert.equal(ok.status, 200);
  assert.match(ok.text, /corrections are saved/);
  const r = row(s, id);
  const doc = JSON.parse(r.doc);
  assert.equal(doc.work.title, "Renamed Book");
  assert.equal(doc.label, "ai-co-authored");
  assert.equal(r.updated, "2026-10-09");
  assert.deepEqual(doc.history.map((h) => h.event), ["registered", "corrected"]);
  assert.equal(doc.history[1].by, "registrant");
  assert.match((await s.get("/lookup?q=renamed")).text, /Renamed Book/);
  assert.ok(!(await s.get("/lookup?q=test+book")).text.includes(id));
  assert.match(text((await s.get("/r/" + id)).text), /Renamed Book/);
});

test("an edit cannot take another record's ISBN", async () => {
  const s = site();
  await s.register();
  const b = await s.register({ isbn: "", title: "Other", email: "other@example.com" });
  const r = await s.post(`/manage/${b.token}/edit`, { ...GOOD, title: "Other", isbn: "978-0-306-40615-7" });
  assert.equal(r.status, 400);
  assert.match(r.text, /registered under another record/);
});

test("withdrawing needs the box ticked, keeps the record visible and cannot be undone by the owner", async () => {
  const s = site();
  const { id, token } = await s.register();
  assert.equal((await s.post(`/manage/${token}/withdraw`, {})).status, 409);
  assert.equal(row(s, id).status, "active");
  const w = await s.post(`/manage/${token}/withdraw`, { confirm: "yes" });
  assert.equal(w.status, 200);
  assert.equal(row(s, id).status, "withdrawn");
  const page = (await s.get("/r/" + id)).text;
  assert.match(page, /Withdrawn\./);
  assert.match(page, /pill withdrawn/);
  assert.equal((await s.get(`/manage/${token}/edit`)).status, 409);
  assert.equal((await s.post(`/manage/${token}/withdraw`, { confirm: "yes" })).status, 409);
  assert.deepEqual(JSON.parse(row(s, id).doc).history.map((h) => h.event), ["registered", "withdrawn"]);
});

test("a disputed record cannot be withdrawn by its owner", async () => {
  const s = site();
  const { id, token } = await s.register();
  s.env.DB.sqlite.prepare("UPDATE records SET status = 'disputed' WHERE id = ?").run(id);
  const w = await s.post(`/manage/${token}/withdraw`, { confirm: "yes" });
  assert.equal(w.status, 409);
  assert.equal(row(s, id).status, "disputed");
});

test("a lost link: new links replace the old, and the same answer is given for unknown addresses", async () => {
  const s = site();
  const a = await s.register();
  const before = s.mails.length;
  const unknown = await s.post("/manage/lost", { email: "nobody@example.com", "cf-turnstile-response": "ok" });
  const known = await s.post("/manage/lost", { email: "AUTHOR@example.com", "cf-turnstile-response": "ok" });
  assert.equal(unknown.status, 200);
  assert.equal(text(unknown.text), text(known.text));
  assert.equal(s.mails.length, before + 1, "only the known address receives mail");
  const mail = s.mails.at(-1);
  assert.equal(mail.to, "author@example.com");
  const fresh = mail.text.match(/manage\/([A-Za-z0-9_-]{43})/)[1];
  assert.notEqual(fresh, a.token);
  assert.equal((await s.get("/manage/" + a.token)).status, 404);
  assert.equal((await s.get("/manage/" + fresh)).status, 200);
});

test("a lost-link email that fails to send leaves the old link working", async () => {
  const s = site();
  const a = await s.register();
  s.mailFails = true;
  await s.post("/manage/lost", { email: "author@example.com", "cf-turnstile-response": "ok" });
  assert.equal((await s.get("/manage/" + a.token)).status, 200);
});

test("the lost-link form needs the bot check and is rate limited per address", async () => {
  const s = site({ MAX_LOST_PER_ADDR_DAY: "1" });
  await s.register();
  s.turnstileOk = false;
  assert.equal((await s.post("/manage/lost", { email: "author@example.com", "cf-turnstile-response": "x" })).status, 400);
  s.turnstileOk = true;
  await s.post("/manage/lost", { email: "author@example.com", "cf-turnstile-response": "ok" });
  const n = s.mails.length;
  await s.post("/manage/lost", { email: "author+again@example.com", "cf-turnstile-response": "ok" }); // same mailbox, already used its one message today
  assert.equal(s.mails.length, n);
});

test("reports are stored privately and the maintainer is told", async () => {
  const s = site();
  const { id } = await s.register();
  const g = await s.get("/report/" + id.toLowerCase());
  assert.ok(g.text.includes(`value="${id}"`));
  const n = s.mails.length;
  const r = await s.post("/report", { record: id, reason: "inaccurate", details: "This is plainly wrong because of <b>reasons</b>.", email: "me@example.com", "cf-turnstile-response": "ok" });
  assert.equal(r.status, 200);
  const rows = s.env.DB.q("SELECT * FROM reports");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].record_id, id);
  assert.equal(s.mails.length, n + 1);
  assert.equal(s.mails.at(-1).to, "admin@example.org");
  assert.ok(!(await s.get("/r/" + id)).text.includes("plainly wrong"), "reports are never public");
});

test("report validation and spam defences", async () => {
  const s = site({ MAX_REPORTS_PER_IP_DAY: "99" });
  const { id } = await s.register();
  const ok = { record: id, reason: "inaccurate", details: "x".repeat(30), "cf-turnstile-response": "ok" };
  assert.equal((await s.post("/report", { ...ok, record: "nope" })).status, 400);
  assert.equal((await s.post("/report", { ...ok, record: "ATI-2026-000099-AAAA" })).status, 400);
  assert.equal((await s.post("/report", { ...ok, reason: "__proto__" })).status, 400);
  assert.equal((await s.post("/report", { ...ok, details: "short" })).status, 400);
  assert.equal((await s.post("/report", { ...ok, email: "bad" })).status, 400);
  s.turnstileOk = false;
  assert.equal((await s.post("/report", ok)).status, 400);
  s.turnstileOk = true;
  assert.equal((await s.post("/report", { ...ok, ati_trap: "spam" })).status, 200);
  assert.equal(s.env.DB.q("SELECT COUNT(*) AS c FROM reports")[0].c, 0);
});
