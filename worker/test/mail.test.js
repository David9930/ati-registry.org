import test from "node:test";
import assert from "node:assert/strict";
import { sendMail } from "../src/mail.js";

const msg = { to: "a@example.com", subject: "Hi", text: "Body" };

test("Cloudflare Email Sending is called with the documented shape", async () => {
  const sent = [];
  await sendMail({ MAIL_PROVIDER: "cloudflare", MAIL_FROM: "registry@ati-registry.org", MAIL_FROM_NAME: "ATI Registry", EMAIL: { send: async (m) => sent.push(m) } }, msg);
  assert.deepEqual(sent, [{ to: "a@example.com", from: { email: "registry@ati-registry.org", name: "ATI Registry" }, subject: "Hi", text: "Body" }]);
  await assert.rejects(sendMail({ MAIL_PROVIDER: "cloudflare", MAIL_FROM: "x@y.org" }, msg), /EMAIL/);
});

test("Brevo is a drop-in replacement", async () => {
  let call;
  const fetch = async (url, init) => { call = { url, init }; return new Response("{}", { status: 201 }); };
  await sendMail({ MAIL_PROVIDER: "brevo", MAIL_FROM: "registry@ati-registry.org", BREVO_API_KEY: "k" }, msg, { fetch });
  assert.equal(call.url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(call.init.headers["api-key"], "k");
  const body = JSON.parse(call.init.body);
  assert.deepEqual(body.to, [{ email: "a@example.com" }]);
  assert.equal(body.subject, "Hi");
  assert.equal(body.sender.email, "registry@ati-registry.org");
  await assert.rejects(sendMail({ MAIL_PROVIDER: "brevo", MAIL_FROM: "a@b.org", BREVO_API_KEY: "k" }, msg, { fetch: async () => new Response("no", { status: 401 }) }), /401/);
  await assert.rejects(sendMail({ MAIL_PROVIDER: "brevo", MAIL_FROM: "a@b.org" }, msg), /BREVO_API_KEY/);
});

test("configuration mistakes fail loudly", async () => {
  await assert.rejects(sendMail({ MAIL_PROVIDER: "carrier-pigeon", MAIL_FROM: "a@b.org" }, msg), /unknown MAIL_PROVIDER/);
  await assert.rejects(sendMail({ MAIL_PROVIDER: "cloudflare" }, msg), /MAIL_FROM/);
});
