// The maintainer's page: reports, holds and removals. It is reached only through a Cloudflare Access application
// that protects /admin*; on top of that, every request must carry a valid Access token (checked here against
// Cloudflare's published keys) for the one address in ADMIN_EMAIL. Anything else gets the ordinary "not found" page.
import { esc, ID_RE } from "./util.js";
import { page, message, notFound } from "./render.js";
import * as dbx from "./db.js";
import { searchKey, workKey } from "./validate.js";

const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const json = (s) => JSON.parse(new TextDecoder().decode(b64u(s)));

let jwks = { team: "", at: 0, keys: [] };

async function keysFor(team, kid, fetcher, nowMs) {
  const fresh = jwks.team === team && nowMs - jwks.at < 3600_000;
  const known = (k) => k.some((x) => x.kid === kid);
  if (fresh && known(jwks.keys)) return jwks.keys;
  if (fresh && nowMs - jwks.at < 60_000) return jwks.keys; // do not refetch more than once a minute for an unknown key id
  const res = await fetcher(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`certs ${res.status}`);
  jwks = { team, at: nowMs, keys: (await res.json()).keys || [] };
  return jwks.keys;
}

/** Returns the verified email address, or null. Fails closed when anything is missing or wrong. */
export async function verifyAccess(request, env, d) {
  const team = env.ACCESS_TEAM_DOMAIN, aud = env.ACCESS_AUD, admin = String(env.ADMIN_EMAIL || "").toLowerCase();
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!team || !aud || !admin || !token) return null;
  try {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return null;
    const head = json(h), claims = json(p), nowS = Math.floor(d.now() / 1000);
    if (head.alg !== "RS256" || typeof head.kid !== "string") return null;
    if (claims.iss !== `https://${team}`) return null;
    if (!(Array.isArray(claims.aud) ? claims.aud.includes(aud) : claims.aud === aud)) return null;
    if (typeof claims.exp !== "number" || claims.exp <= nowS) return null;
    if (typeof claims.nbf === "number" && claims.nbf > nowS + 60) return null;
    if (typeof claims.email !== "string" || claims.email.toLowerCase() !== admin) return null;
    const jwk = (await keysFor(team, head.kid, d.fetch, d.now())).find((k) => k.kid === head.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(s), new TextEncoder().encode(`${h}.${p}`));
    return ok ? claims.email : null;
  } catch {
    return null;
  }
}

export const resetKeyCache = () => { jwks = { team: "", at: 0, keys: [] }; };

// ---- actions on a record --------------------------------------------------------------------------------------
export const REMOVED_TEXT = "[Content removed by the registry.]";

/** The record as it stands after a removal: ID, status, label, dates and history stay; every descriptive field is blanked. */
export function scrub(doc, today) {
  const earlier = doc.history.map(({ note: _n, ...h }) => h);
  return {
    work: { title: "[removed]", author: "[removed]", year: doc.work.year }, label: doc.label, definitions_version: doc.definitions_version,
    statement: REMOVED_TEXT, components: [], ai_tools: [], attestation: doc.attestation, declared_by: doc.declared_by,
    history: [...earlier, { date: today, event: "removed", by: "maintainer" }],
  };
}

/**
 * Returns {status, doc} or {error}. `row` is the database row; doc its parsed declaration.
 * What goes into the public history is fixed wording. The maintainer's `note` is private (kept in admin_log), except for
 * a dispute, where the note is shown on the record by design.
 */
export function applyAction(row, doc, act, note, today) {
  const ev = (event, text) => ({ date: today, event, by: "maintainer", ...(text ? { note: text.slice(0, 300) } : {}) });
  const live = row.status === "active" || row.status === "disputed";
  const { dispute_note: _d, ...rest } = doc;
  switch (act) {
    case "dispute":
      if (row.status !== "active") return { error: "Only an active record can be marked disputed." };
      if (!note) return { error: "Add a short, neutral note; it is shown on the record." };
      return { status: "disputed", doc: { ...rest, dispute_note: note.slice(0, 300), history: [...doc.history, ev("disputed", note)] } };
    case "resolve":
      if (row.status !== "disputed") return { error: "The record is not disputed." };
      return { status: "active", doc: { ...rest, history: [...doc.history, ev("dispute resolved")] } };
    case "withdraw":
      if (!live) return { error: "Only an active or disputed record can be withdrawn." };
      return { status: "withdrawn", doc: { ...rest, history: [...doc.history, ev("withdrawn")] } };
    case "reinstate":
      if (row.status !== "withdrawn") return { error: "Only a withdrawn record can be reinstated." };
      return { status: "active", doc: { ...rest, history: [...doc.history, ev("corrected", "Reinstated by a maintainer.")] } };
    case "remove":
      if (row.status === "removed") return { error: "The record is already removed." };
      return { status: "removed", doc: scrub(doc, today) };
    default:
      return { error: "Unknown action." };
  }
}

