import { test } from "node:test";
import assert from "node:assert/strict";
import { site, T0 } from "./helpers.js";
import { visitorKind } from "../src/visit.js";
import { runDaily } from "../src/index.js";

const FL = { country: "US", region: "Florida" };
const alerts = (s) => s.mails.filter((m) => m.subject.startsWith("[ATI] Visit from"));

test("a page view emails the maintainer with time, region, page and visitor type", async () => {
  const s = site({ VISIT_ALERTS: "all" });
  const r = await s.get("/about/", { cf: FL, headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/130 Safari/537.36" } });
  assert.equal(r.status, 200);
  assert.equal(s.mails.length, 1);
  const m = s.mails[0];
  assert.equal(m.to, "admin@example.org");
  assert.match(m.subject, /^\[ATI\] Visit from Florida, United States · Browser/);
  assert.match(m.text, /When:\s+Oct 8, 8:00\sAM \(America\/New_York\)\s+=\s+2026-10-08 12:00 UTC/);
  assert.match(m.text, /From:\s+Florida, United States/);
  assert.match(m.text, /Page:\s+\/about\//);
  assert.doesNotMatch(m.text, /203\.0\.113\.7/); // no IP address
  assert.doesNotMatch(m.text, /Mozilla|Chrome/); // no raw user-agent text
});

test("known AI and search bots are labelled", async () => {
  const s = site({ VISIT_ALERTS: "all" });
  await s.get("/", { cf: { country: "US", region: "Iowa" }, headers: { "user-agent": "Mozilla/5.0 AppleWebKit/537.36; compatible; ChatGPT-User/1.0; +https://openai.com/bot" } });
  await s.get("/", { cf: { country: "US", region: "California" }, headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" } });
  assert.match(s.mails[0].subject, /Iowa, United States · OpenAI \/ ChatGPT \(bot\)/);
  assert.match(s.mails[1].subject, /California, United States · Google, search or Gemini \(bot\)/);
  assert.equal(visitorKind(""), "No user agent (a script)");
  assert.equal(visitorKind("curl/8.5.0"), "Other bot or script");
  assert.equal(visitorKind("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1"), "Browser (probably a person)");
});

test("a missing or odd location still sends, without crashing", async () => {
  const s = site({ VISIT_ALERTS: "all" });
  await s.get("/", { headers: { "user-agent": "Mozilla/5.0 Chrome/130" } });
  await s.get("/", { cf: { country: "T1" }, headers: { "user-agent": "Mozilla/5.0 Chrome/130" } });
  assert.match(s.mails[0].subject, /Visit from unknown country/);
  assert.match(s.mails[1].subject, /Visit from Tor network/);
});

test("nothing is sent unless VISIT_ALERTS is all and ADMIN_EMAIL is set", async () => {
  for (const over of [{}, { VISIT_ALERTS: "off" }, { VISIT_ALERTS: "all", ADMIN_EMAIL: "" }, { VISIT_ALERTS: "daily", ADMIN_EMAIL: "" }]) {
    const s = site(over);
    await s.get("/about/", { cf: FL });
    assert.equal(s.mails.length, 0, JSON.stringify(over));
  }
});

test("only successful public pages count: not 404s, redirects, private links, the admin page or POSTs", async () => {
  const s = site({ VISIT_ALERTS: "all" });
  await s.get("/no-such-page", { cf: FL });
  await s.get("/wp-login.php", { cf: FL });
  await s.get("/manage/" + "a".repeat(43), { cf: FL });
  await s.get("/verify?t=" + "b".repeat(43), { cf: FL });
  await s.get("/admin", { cf: FL });
  await s.post("/register", { title: "x" }, { cf: FL });
  assert.equal(alerts(s).length, 0);
  await s.get("/register", { cf: FL }); // a public form page does count
  assert.equal(alerts(s).length, 1);
});

test("the email never carries a query string or a private link", async () => {
  const s = site({ VISIT_ALERTS: "all" });
  await s.get("/lookup?q=secret+title&isbn=9780306406157", { cf: FL });
  assert.equal(alerts(s).length, 1);
  assert.match(alerts(s)[0].text, /Page:\s+\/lookup\n/);
  assert.doesNotMatch(alerts(s)[0].text, /secret|9780306406157/);
});

test("the daily cap stops the alerts, sends one notice, and resets the next day", async () => {
  const s = site({ VISIT_ALERTS: "all", MAX_VISIT_ALERTS_DAY: "3" });
  for (let i = 0; i < 6; i++) await s.get("/about/", { cf: FL });
  assert.equal(alerts(s).length, 3);
  assert.equal(s.mails.filter((m) => m.subject === "[ATI] Visit alerts paused for today").length, 1);
  assert.equal(s.mails.length, 4);
  s.now += 24 * 3600 * 1000;
  await s.get("/about/", { cf: FL });
  assert.equal(alerts(s).length, 4);
});

test("a failing mail provider does not affect the page", async () => {
  const s = site({ VISIT_ALERTS: "all" });
  s.mailFails = true;
  const r = await s.get("/about/", { cf: FL });
  assert.equal(r.status, 200);
  assert.match(r.text, /<html/i);
});

// ---- daily summary ---------------------------------------------------------------------------------------------
const UA_PERSON = "Mozilla/5.0 (X11; Linux x86_64) Chrome/130 Safari/537.36";
const UA_GPT = "Mozilla/5.0 AppleWebKit/537.36; compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const rows = (s) => s.env.DB.q("SELECT * FROM visits ORDER BY n");
const digests = (s) => s.mails.filter((m) => m.subject.startsWith("[ATI] Daily visits"));
const daily = (over = {}) => site({ VISIT_ALERTS: "daily", ...over });

test("daily mode logs page views without sending an email, and stores no IP or user-agent text", async () => {
  const s = daily();
  await s.get("/about/", { cf: { country: "US", region: "Florida" }, headers: { "user-agent": UA_PERSON } });
  await s.get("/", { cf: { country: "CA", region: "Ontario" }, headers: { "user-agent": UA_GPT } });
  assert.equal(s.mails.length, 0);
  const r = await rows(s);
  assert.equal(r.length, 2);
  assert.deepEqual({ ...r[0], n: 0 }, { n: 0, at: Math.floor(T0 / 1000), country: "United States", region: "Florida", path: "/about/", kind: "Browser (probably a person)", sent: 0 });
  assert.equal(r[1].kind, "OpenAI / ChatGPT (bot)");
  const everything = JSON.stringify(r);
  assert.doesNotMatch(everything, /203\.0\.113\.7|Mozilla|ChatGPT-User|Chrome/);
});

test("daily mode logs only successful public pages, only when enabled and addressed", async () => {
  const s = daily();
  await s.get("/no-such-page", { cf: FL });
  await s.get("/manage/" + "a".repeat(43), { cf: FL });
  await s.get("/verify?t=" + "b".repeat(43), { cf: FL });
  await s.get("/admin", { cf: FL });
  await s.post("/register", { title: "x" }, { cf: FL });
  await s.get("/lookup?q=secret", { cf: FL });
  assert.deepEqual((await rows(s)).map((r) => r.path), ["/lookup"]); // /lookup redirects or answers; the query never reaches the log
  for (const over of [{ VISIT_ALERTS: "off" }, { VISIT_ALERTS: "daily", ADMIN_EMAIL: "" }, {}]) {
    const o = site(over);
    await o.get("/about/", { cf: FL });
    assert.equal((await rows(o)).length, 0, JSON.stringify(over));
  }
});

test("the daily run sends one summary, marks it sent, and sends nothing the second time", async () => {
  const s = daily();
  await s.get("/about/", { cf: { country: "US", region: "Florida" }, headers: { "user-agent": UA_PERSON } });
  s.now += 60_000;
  await s.get("/labels/", { cf: { country: "CA", region: "Ontario" }, headers: { "user-agent": UA_PERSON } });
  for (const [c, rg] of [["US", "Iowa"], ["US", "Iowa"], ["IE", "Dublin"]]) await s.get("/", { cf: { country: c, region: rg }, headers: { "user-agent": UA_GPT } });
  for (const c of ["DE", "DE", "SG"]) await s.get("/", { cf: { country: c }, headers: { "user-agent": "curl/8.5.0" } });

  await runDaily(s.env, s.deps());
  assert.equal(digests(s).length, 1);
  assert.equal(s.mails.length, 1);
  const m = s.mails[0];
  assert.equal(m.to, "admin@example.org");
  assert.match(m.subject, /^\[ATI\] Daily visits: 8 \(2 likely people\)/);
  assert.match(m.text, /8 page views: 2 look like people, 6 are bots or scripts\. 5 countries\./);
  assert.match(m.text, /LIKELY PEOPLE \(2\)\n\s+Oct 8, 8:00\sAM\s+Florida, United States\s+\/about\//);
  assert.match(m.text, /Oct 8, 8:01\sAM\s+Ontario, Canada\s+\/labels\//);
  assert.match(m.text, /OpenAI \/ ChatGPT \(bot\): 3 visits.*Iowa, United States x2; Dublin, Ireland/);
  assert.match(m.text, /OTHER BOTS AND SCRIPTS \(3\)\n\s+Germany 2, Singapore 1/);
  assert.match(m.text, /ALL VISITS BY COUNTRY\n\s+United States 3/);
  assert.doesNotMatch(m.text, /203\.0\.113\.7|Mozilla|curl\/8/);
  assert.equal((await s.env.DB.q("SELECT COUNT(*) AS c FROM visits"))[0].c, 0); // sent rows were cleared by the same run

  await runDaily(s.env, s.deps());
  assert.equal(s.mails.length, 1);
});

test("a failed summary keeps the visits for the next run", async () => {
  const s = daily();
  await s.get("/about/", { cf: FL, headers: { "user-agent": UA_PERSON } });
  s.mailFails = true;
  await runDaily(s.env, s.deps());
  assert.equal(s.mails.length, 0);
  assert.equal((await rows(s)).length, 1);
  s.mailFails = false;
  s.now += 24 * 3600 * 1000;
  await s.get("/labels/", { cf: FL, headers: { "user-agent": UA_PERSON } });
  await runDaily(s.env, s.deps());
  assert.equal(digests(s).length, 1);
  assert.match(s.mails[0].subject, /Daily visits: 2 /);
});

test("the log is capped per day and the summary says so; the list of people is capped too", async () => {
  const s = daily({ MAX_VISIT_LOG_DAY: "4", VISIT_DIGEST_ROWS: "2" });
  for (let i = 0; i < 7; i++) await s.get("/about/", { cf: FL, headers: { "user-agent": UA_PERSON } });
  assert.equal((await rows(s)).length, 4);
  await runDaily(s.env, s.deps());
  assert.match(s.mails[0].text, /logging reached its daily limit of 4 on 2026-10-08/);
  assert.match(s.mails[0].text, /\.\.\. and 2 more/);
});

test("with no visits, or when the mode is not daily, no summary is sent; old rows are deleted", async () => {
  const s = daily();
  await runDaily(s.env, s.deps());
  assert.equal(s.mails.length, 0);
  await s.get("/about/", { cf: FL, headers: { "user-agent": UA_PERSON } });
  const off = site({ VISIT_ALERTS: "off" });
  off.env.DB.sqlite.exec(`INSERT INTO visits (at, path, kind) VALUES (${Math.floor(T0 / 1000)}, '/', 'x'), (${Math.floor(T0 / 1000) - 4 * 86400}, '/', 'x')`);
  await runDaily(off.env, off.deps());
  assert.equal(off.mails.length, 0);
  assert.equal((await rows(off)).length, 1); // the 4-day-old row is gone, the fresh unsent one stays
});
