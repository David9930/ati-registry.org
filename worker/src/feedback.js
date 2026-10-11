// Public feedback ("Your Feedback"): validation and HTML. The request handlers live in index.js (they need its bot check and
// limits) and admin.js (the maintainer's queue); everything here is a pure function. Submitted text is escaped on the way out.
import { esc, HONEYPOT } from "./util.js";
import { clean, normalizeEmail } from "./validate.js";

export const FB_ROLES = { author: "Author", publisher: "Publisher or editor", reader: "Reader", library: "Librarian or bookseller", other: "Other" };
export const FB_TOPICS = {
  labels: "The labels and definitions", register: "Registering a book", governance: "Governance and trust",
  site: "The website", other: "Something else",
};
export const FB_MAX_WORDS = 200;

// Web and email addresses are refused (spam and tracking links); a comment is plain text.
const LINKISH = /(https?:|www\.|\S@\S|\b[a-z0-9-]{2,}\.(?:com|net|org|io|co|info|biz|xyz|ru|cn|me|app|dev|shop|top|site|online|link|click)\b)/i;
const hasLetters = (s) => /[\p{L}\p{N}]/u.test(s);

/** Returns { errs, value }. `v` is the submitted form (strings). */
export function validateFeedback(v) {
  const errs = [];
  const role = String(v.role || ""), topic = String(v.topic || "");
  const name = clean(v.name), body = clean(v.body, true);
  const email = v.email ? normalizeEmail(v.email) : null;
  if (!Object.hasOwn(FB_ROLES, role)) errs.push("Choose which describes you best.");
  if (!Object.hasOwn(FB_TOPICS, topic)) errs.push("Choose what your feedback is about.");
  if (body.length < 20) errs.push("Your feedback must be at least 20 characters.");
  else if (body.split(/\s+/).length > FB_MAX_WORDS || body.length > 2000) errs.push(`Your feedback must be ${FB_MAX_WORDS} words or fewer.`);
  else if (!hasLetters(body)) errs.push("Your feedback must contain words.");
  if (name.length > 60) errs.push("The name is longer than 60 characters.");
  if (LINKISH.test(body) || LINKISH.test(name)) errs.push("Please leave out web addresses and email addresses; comments are plain text.");
  if (v.email && !email) errs.push("The email address is not valid (it is optional).");
  if (v.publish !== "yes") errs.push("Please confirm that your comment may be published.");
  return { errs, value: { role, topic, name: name || null, body, email } };
}

const day = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
const lines = (s) => esc(s).replace(/\n/g, "<br>");

function options(map, selected) {
  return `<option value="">Choose&hellip;</option>` + Object.entries(map).map(([k, t]) => `<option value="${esc(k)}"${selected === k ? " selected" : ""}>${esc(t)}</option>`).join("");
}

export function feedbackForm({ values = {}, sitekey }) {
  const v = values;
  return `<form method="post" action="/feedback" class="reg-form">
    <div class="field"><label for="fb-role">Which describes you best?</label><select id="fb-role" name="role" required>${options(FB_ROLES, v.role)}</select>
      <p class="hint">Shown beside your comment. It is not verified.</p></div>
    <div class="field"><label for="fb-topic">What is your feedback about?</label><select id="fb-topic" name="topic" required>${options(FB_TOPICS, v.topic)}</select></div>
    <div class="field"><label for="fb-body">Your feedback</label><textarea id="fb-body" name="body" rows="6" maxlength="2000" required>${esc(v.body || "")}</textarea>
      <p class="hint">Up to 200 words, in plain text, with no web or email addresses. To raise a problem with a particular record, use <a href="/report">a report</a> instead.</p></div>
    <div class="field"><label for="fb-name">Name to show (optional)</label><input type="text" id="fb-name" name="name" value="${esc(v.name || "")}" maxlength="60" autocomplete="name">
      <p class="hint">Shown with your comment. Leave it empty to appear as &ldquo;Anonymous&rdquo;.</p></div>
    <div class="field"><label for="fb-email">Your email address (optional)</label><input type="email" id="fb-email" name="email" value="${esc(v.email || "")}" maxlength="254" autocomplete="email">
      <p class="hint">Private. Only if you would like a reply. It is never published and is deleted with your comment.</p></div>
    <label class="choice"><input type="checkbox" name="publish" value="yes"${v.publish === "yes" ? " checked" : ""} required><span>I understand that my comment may be published on this page, with my role and the name above (or &ldquo;Anonymous&rdquo;).</span></label>
    <div class="hp" aria-hidden="true"><label>Leave this field empty<input type="text" name="${HONEYPOT}" tabindex="-1" autocomplete="off"></label></div>
    <div class="field"><div class="cf-turnstile" data-sitekey="${esc(sitekey)}" data-action="feedback"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></div>
    <button class="btn" type="submit">Send feedback</button></form>`;
}

