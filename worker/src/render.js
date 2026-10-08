// HTML rendering. Every piece of submitted text goes through esc(); markup here is written by us.
// Pages are wrapped in the site shell that the Python build writes to dist/_app/shell.html.
import { esc, HONEYPOT } from "./util.js";

const apps = new WeakMap();

export async function getApp(env) {
  let app = apps.get(env.ASSETS);
  if (app) return app;
  const get = async (p) => {
    const res = await env.ASSETS.fetch(new Request("https://assets.invalid" + p));
    if (!res.ok) throw new Error(`missing asset ${p} (${res.status}); run: python -m ati.build --out dist`);
    return res;
  };
  const [shell, data] = await Promise.all([get("/_app/shell.html").then((r) => r.text()), get("/_app/data.json").then((r) => r.json())]);
  app = { shell, data };
  apps.set(env.ASSETS, app);
  return app;
}

const CSP_BASE = "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export const csp = (turnstile) => turnstile
  ? `${CSP_BASE}; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com`
  : `${CSP_BASE}; script-src 'self'; connect-src 'self'`;

export function secureHeaders({ turnstile = false, noindex = false, type = "text/html; charset=utf-8" } = {}) {
  const h = new Headers({
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    // "same-origin": never sent to other sites (so a private link cannot leak), but unlike "no-referrer" browsers still
    // send a real Origin header on form posts, which the same-site check relies on.
    "referrer-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "strict-transport-security": "max-age=31536000",
    "content-security-policy": csp(turnstile),
  });
  if (noindex) h.set("x-robots-tag", "noindex, nofollow");
  return h;
}

/** Wraps `content` (trusted HTML) in the site shell. A single pass, so substituted text is never re-scanned. */
export async function page(env, { title, desc = "", content, status = 200, turnstile = false, noindex = false, headers = {} }) {
  const { shell } = await getApp(env);
  const map = { TITLE: esc(title), DESC: esc(desc), CONTENT: content };
  const html = shell.replace(/@@(TITLE|DESC|CONTENT)@@/g, (_, k) => map[k]);
  const h = secureHeaders({ turnstile, noindex });
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return new Response(html, { status, headers: h });
}

export function lockup(app, label, id, n = 1, small = false) {
  const html = app.data.lockups[label][small ? "small" : "full"];
  return html.replace(/@@(U|ID)@@/g, (_, k) => (k === "U" ? String(n) : esc(id)));
}

export const notFound = (env) =>
  message(env, { title: "Page not found", status: 404, body: '<p>That page does not exist. Try <a href="/registry/">finding a record</a> or the <a href="/">home page</a>.</p>' });

export const message = (env, { title, body, status = 200, kind = "", noindex = true }) =>
  page(env, {
    title, status, noindex,
    content: `<article class="prose"><h1>${esc(title)}</h1>${kind ? `<div class="notice ${kind}">${body}</div>` : body}</article>`,
  });

// ---- record pages -----------------------------------------------------------------------------------------------
const lastEvent = (rec, event) => ([...rec.history].reverse().find((h) => h.event === event) || {}).date || rec.updated;

