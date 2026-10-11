import test from "node:test";
import assert from "node:assert/strict";
import { site, T0 } from "./helpers.js";
import { resetKeyCache } from "../src/admin.js";
import { runDaily } from "../src/index.js";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1" };
async function adminHeaders() {
  const head = b64u(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const claims = b64u(JSON.stringify({ iss: "https://team.cloudflareaccess.com", aud: ["aud-tag"], email: "admin@example.org", exp: Math.floor(T0 / 1000) + 600 }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(`${head}.${claims}`));
  return { headers: { "cf-access-jwt-assertion": `${head}.${claims}.${b64u(sig)}` } };
}
const setup = (over = {}) => { resetKeyCache(); const s = site(over); s.jwks = [jwk]; return s; };

const GOOD = {
  role: "author", topic: "labels", name: "Pat Reader", email: "",
  body: "The Human Authored definition is clear, but the short wording on the form should match it exactly.",
  publish: "yes", "cf-turnstile-response": "ok",
};
const rows = (s) => s.env.DB.q("SELECT * FROM feedback ORDER BY n");
const words = (n) => Array.from({ length: n }, () => "word").join(" ");

test("the feedback page has a form with its own bot-check action and the trap field, and the menu links to it", async () => {
  const s = setup();
  const r = await s.get("/feedback");
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('data-action="feedback"') && r.text.includes('name="ati_trap"'));
  assert.match(r.text, /Nothing has been published yet/);
  assert.equal((await s.get("/feedback/")).status, 200);
  assert.match((await s.get("/")).text, /<a href="\/feedback\/"[^>]*>Your Feedback<\/a>/);
});

test("a comment is stored as pending, is not public, and the maintainer is told without the text being emailed", async () => {
  const s = setup();
  const r = await s.post("/feedback", { ...GOOD, email: "Reader@Example.com" });
  assert.equal(r.status, 200);
  assert.match(r.text, /Thank you/);
  const [row] = rows(s);
  assert.deepEqual([row.status, row.role, row.topic, row.name, row.email], ["pending", "author", "labels", "Pat Reader", "reader@example.com"]);
  assert.ok(!(await s.get("/feedback")).text.includes("Human Authored definition is clear"));
  assert.equal(s.mails.length, 1);
  assert.match(s.mails[0].subject, /New feedback awaiting review \(#1\)/);
  assert.match(s.mails[0].text, /\/admin\/f\/1/);
  assert.ok(!s.mails[0].text.includes("Human Authored definition"));
});

test("bad input is explained and nothing is stored", async () => {
  const s = setup();
  const bad = async (over, frag) => {
    const r = await s.post("/feedback", { ...GOOD, ...over });
    assert.equal(r.status, 400, frag);
    assert.ok(r.text.includes(frag), frag + "\n" + r.text.replace(/<[^>]+>/g, " ").slice(0, 400));
    assert.ok(r.text.includes("Pat Reader") || over.name !== undefined, "the form keeps what was typed");
  };
  await bad({ body: "too short" }, "at least 20 characters");
  await bad({ body: words(201) }, "200 words or fewer");
  await bad({ body: "x".repeat(2001) }, "200 words or fewer");
  await bad({ body: "See https://spam.example/buy for details of the thing" }, "web addresses and email addresses");
  await bad({ body: "Please write to me at someone@example.org about this" }, "web addresses and email addresses");
  await bad({ name: "Visit buy-now.com" }, "web addresses and email addresses");
  await bad({ name: "x".repeat(61) }, "longer than 60");
  await bad({ role: "wizard" }, "Choose which describes you best");
  await bad({ topic: "" }, "what your feedback is about");
  await bad({ email: "not-an-email" }, "email address is not valid");
  await bad({ publish: undefined }, "confirm that your comment may be published");
  assert.equal(rows(s).length, 0);
  assert.equal((await s.post("/feedback", { ...GOOD, body: words(200) })).status, 200, "exactly 200 words is fine");
});

test("the bot check, the trap field and the limits protect the queue", async () => {
  const s = setup({ MAX_FEEDBACK_PER_IP_DAY: "2", MAX_FEEDBACK_TOTAL_DAY: "3" });
  s.turnstileOk = false;
  assert.equal((await s.post("/feedback", GOOD)).status, 400);
  s.turnstileOk = true;
  s.turnstileAction = "register"; // a token issued for another form
  assert.equal((await s.post("/feedback", GOOD)).status, 400);
  s.turnstileAction = undefined;
  assert.equal(rows(s).length, 0);

  const trap = await s.post("/feedback", { ...GOOD, ati_trap: "http://spam" });
  assert.equal(trap.status, 200);
  assert.equal(rows(s).length, 0, "a filled trap looks like success but stores nothing");

  // Two failed bot checks above each used one of this visitor's two tries today.
  assert.equal((await s.post("/feedback", GOOD)).status, 429);
  s.now += 24 * 3600 * 1000;
  assert.equal((await s.post("/feedback", GOOD)).status, 200);
  assert.equal((await s.post("/feedback", GOOD)).status, 200);
  assert.equal((await s.post("/feedback", GOOD, { ip: "198.51.100.9" })).status, 200);
  const full = await s.post("/feedback", GOOD, { ip: "198.51.100.10" });
  assert.equal(full.status, 429);
  assert.match(full.text, /lot of comments today/);
  assert.equal(rows(s).length, 3);
});

test("the admin queue is invisible without Access; publishing shows the comment with a reply, escaped", async () => {
  const s = setup();
  await s.post("/feedback", { ...GOOD, name: "<b>Pat</b>", body: "The form is clear but the <script>alert(1)</script> label needs examples.\nSecond line.", email: "pat@example.org" });
  assert.equal((await s.get("/admin/f/1")).status, 404);
  assert.equal((await s.post("/admin/f/1", { act: "publish" })).status, 404);
  const h = await adminHeaders();

  const dash = await s.get("/admin", h);
  assert.ok(dash.text.includes("Feedback awaiting review (1)") && dash.text.includes("/admin/f/1"));
  const detail = await s.get("/admin/f/1", h);
  assert.ok(detail.text.includes("pat@example.org"), "the private email is shown to the maintainer");
  assert.ok(!detail.text.includes("<script>alert(1)"));

  const pub = await s.post("/admin/f/1", { act: "publish", reply: "Thanks, we have added examples to the labels page." }, h);
  assert.equal(pub.status, 303);
  const page = (await s.get("/feedback")).text;
  assert.ok(page.includes("Second line.") && page.includes("Reply from the registry:") && page.includes("added examples"));
  assert.ok(page.includes("&lt;b&gt;Pat&lt;/b&gt;") && !page.includes("<script>alert(1)") && !page.includes("<b>Pat</b>"));
  assert.ok(page.includes("Author") && page.includes("The labels and definitions"));
  assert.ok(!page.includes("pat@example.org"), "the email is never public");
  assert.ok((await s.get("/admin", h)).text.includes("Published feedback (1)"));

  assert.equal((await s.post("/admin/f/1", { act: "reply", reply: "Updated reply." }, h)).status, 303);
  assert.ok((await s.get("/feedback")).text.includes("Updated reply."));
  assert.equal((await s.post("/admin/f/1", { act: "unpublish" }, h)).status, 303);
  assert.ok(!(await s.get("/feedback")).text.includes("Second line."));
  assert.equal(rows(s)[0].status, "pending");
});

test("an anonymous comment says so; delete removes the row; admin actions need a same-site post", async () => {
  const s = setup();
  await s.post("/feedback", { ...GOOD, name: "" });
  const h = await adminHeaders();
  assert.equal((await s.post("/admin/f/1", { act: "publish" }, { ...h, origin: "https://evil.example" })).status, 403);
  await s.post("/admin/f/1", { act: "publish" }, h);
  assert.match((await s.get("/feedback")).text, /Anonymous/);
  const odd = await s.post("/admin/f/1", { act: "reply2" }, h);
  assert.equal(odd.status, 200);
  assert.match(odd.text, /does not apply/);
  assert.equal((await s.post("/admin/f/1", { act: "delete" }, h)).status, 303);
  assert.equal(rows(s).length, 0);
  assert.equal((await s.get("/admin/f/1", h)).status, 404);
});

test("the daily clean-up deletes comments nobody reviewed in 90 days, but keeps published ones", async () => {
  const s = setup({ VISIT_ALERTS: "off" });
  const old = Math.floor(T0 / 1000) - 91 * 86400;
  s.env.DB.sqlite.exec(`INSERT INTO feedback (created_at, role, topic, body, status) VALUES
    (${old}, 'reader', 'site', 'old and never reviewed', 'pending'),
    (${old}, 'reader', 'site', 'old but published', 'published'),
    (${Math.floor(T0 / 1000)}, 'reader', 'site', 'new and waiting', 'pending')`);
  await runDaily(s.env, s.deps());
  assert.deepEqual(rows(s).map((r) => r.body), ["old but published", "new and waiting"]);
});