export function publishedList(items) {
  if (!items.length) return `<p class="muted">Nothing has been published yet. Yours could be the first.</p>`;
  return items.map((r) => `<blockquote style="margin:1rem 0;padding:.2rem 1.1rem;border-left:4px solid #6b7a8c">
    <p>${lines(r.body)}</p>
    <p class="muted" style="margin:0 0 .6rem">${esc(r.name || "Anonymous")} &middot; ${esc(FB_ROLES[r.role] || r.role)} &middot; about: ${esc(FB_TOPICS[r.topic] || r.topic)} &middot; ${esc(day(r.published_at || r.created_at))}</p>
    ${r.reply ? `<p><strong>Reply from the registry:</strong> ${lines(r.reply)}</p>` : ""}</blockquote>`).join("");
}

export function feedbackPageHtml({ items, values = {}, errors = [], ready, sitekey }) {
  const err = errors.length ? `<div class="notice warn" role="alert"><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : "";
  const form = ready ? feedbackForm({ values, sitekey }) : `<div class="notice warn">Feedback is not open yet. Please check back soon.</div>`;
  return `<article class="prose"><p class="eyebrow">Help us improve</p><h1>Your feedback</h1>
    <p>The registry is a founder-led pilot, and the definitions, the form and the rules are still being shaped. Tell us what is unclear, wrong or missing, and what would make you use it. Every comment is read by the maintainer and published here after review, together with a reply where there is something to say.</p>
    ${err}${form}
    <h2 id="heard">What we have heard</h2>
    <p class="muted">These are individual views, published after review. Roles are self-declared and not verified, and the registry does not endorse any comment.</p>
    ${publishedList(items)}</article>`;
}

// ---- the maintainer's side --------------------------------------------------------------------------------------
const table = (head, rows) => `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
const brief = (s, n = 70) => (s.length > n ? s.slice(0, n) + "..." : s);
const row = (r) => `<tr><td><a href="/admin/f/${r.n}">#${r.n}</a></td><td>${esc(FB_ROLES[r.role] || r.role)}</td><td>${esc(FB_TOPICS[r.topic] || r.topic)}</td><td>${esc(brief(r.body))}</td><td>${esc(day(r.created_at))}</td></tr>`;

export function feedbackAdminSection(pending, published) {
  const head = ["#", "From", "About", "Comment", "Sent"];
  return `<h2>Feedback awaiting review (${pending.length})</h2>
  ${pending.length ? table(head, pending.map(row)) : '<p class="muted">None.</p>'}
  <h2>Published feedback (${published.length})</h2>
  ${published.length ? table(head, published.map(row)) : '<p class="muted">None.</p>'}`;
}

export function feedbackAdminView(r, flash = "") {
  const act = (name, label, cls = "secondary", extra = "") => `<form method="post" action="/admin/f/${r.n}" class="admin-act"><input type="hidden" name="act" value="${name}">${extra}<button class="btn ${cls}" type="submit">${label}</button></form>`;
  const replyBox = `<label>Public reply (optional, shown under the comment)<textarea name="reply" rows="3" maxlength="600">${esc(r.reply || "")}</textarea></label>`;
  const buttons = r.status === "pending"
    ? act("publish", "Publish", "", replyBox) + act("delete", "Delete (not published)")
    : act("reply", "Save reply", "", replyBox) + act("unpublish", "Unpublish (back to review)") + act("delete", "Delete");
  return `<p class="eyebrow">Maintainer</p><h1>Feedback #${r.n}</h1>${flash}
  <p><span class="pill ${r.status === "published" ? "active" : "disputed"}">${esc(r.status)}</span> &middot; sent ${esc(day(r.created_at))} &middot; <a href="/admin">dashboard</a></p>
  <div class="table-wrap"><table class="kv"><tbody>
    <tr><th>Name shown</th><td>${esc(r.name || "Anonymous")}</td></tr>
    <tr><th>Role (self-declared)</th><td>${esc(FB_ROLES[r.role] || r.role)}</td></tr>
    <tr><th>About</th><td>${esc(FB_TOPICS[r.topic] || r.topic)}</td></tr>
    <tr><th>Email (private)</th><td>${esc(r.email || "(none given)")}</td></tr></tbody></table></div>
  <h2>Comment</h2><blockquote>${lines(r.body)}</blockquote>
  <h2>Actions</h2>${buttons}`;
}