function jsonld(rec, data) {
  const w = rec.work;
  const obj = {
    "@context": "https://schema.org", "@type": "Book", name: w.title, author: { "@type": "Person", name: w.author },
    datePublished: String(w.year), identifier: rec.id, url: `${data.base_url}/r/${rec.id}`,
    description: `ATI Registry self-declared label: ${data.labels[rec.label].name} (status: ${rec.status}). Not verified.`,
  };
  if (w.isbn) obj.isbn = w.isbn;
  return JSON.stringify(obj).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export function recordPage(app, rec) {
  const d = app.data, w = rec.work, L = d.labels[rec.label];
  const defs = d.definitions[rec.definitions_version];
  const definition = defs ? esc(defs[rec.label].definition)
    : `<span class="muted">The wording of definitions v${esc(rec.definitions_version)} is in the registry&rsquo;s version history.</span>`;
  const title = esc(w.title) + (w.subtitle ? `<span class="muted">: ${esc(w.subtitle)}</span>` : "");
  const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  const formats = (w.formats || []).map((f) => esc(d.formats[f])).join(", ");
  const comps = rec.components.map((c) => `<tr><td>${esc(d.parts[c.part])}</td><td>${esc(d.ai_use_short[c.ai_use])}</td></tr>`).join("");
  const notice = rec.status === "withdrawn"
    ? `<div class="notice warn"><strong>Withdrawn.</strong> This declaration was withdrawn on ${esc(lastEvent(rec, "withdrawn"))}. It is kept for the record and the ID will not be reused.</div>`
    : rec.status === "disputed"
      ? `<div class="notice warn"><strong>Disputed.</strong> A concern about this record is under review.${rec.dispute_note ? " " + esc(rec.dispute_note) : ""} See <a href="/disputes/">how disputes work</a>.</div>` : "";
  return `<article class="prose" style="max-width:52rem">
  <p class="eyebrow">Registered declaration</p>
  <h1>${title}</h1>
  <div class="record-head">
    ${lockup(app, rec.label, rec.id, 1)}
    <div><span class="record-id">${esc(rec.id)}</span><br><span class="pill ${esc(rec.status)}">${esc(rec.status)}</span></div>
  </div>
  ${notice}
  <h2>The work</h2>
  <div class="table-wrap"><table class="kv"><tbody>
    ${row("Title", esc(w.title) + (w.subtitle ? ": " + esc(w.subtitle) : ""))}
    ${row("Author", esc(w.author))}
    ${row("Year", esc(w.year) + (w.edition ? " &middot; " + esc(w.edition) : ""))}
    ${w.isbn ? row("ISBN", `<span class="mono">${esc(w.isbn)}</span>`) : ""}
    ${formats ? row("Formats covered", formats) : ""}
    ${w.url ? row("Book page", `<a href="${esc(w.url)}" rel="nofollow noopener noreferrer ugc">${esc(w.url)}</a>`) : ""}
  </tbody></table></div>
  <h2>The declaration</h2>
  <p><strong>Text: ${esc(L.name)}.</strong> ${definition}</p>
  <blockquote class="ati-${esc(rec.label)}" style="margin:1rem 0;padding:.2rem 1.1rem;border-left:4px solid var(--c)"><p>${esc(rec.statement)}</p><p class="muted" style="margin:0 0 .6rem">The registrant&rsquo;s own words.</p></blockquote>
  ${rec.components.length ? `<h3>Other components</h3><div class="table-wrap"><table><thead><tr><th>Component</th><th>AI use</th></tr></thead><tbody>${comps}</tbody></table></div>` : ""}
  <h3>AI tools declared</h3>
  ${rec.ai_tools.length ? `<ul>${rec.ai_tools.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : `<p class="muted">None.</p>`}
  <div class="notice"><strong>Self-declared, not verified.</strong> The registrant confirmed that the information is accurate, that they have the right to make this declaration, and that they checked that the terms of the AI tools listed permit use of the outputs in this publication. The registry has not verified these statements and makes no statement about copyright or ownership. Declared under definitions v${esc(rec.definitions_version)}.</div>
  <h2>Registration details</h2>
  <div class="table-wrap"><table class="kv"><tbody>
    ${row("Declared by", `${esc(d.role_short[rec.declared_by.role] || "")}, who confirmed an email address (not shown).<br><span class="muted">The registry does not confirm this role, or that the named author agrees with the declaration.</span>`)}
    ${row("Registered", esc(rec.registered))}
    ${row("Last updated", esc(rec.updated))}
  </tbody></table></div>
  <h3>History</h3>
  <div class="table-wrap"><table><thead><tr><th>Date</th><th>Event</th><th>By</th><th>Note</th></tr></thead><tbody>
    ${rec.history.map((h) => `<tr><td>${esc(h.date)}</td><td>${esc(h.event)}</td><td>${esc(h.by || "")}</td><td>${esc(h.note || "")}</td></tr>`).join("")}
  </tbody></table></div>
  <p class="actions"><a class="btn secondary" href="/report/${esc(rec.id)}">Report a problem</a></p>
  <p class="muted">Permanent link: <span class="mono">${esc(d.base_url)}/r/${esc(rec.id)}</span><br>Are you the registrant? Use your private link to correct or withdraw this record, or <a href="/manage/lost">request a new link</a>.</p>
  <script type="application/ld+json">${jsonld(rec, d)}</script>
</article>`;
}

export function removedPage(rec) {
  const on = lastEvent(rec, "removed");
  return `<article class="prose" style="max-width:52rem">
  <p class="eyebrow">Registered declaration</p>
  <h1>Record removed</h1>
  <p><span class="record-id">${esc(rec.id)}</span> <span class="pill removed">removed</span></p>
  <div class="notice warn"><strong>Removed.</strong> This record was removed by the registry on ${esc(on)}, for example because it was inaccurate, an impersonation, abusive, or the subject of a legal request. Its content is no longer shown here or in search. The ID is kept so it is never reused.</div>
  <p class="muted">Registered ${esc(rec.registered)}. <a href="/disputes/">How removals and disputes work</a>.</p>
</article>`;
}

export function resultsList(app, rows, recordFromRow) {
  return `<ul class="list-plain recent">${rows.map((row, i) => {
    const r = recordFromRow(row);
    return `<li>${lockup(app, r.label, r.id, i + 1, true)}
      <span><a href="/r/${esc(r.id)}"><strong>${esc(r.work.title)}</strong></a>${r.status !== "active" ? ` <span class="pill ${esc(r.status)}">${esc(r.status)}</span>` : ""}<br>
      <span class="muted">${esc(r.work.author)} &middot; ${esc(r.work.year)} &middot; <span class="mono">${esc(r.id)}</span></span></span></li>`;
  }).join("")}</ul>`;
}

export function lookupForm(q = "") {
  return `<form class="search" role="search" action="/lookup" method="get">
  <label for="q">Search</label>
  <input id="q" name="q" type="search" placeholder="ATI ID, ISBN, or title and author" maxlength="100" required autocomplete="off" value="${esc(q)}">
  <button class="btn" type="submit">Look up</button>
</form>`;
}

// ---- the declaration form (register and correct) --------------------------------------------------------------
export function valuesFromDoc(doc, data) {
  const w = doc.work, v = {
    title: w.title, subtitle: w.subtitle || "", author: w.author, role: (doc.declared_by && doc.declared_by.role) || doc.role || "", isbn: w.isbn || "", year: String(w.year),
    edition: w.edition || "", formats: w.formats || [], url: w.url || "", label: doc.label, statement: doc.statement,
    ai_tools: doc.ai_tools.join("\n"), attest: [],
  };
  for (const part of Object.keys(data.parts)) v[part] = (doc.components.find((c) => c.part === part) || { ai_use: "na" }).ai_use;
  return v;
}

export function declarationForm({ data, values = {}, errors = [], action, mode, sitekey = "" }) {
  const v = (k) => String(values[k] ?? "");
  const has = (k, x) => Array.isArray(values[k]) && values[k].includes(x);
  const field = (id, label, control, hint) =>
    `<div class="field"><label for="${id}">${label}</label>${control}${hint ? `<p class="hint">${hint}</p>` : ""}</div>`;
  const input = (id, type, max, extra = "") => `<input type="${type}" id="${id}" name="${id}" value="${esc(v(id))}" maxlength="${max}" ${extra}>`;
  const select = (id, options, extra = "") =>
    `<select id="${id}" name="${id}" ${extra}><option value="">Choose&hellip;</option>${Object.entries(options).map(([k, t]) =>
      `<option value="${esc(k)}"${v(id) === k ? " selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
  const errBlock = errors.length
    ? `<div class="notice warn" role="alert"><strong>Please fix the following and submit again:</strong><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : "";
  const labels = Object.entries(data.labels).map(([k, L]) =>
    `<label class="choice"><input type="radio" name="label" value="${esc(k)}"${v("label") === k ? " checked" : ""} required><span><strong>${esc(L.name)} (${esc(L.abbr)})</strong><br><span class="muted">${esc(L.short)}</span></span></label>`).join("");
  const parts = Object.entries(data.parts).map(([k, t]) => field(k, esc(t), select(k, data.ai_use, "required"))).join("");
  const formats = Object.entries(data.formats).map(([k, t]) =>
    `<label class="choice"><input type="checkbox" name="formats" value="${esc(k)}"${has("formats", k) ? " checked" : ""}><span>${esc(t)}</span></label>`).join("");
  const attest = Object.entries(data.attestations).map(([k, t]) =>
    `<label class="choice"><input type="checkbox" name="attest" value="${esc(k)}"${has("attest", k) ? " checked" : ""} required><span>${esc(t).replace("Terms and Privacy Policy", '<a href="/terms/">Terms</a> and <a href="/privacy/">Privacy Policy</a>')}</span></label>`).join("");
  const register = mode === "register";
  return `${errBlock}
<form method="post" action="${esc(action)}" class="reg-form">
  <fieldset><legend>The work</legend>
    ${field("title", "Title of the work", input("title", "text", 200, "required"))}
    ${field("subtitle", "Subtitle (optional)", input("subtitle", "text", 200))}
    ${field("author", "Author name as it appears on the book", input("author", "text", 150, "required"))}
    ${field("role", "Your role in relation to this work", select("role", data.roles, "required"), "The registry does not verify this. Only the author, publisher or someone they have authorized may declare.")}
    ${field("isbn", "ISBN (optional)", input("isbn", "text", 30, 'placeholder="978-1-234-56789-7" inputmode="text" autocomplete="off"'))}
    ${field("year", "Year this edition was published", input("year", "text", 4, 'required inputmode="numeric" pattern="[0-9]{4}" placeholder="2026"'))}
    ${field("edition", "Edition (optional)", input("edition", "text", 80, 'placeholder="First Edition"'))}
    <div class="field"><span class="label">Formats this declaration covers</span>${formats}</div>
    ${field("url", "Link to the book&rsquo;s page (optional)", input("url", "url", 300, 'placeholder="https://"'))}
  </fieldset>
  <fieldset><legend>The declaration</legend>
    <div class="field"><span class="label">Label for the text of the work</span><p class="hint">Who originated the content, and who wrote the sentences? See the <a href="/labels/">definitions</a>.</p>${labels}</div>
    ${field("statement", "In your own words, how was AI used (or not used) in this work?",
      `<textarea id="statement" name="statement" rows="6" maxlength="1500" required>${esc(v("statement"))}</textarea>`, "20 to 1,500 characters. Be specific; readers will see this verbatim.")}
    ${field("ai_tools", "AI tools used (one per line)",
      `<textarea id="ai_tools" name="ai_tools" rows="4" maxlength="2400" placeholder="Claude, Anthropic (paid plan): editing and continuity checks">${esc(v("ai_tools"))}</textarea>`,
      "For each tool: name, provider, plan or tier (free or paid), and what it was used for. Required if any AI was used for anything in the work.")}
    ${parts}
  </fieldset>
  <fieldset><legend>Confirmations</legend>${attest}</fieldset>
  ${register ? `<fieldset><legend>Your email address</legend>
    ${field("email", "Email address", input("email", "email", 254, 'required autocomplete="email"'), "Private. It is never published. We send one message to confirm it is you, and later use it only to let you manage this record or to contact you about it.")}
  </fieldset>` : ""}
  <div class="hp" aria-hidden="true"><label>Leave this field empty<input type="text" name="${HONEYPOT}" tabindex="-1" autocomplete="off"></label></div>
  ${register ? `<div class="field"><div class="cf-turnstile" data-sitekey="${esc(sitekey)}" data-action="register"></div>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></div>` : ""}
  <button class="btn" type="submit">${register ? "Submit declaration" : "Save corrections"}</button>
</form>`;
}

// ---- management ---------------------------------------------------------------------------------------------------
export function managePage(rec, token, flash = "") {
  const t = esc(token), live = rec.status === "active" || rec.status === "disputed";
  return `<article class="prose" style="max-width:52rem">
  <p class="eyebrow">Your private link</p>
  <h1>Manage ${esc(rec.id)}</h1>
  ${flash}
  <p><strong>${esc(rec.work.title)}</strong> by ${esc(rec.work.author)} <span class="pill ${esc(rec.status)}">${esc(rec.status)}</span></p>
  <p><a href="/r/${esc(rec.id)}">View the public record</a>. Anyone who has this page&rsquo;s address can change the record, so keep it private.</p>
  ${live ? `<h2>Correct the declaration</h2>
  <p>Changes are public and are added to the record&rsquo;s history.</p>
  <p><a class="btn" href="/manage/${t}/edit">Edit the declaration</a></p>
  <h2>Withdraw the record</h2>
  <p>A withdrawn record stays visible with the status &ldquo;withdrawn&rdquo;. Its ID is never reused and it cannot be reactivated; you can register the work again.</p>
  ${rec.status === "disputed" ? `<div class="notice warn">This record is under dispute, so it can only be withdrawn after a maintainer reviews the request. Please write to us.</div>` : `<form method="post" action="/manage/${t}/withdraw">
    <label class="choice"><input type="checkbox" name="confirm" value="yes" required><span>I want to withdraw ${esc(rec.id)}.</span></label>
    <div class="hp" aria-hidden="true"><label>Leave this field empty<input type="text" name="${HONEYPOT}" tabindex="-1" autocomplete="off"></label></div>
    <button class="btn secondary" type="submit">Withdraw this record</button>
  </form>`}` : `<div class="notice warn">This record is ${esc(rec.status)} and can no longer be changed here.</div>`}
</article>`;
}
