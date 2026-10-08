import { test } from "node:test";
import assert from "node:assert/strict";
import { site } from "./helpers.js";
import { visitorKind } from "../src/visit.js";

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
  assert.match(m.text, /When:\s+Oct 8, 2026, 8:00 AM \(America\/New_York\)\s+=\s+2026-10-08 12:00 UTC/);
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
  for (const over of [{}, { VISIT_ALERTS: "off" }, { VISIT_ALERTS: "all", ADMIN_EMAIL: "" }]) {
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
