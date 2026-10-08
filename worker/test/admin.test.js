import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { site, repoRoot, T0 } from "./helpers.js";
import { resetKeyCache } from "../src/admin.js";
import { recordFromRow } from "../src/db.js";

const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const TEAM = "team.cloudflareaccess.com", AUD = "aud-tag";

const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1" };

async function token(over = {}, { kid = "k1", key = kp.privateKey, alg = "RS256" } = {}) {
  const head = b64u(JSON.stringify({ alg, kid, typ: "JWT" }));
  const claims = b64u(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], email: "admin@example.org", exp: Math.floor(T0 / 1000) + 600, ...over }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64u(sig)}`;
}
const admin = async (s, over, opts) => ({ headers: { "cf-access-jwt-assertion": await token(over, opts) } });
const setup = () => { resetKeyCache(); const s = site({ MAX_EMAILS_PER_ADDR_DAY: "99", MAX_REG_PER_IP_DAY: "99" }); s.jwks = [jwk]; return s; };

test("the admin page is invisible without a valid Access token", async () => {
  const s = setup();
  assert.equal((await s.get("/admin")).status, 404);
  assert.equal((await s.get("/admin/r/ATI-2026-000001-AAAA")).status, 404);
  assert.equal((await s.get("/admin", { headers: { "cf-access-jwt-assertion": "a.b.c" } })).status, 404);
  assert.equal((await s.get("/admin", await admin(s))).status, 200);
});

test("tokens with the wrong audience, issuer, expiry, address, key or algorithm are refused", async () => {
  const s = setup();
  const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const cases = {
    "wrong audience": await admin(s, { aud: ["other"] }),
    "wrong issuer": await admin(s, { iss: "https://evil.cloudflareaccess.com" }),
    expired: await admin(s, { exp: Math.floor(T0 / 1000) - 1 }),
    "not yet valid": await admin(s, { nbf: Math.floor(T0 / 1000) + 3600 }),
    "other person": await admin(s, { email: "someone@example.org" }),
    "no email (service token)": await admin(s, { email: undefined }),
    "unknown key id": await admin(s, {}, { kid: "nope" }),
    "forged signature": await admin(s, {}, { key: other.privateKey }),
    "wrong algorithm": await admin(s, {}, { alg: "none" }),
  };
  for (const [name, opts] of Object.entries(cases)) assert.equal((await s.get("/admin", opts)).status, 404, name);
  assert.equal((await s.get("/admin", await admin(s, { aud: AUD }))).status, 200, "aud as a plain string is accepted");
});

test("the admin page stays closed when Access is not configured", async () => {
  resetKeyCache();
  for (const missing of ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "ADMIN_EMAIL"]) {
    const s = site({ [missing]: "" });
    s.jwks = [jwk];
    assert.equal((await s.get("/admin", await admin(s))).status, 404, missing);
  }
});

test("admin actions need a same-site form post", async () => {
  const s = setup();
  const { id } = await s.register();
  const h = await admin(s);
  assert.equal((await s.post(`/admin/r/${id}`, { act: "withdraw" }, { ...h, origin: "https://evil.example" })).status, 403);
  assert.equal((await s.post(`/admin/r/${id}`, { act: "withdraw" }, { ...h, origin: false })).status, 403);
});

test("dashboard, dispute, resolve, withdraw and reinstate", async () => {
  const s = setup();
  const { id } = await s.register();
  const h = await admin(s);
  await s.post("/report", { record: id, reason: "inaccurate", details: "The statement does not match the book.", "cf-turnstile-response": "ok" });
  const dash = await s.get("/admin", h);
  assert.ok(dash.text.includes(id) && dash.text.includes("Open reports (1)"));
  const view = await s.get(`/admin/r/${id}`, h);
  assert.ok(view.text.includes("author@example.com") && view.text.includes("does not match the book"));

  const post = (act, note = "") => s.post(`/admin/r/${id}`, { act, note }, h);
  const noNote = await post("dispute");
  assert.equal(noNote.status, 200);
  assert.match(text(noNote.text), /neutral note/);
  assert.equal((await post("dispute", "A reader questioned the translation claim.")).status, 303);
  assert.match((await s.get("/r/" + id)).text, /Disputed\.[^<]*<\/strong> A concern about this record is under review\. A reader questioned/);
  assert.equal((await post("resolve")).status, 303);
  assert.ok(!(await s.get("/r/" + id)).text.includes("Disputed."));
  assert.equal((await post("withdraw", "At the author's request")).status, 303);
  assert.equal(JSON.parse(s.env.DB.q("SELECT doc FROM records")[0].doc).history.at(-1).by, "maintainer");
  assert.equal((await post("reinstate")).status, 303);
  assert.equal(s.env.DB.q("SELECT status FROM records")[0].status, "active");
  const events = JSON.parse(s.env.DB.q("SELECT doc FROM records")[0].doc).history.map((e) => e.event);
  assert.deepEqual(events, ["registered", "disputed", "dispute resolved", "withdrawn", "corrected"]);

  const closed = await s.post("/admin/report/1/close", { note: "Checked; no change needed." }, h);
  assert.equal(closed.status, 303);
  assert.equal(s.env.DB.q("SELECT status FROM reports")[0].status, "closed");
  assert.equal((await s.post(`/admin/r/${id}`, { act: "bogus" }, h)).status, 200); // shows an error, changes nothing
});

test("removing a record redacts it everywhere and deletes the stored email", async () => {
  const s = setup();
  const { id, token: manage } = await s.register({ title: "Secretly Removed Title", author: "Removed Person", statement: "REMOVED-STATEMENT-MARKER with enough words." });
  const h = await admin(s);
  assert.equal((await s.post(`/admin/r/${id}`, { act: "remove", note: "REMOVED-NOTE-MARKER" }, h)).status, 303);
  const r = await s.get("/r/" + id);
  assert.equal(r.status, 410);
  assert.match(r.text, /Record removed/);
  assert.match(r.res.headers.get("x-robots-tag"), /noindex/);
  for (const m of ["Secretly Removed", "Removed Person", "REMOVED-STATEMENT", "REMOVED-NOTE", "9780306406157"]) assert.ok(!r.text.includes(m), m);
  const row = s.env.DB.q("SELECT * FROM records")[0];
  assert.equal(row.status, "removed");
  assert.equal(row.email, null);
  assert.equal(row.isbn, null);
  assert.equal(row.search_key, "");
  for (const m of ["Secretly Removed", "Removed Person", "REMOVED-STATEMENT"]) assert.ok(!row.doc.includes(m), m);
  assert.ok(!(await s.get("/lookup?q=secretly+removed")).text.includes(id));
  assert.ok(!(await s.get("/lookup?q=9780306406157")).text.includes(id));
  // the registrant's link, the confirmation link and the stored address hash are retired too
  assert.equal(row.manage_hash, "removed:" + id);
  assert.equal(row.src_hash, "removed:" + id);
  assert.equal(row.email_hash, "");
  assert.equal((await s.post(`/manage/${manage}/withdraw`, { confirm: "yes" })).status, 404);
  assert.equal((await s.post(`/manage/${manage}/edit`, { title: "x" })).status, 404);
  // the ISBN is free again, and the removed record's ID is not reused
  assert.equal((await s.post(`/admin/r/${id}`, { act: "reinstate" }, h)).status, 200);
});

test("stored records conform to the published schema", async () => {
  const s = setup();
  const a = await s.register();
  await s.register({ isbn: "", title: "Second", role: "publisher", label: "human-authored", cover: "none", ai_tools: "", formats: ["print", "audiobook"] });
  await s.post(`/manage/${a.token}/withdraw`, { confirm: "yes" });
  const h = await admin(s);
  const c = await s.register({ isbn: "", title: "Third" });
  await s.post(`/admin/r/${c.id}`, { act: "dispute", note: "Under review." }, h);
  const d = await s.register({ isbn: "", title: "Fourth" });
  await s.post(`/admin/r/${d.id}`, { act: "remove", note: "n" }, h);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat("date", /^\d{4}-\d{2}-\d{2}$/);
  const validate = ajv.compile(JSON.parse(readFileSync(path.join(repoRoot, "schema/record.schema.json"), "utf8")));
  const rows = s.env.DB.q("SELECT * FROM records");
  assert.equal(rows.length, 4);
  for (const row of rows) {
    const rec = recordFromRow(row);
    assert.ok(validate(rec), `${rec.id} ${rec.status}: ${JSON.stringify(validate.errors)}`);
    assert.ok(!JSON.stringify(rec).includes("@example.com"), "no email in the public document");
  }
});
