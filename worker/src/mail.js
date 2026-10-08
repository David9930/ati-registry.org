// Outgoing email. One small interface (`sendMail(env, {to, subject, text})`) with swappable providers, so the
// registry is not tied to a single email vendor.

export async function sendMail(env, msg, deps = {}) {
  const provider = String(env.MAIL_PROVIDER || "cloudflare").toLowerCase();
  const fromEmail = env.MAIL_FROM;
  if (!fromEmail) throw new Error("MAIL_FROM is not set");
  const fromName = env.MAIL_FROM_NAME || "ATI Registry";

  if (provider === "cloudflare") {
    if (!env.EMAIL) throw new Error("the EMAIL (send_email) binding is missing");
    await env.EMAIL.send({ to: msg.to, from: { email: fromEmail, name: fromName }, subject: msg.subject, text: msg.text });
    return;
  }
  if (provider === "brevo") {
    if (!env.BREVO_API_KEY) throw new Error("BREVO_API_KEY is not set");
    const f = deps.fetch || fetch;
    const res = await f("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { name: fromName, email: fromEmail }, to: [{ email: msg.to }], subject: msg.subject, textContent: msg.text }),
    });
    if (!res.ok) throw new Error(`Brevo returned ${res.status}`);
    return;
  }
  if (provider === "log") { // local development only: prints the message instead of sending it
    console.log(`[mail] to=${msg.to} subject=${msg.subject}\n${msg.text}`);
    return;
  }
  throw new Error(`unknown MAIL_PROVIDER "${provider}"`);
}

const sign = "\n\n—\nATI Registry\nhttps://ati-registry.org\nThis is a self-declaration registry; it does not verify or certify books.";

export const confirmEmail = (link, hours) => ({
  subject: "Confirm your ATI Registry declaration",
  text: `Someone (we hope you) submitted a declaration to the ATI Registry using this email address.\n\n` +
        `To confirm it and receive your record ID, open this link within ${hours} hours:\n\n${link}\n\n` +
        `If you did not do this, ignore this message: nothing is published unless the link is opened.${sign}`,
});

export const receiptEmail = (id, recordUrl, manageUrl) => ({
  subject: `Your ATI Registry record ${id}`,
  text: `Your declaration is registered as ${id}.\n\nPublic record: ${recordUrl}\n\n` +
        `Your private link for correcting or withdrawing this record (keep it private; anyone with it can change the record):\n\n${manageUrl}\n\n` +
        `If you lose it, you can request a new one at ${new URL(manageUrl).origin}/manage/lost.${sign}`,
});

export const lostEmail = (items) => ({
  subject: "Your ATI Registry management links",
  text: `You asked for new management links for the records registered with this email address. ` +
        `Each new link replaces the old one.\n\n${items.map((i) => `${i.id}\n${i.link}`).join("\n\n")}\n\n` +
        `If you did not ask for this, someone else entered your address on the request form. The old links no longer work and only the links above do; nobody else can see this message.${sign}`,
});

export const reportEmail = (n, id, reason, origin) => ({
  subject: `[ATI] Report #${n} on ${id}`,
  text: `A new report was filed on ${id} (${reason}).\n\nReview it: ${origin}/admin/r/${id}`,
});