// ---- pages -----------------------------------------------------------------------------------------------------
const when = (sec) => new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const admin = (env, title, content, status = 200) => page(env, { title, content: `<article class="prose" style="max-width:60rem">${content}</article>`, noindex: true, status });
const REASONS = { inaccurate: "The declaration is inaccurate", impersonation: "Impersonation or no right to declare", rights: "Rights or legal concern", abuse: "Abusive or unlawful content", other: "Something else" };
export const REPORT_REASONS = REASONS;

function dashboard(c, counts, open, recent) {
  const t = (rows, head) => `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  return `<p class="eyebrow">Maintainer</p><h1>Registry admin</h1>
  <p>${Object.entries(counts).map(([k, v]) => `<span class="pill ${esc(k)}">${esc(k)}</span> ${v}`).join(" &nbsp; ")}</p>
  <h2>Open reports (${open.length})</h2>
  ${open.length ? t(open.map((r) => `<tr><td>#${r.n}</td><td><a href="/admin/r/${esc(r.record_id)}">${esc(r.record_id)}</a></td><td>${esc(REASONS[r.reason] || r.reason)}</td><td>${esc(when(r.created_at))}</td></tr>`), ["Report", "Record", "Reason", "Filed"]) : '<p class="muted">None.</p>'}
  <h2>Recent records</h2>
  ${t(recent.map((r) => { const doc = JSON.parse(r.doc); return `<tr><td><a href="/admin/r/${esc(r.id)}">${esc(r.id)}</a></td><td>${esc(doc.work.title)}</td><td><span class="pill ${esc(r.status)}">${esc(r.status)}</span></td><td>${esc(r.registered)}</td></tr>`; }), ["ID", "Title", "Status", "Registered"])}
  <form class="search" method="get" action="/admin/find"><label for="fid">Record ID</label><input id="fid" name="id" placeholder="ATI-2026-000001-ABCD" maxlength="40" required><button class="btn" type="submit">Open</button></form>`;
}

function recordView(row, doc, reports, log, flash) {
  const act = (name, label, cls = "secondary") => {
    const pub = name === "dispute";
    return `<form method="post" action="/admin/r/${esc(row.id)}" class="admin-act">
    <input type="hidden" name="act" value="${name}">
    <label>${label} &mdash; ${pub ? "PUBLIC note, shown on the record (keep it neutral)" : "private note (not shown publicly)"}<input type="text" name="note" maxlength="300" ${pub ? "required" : ""}></label>
    <button class="btn ${cls}" type="submit">${label}</button></form>`;
  };
  const buttons = { active: ["dispute", "withdraw", "remove"], disputed: ["resolve", "withdraw", "remove"], withdrawn: ["reinstate", "remove"], removed: [] }[row.status]
    .map((a) => ({ dispute: act("dispute", "Mark disputed"), resolve: act("resolve", "Resolve dispute"),
      withdraw: act("withdraw", "Withdraw"), reinstate: act("reinstate", "Reinstate"), remove: act("remove", "Remove (redact)") })[a]).join("");
  return `<p class="eyebrow">Maintainer</p><h1>${esc(row.id)}</h1>${flash}
  <p><span class="pill ${esc(row.status)}">${esc(row.status)}</span> &middot; registered ${esc(row.registered)} &middot; <a href="/r/${esc(row.id)}">public page</a> &middot; <a href="/admin">dashboard</a></p>
  <div class="table-wrap"><table class="kv"><tbody>
    <tr><th>Title</th><td>${esc(doc.work.title)}</td></tr><tr><th>Author</th><td>${esc(doc.work.author)}</td></tr>
    <tr><th>ISBN</th><td>${esc(doc.work.isbn || "")}</td></tr><tr><th>Label</th><td>${esc(doc.label)}</td></tr>
    <tr><th>Registrant email (private)</th><td>${esc(row.email || "(deleted)")}</td></tr>
    <tr><th>Role declared</th><td>${esc(doc.declared_by.role)}</td></tr></tbody></table></div>
  <h2>Actions</h2>${buttons || '<p class="muted">None.</p>'}
  <h2>Reports (${reports.length})</h2>
  ${reports.length ? reports.map((r) => `<div class="notice"><strong>#${r.n} &middot; ${esc(REASONS[r.reason] || r.reason)} &middot; ${esc(when(r.created_at))} &middot; ${esc(r.status)}</strong><br>${esc(r.details).replace(/\n/g, "<br>")}${r.reporter_email ? `<br><span class="muted">Reporter: ${esc(r.reporter_email)}</span>` : ""}
    ${r.status === "open" ? `<form method="post" action="/admin/report/${r.n}/close"><label>Closing note<input type="text" name="note" maxlength="300"></label><button class="btn secondary" type="submit">Close report</button></form>` : r.note ? `<br><span class="muted">Closed: ${esc(r.note)}</span>` : ""}</div>`).join("") : '<p class="muted">None.</p>'}
  <h2>Public history</h2>
  <div class="table-wrap"><table><thead><tr><th>Date</th><th>Event</th><th>By</th><th>Note</th></tr></thead><tbody>${doc.history.map((h) => `<tr><td>${esc(h.date)}</td><td>${esc(h.event)}</td><td>${esc(h.by || "")}</td><td>${esc(h.note || "")}</td></tr>`).join("")}</tbody></table></div>
  <h2>Private log</h2>
  ${log.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Action</th><th>Note</th></tr></thead><tbody>${log.map((l) => `<tr><td>${esc(when(l.at))}</td><td>${esc(l.action)}</td><td>${esc(l.note || "")}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">None.</p>'}`;
}

/** c: request context from index.js. Returns a Response. */
export async function handleAdmin(c, path) {
  const { env, d, request } = c;
  if (!(await verifyAccess(request, env, d))) return notFound(env);
  const db = env.DB;
  let m;
  if (path === "/admin" && request.method === "GET") {
    const [counts, open, recent] = await Promise.all([dbx.counts(db), dbx.listReports(db, "open"), dbx.recentRecords(db, 25)]);
    return admin(env, "Admin", dashboard(c, counts, open, recent));
  }
  if (path === "/admin/find" && request.method === "GET") {
    const id = (new URL(request.url).searchParams.get("id") || "").trim().toUpperCase();
    return new Response(null, { status: 303, headers: { location: ID_RE.test(id) ? `/admin/r/${id}` : "/admin", "cache-control": "no-store" } });
  }
  if ((m = /^\/admin\/r\/([A-Z0-9-]{1,40})$/.exec(path)) && (request.method === "GET" || request.method === "POST")) {
    const row = await dbx.getRecordRow(db, m[1]);
    if (!row) return notFound(env);
    let doc = JSON.parse(row.doc), flash = "";
    if (request.method === "POST") {
      const f = await c.readForm();
      if (f.error) return message(env, { title: "Bad request", body: "<p>That form could not be read.</p>", status: f.error });
      const act = String(f.one.act || ""), note = String(f.one.note || "").trim().slice(0, 300);
      const res = applyAction(row, doc, act, note, c.today);
      if (res.error) {
        flash = `<div class="notice warn" role="alert">${esc(res.error)}</div>`;
      } else {
        const removed = res.status === "removed";
        // A removed record keeps its ID, status and history only: the address, the link hashes and the search text go.
        let changed;
        try {
          changed = await dbx.updateRecord(db, row.id, {
            status: res.status, updated: c.today, isbn: removed ? null : res.doc.work.isbn, searchKey: removed ? "" : searchKey(res.doc.work),
            workKey: removed ? "" : workKey(res.doc.work), email: removed ? null : row.email, emailHash: removed ? "" : row.email_hash, doc: res.doc,
            prevDoc: row.doc, ...(removed ? { manageHash: "removed:" + row.id, srcHash: "removed:" + row.id } : {}),
          });
        } catch (e) {
          if (!dbx.isUniqueError(e)) throw e;
          changed = -1;
        }
        if (changed === 1) {
          await dbx.adminLog(db, { at: c.nowSec, recordId: row.id, action: act, note });
          return new Response(null, { status: 303, headers: { location: `/admin/r/${row.id}`, "cache-control": "no-store" } });
        }
        flash = `<div class="notice warn" role="alert">${changed === -1 ? "Another live record already has this ISBN, so this record cannot be reinstated." : "The record changed while you were looking at it. Review it and try again."}</div>`;
        return admin(env, row.id, recordView(row, doc, await dbx.reportsFor(db, row.id), await dbx.adminLogFor(db, row.id), flash), 409);
      }
    }
    return admin(env, row.id, recordView(row, doc, await dbx.reportsFor(db, row.id), await dbx.adminLogFor(db, row.id), flash));
  }
  if ((m = /^\/admin\/report\/([0-9]{1,9})\/close$/.exec(path)) && request.method === "POST") {
    const f = await c.readForm();
    if (f.error) return message(env, { title: "Bad request", body: "<p>That form could not be read.</p>", status: f.error });
    await dbx.closeReport(db, Number(m[1]), String(f.one.note || "").trim().slice(0, 300) || null);
    return new Response(null, { status: 303, headers: { location: "/admin", "cache-control": "no-store" } });
  }
  return notFound(env);
}

