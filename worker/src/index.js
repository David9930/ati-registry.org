// ATI Registry Worker: static site (via the ASSETS binding) plus registration, lookup, record pages, record
// management, reports and the admin page. Records live in a private D1 database and are served one at a time.
import { esc, sha256Hex, hmacHex, randomToken, randomSuffix, isoDate, ID_RE, intVar, readForm, ipKey, HONEYPOT } from "./util.js";
import { validateDeclaration, normalizeEmail, normalizeIsbn, clean, searchKey, workKey, wordsKey, canonEmail } from "./validate.js";
import * as dbx from "./db.js";
import { sendMail, confirmEmail, receiptEmail, lostEmail, reportEmail } from "./mail.js";
import { page, message, notFound, getApp, recordPage, removedPage, resultsList, lookupForm, declarationForm, valuesFromDoc, managePage } from "./render.js";
import { handleAdmin, REPORT_REASONS } from "./admin.js";
import { alertsFor, isPageView, sendVisitAlert, logVisit, sendVisitDigest, visitMode } from "./visit.js";

const PENDING_HOURS = 48;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_FIELD = 5000;

export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),
  scheduled: (_event, env, ctx) => { ctx.waitUntil(runDaily(env)); },
};

/** Once a day: email the visit summary (if enabled), then clear out what has expired. */
export async function runDaily(env, deps = {}) {
  const d = { fetch: (...a) => fetch(...a), now: () => Date.now(), ...deps };
  d.mail = deps.mail || ((msg) => sendMail(env, msg, { fetch: d.fetch }));
  try { await sendVisitDigest(env, d); } catch (e) { console.error("visit summary failed:", e && e.message); }
  await dbx.cleanup(env.DB, Math.floor(d.now() / 1000));
}

export async function handle(request, env, ctx, deps = {}) {
  const d = { fetch: (...a) => fetch(...a), now: () => Date.now(), ...deps };
  d.mail = deps.mail || ((msg) => sendMail(env, msg, { fetch: d.fetch }));
  try {
    const res = await route(request, env, d, ctx);
    const mode = visitMode(env);
    if (mode !== "off" && isPageView(request, res)) {
      // "daily" logs every visit for the morning summary; visits from VISIT_ALERT_COUNTRIES also get their own email.
      const jobs = mode === "all" ? [sendVisitAlert(request, env, d)] : [logVisit(request, env, d)];
      if (mode === "daily" && alertsFor(request, env)) jobs.push(sendVisitAlert(request, env, d));
      if (ctx && ctx.waitUntil) ctx.waitUntil(Promise.all(jobs));
    }
    return res;
  } catch (e) {
    console.error("unhandled error:", e && e.stack ? e.stack : String(e));
    try {
      return await message(env, { title: "Something went wrong", status: 500, body: "<p>Something went wrong on our side. Please try again in a few minutes.</p>" });
    } catch {
      return new Response("Something went wrong.", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
  }
}

async function route(request, env, d, ctx) {
  const url = new URL(request.url);
  const method = request.method === "HEAD" ? "GET" : request.method;
  const site = new URL(env.SITE_ORIGIN || url.origin);
  if (url.hostname === "www." + site.hostname) return new Response(null, { status: 301, headers: { location: site.origin + url.pathname + url.search } });
  // Plain http on the real domain goes to https (not on localhost or other hosts, so local development keeps working).
  if (url.protocol === "http:" && site.protocol === "https:" && url.hostname === site.hostname) {
    return new Response(null, { status: 301, headers: { location: site.origin + url.pathname + url.search } });
  }
  if (method !== "GET" && method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD, POST" } });

  const path = url.pathname.replace(/\/+$/, "") || "/";
  const now = d.now();
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  // Work that must not delay the response (and so must not reveal anything through timing) runs after it is sent.
  const defer = (p) => { const q = Promise.resolve(p).catch((e) => console.error("deferred task failed:", e && e.message)); if (ctx && ctx.waitUntil) ctx.waitUntil(q); };
  const c = { request, env, d, url, method, now, nowSec: Math.floor(now / 1000), today: isoDate(now), ip, defer, readForm: () => readForm(request) };

  if (method === "POST" && !sameOrigin(request, url)) {
    return message(env, { title: "Request not accepted", status: 403, body: "<p>This form must be submitted from this website.</p>" });
  }

  let m;
  if (path === "/register") return method === "GET" ? registerGet(c) : registerPost(c);
  if (path === "/verify") return method === "GET" ? verifyGet(c) : verifyPost(c);
  if (path === "/lookup" && method === "GET") return lookup(c);
  if ((m = /^\/r\/([^/]+)$/.exec(path)) && method === "GET") return recordView(c, safeDecode(m[1]));
  if (path === "/report" || (m = /^\/report\/([^/]+)$/.exec(path))) return method === "GET" ? reportGet(c, m && safeDecode(m[1])) : reportPost(c);
  if (path === "/manage/lost") return method === "GET" ? lostGet(c) : lostPost(c);
  if ((m = /^\/manage\/([^/]+)(?:\/(edit|withdraw))?$/.exec(path))) return manage(c, safeDecode(m[1]), m[2] || "");
  if (path === "/admin" || path.startsWith("/admin/")) return handleAdmin(c, path);
  const asset = await env.ASSETS.fetch(request);
  return asset.status === 404 ? notFound(env) : asset;
}

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return ""; } };

// A browser always sends Origin (or Sec-Fetch-Site) on form posts; anything else is not a form on this site.
function sameOrigin(request, url) {
  const origin = request.headers.get("origin");
  if (origin) return origin === url.origin;
  return ["same-origin", "none"].includes(request.headers.get("sec-fetch-site") || "");
}

// ---- limits ---------------------------------------------------------------------------------------------------
// One visitor = one network (an IPv6 visitor controls a whole /64), identified by a salted hash.
async function visitor(c) {
  if (!c.env.HASH_SECRET) throw new Error("HASH_SECRET is not set (wrangler secret put HASH_SECRET)");
  return (c.visitor ||= (await hmacHex(c.env.HASH_SECRET, "ip:" + ipKey(c.ip))).slice(0, 24));
}

const dayKey = (c, key) => `${key}:${isoDate(c.now)}`;
/** Adds `weight` to a per-day counter; true while the total stays within `max`. Over the limit nothing is written. */
async function allow(c, key, weight, max) {
  const day = Math.floor(c.now / 86400000);
  return (await dbx.bump(c.env.DB, dayKey(c, key), weight, (day + 1) * 86400 + 3600, max)) <= max;
}
const tooMany = (c, what = "requests") => message(c.env, { title: "Please try again tomorrow", status: 429,
  body: `<p>Too many ${esc(what)} from your connection today. This limit protects the registry from automated copying and abuse. Please try again tomorrow.</p>` });
const unavailable = (c) => message(c.env, { title: "Temporarily unavailable", status: 503, body: "<p>This part of the registry is temporarily unavailable. Please try again later.</p>" });

// The token must have been issued for this site and for this form (the widget's data-action).
async function verifyTurnstile(c, token, action) {
  if (!token || token.length > 2048) return false;
  const body = new URLSearchParams({ secret: c.env.TURNSTILE_SECRET, response: token });
  if (c.ip !== "unknown") body.set("remoteip", c.ip);
  try {
    const res = await c.d.fetch(c.env.TURNSTILE_VERIFY_URL || "https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const r = await res.json();
    return r.success === true && r.hostname === new URL(c.env.SITE_ORIGIN || c.url.origin).hostname && r.action === action;
  } catch {
    return false;
  }
}
const botCheckReady = (env) => Boolean(env.TURNSTILE_SECRET && env.TURNSTILE_SITEKEY && env.HASH_SECRET);

// ---- helpers --------------------------------------------------------------------------------------------------
function formValues(f) {
  const v = {};
  for (const k in f.one) v[k] = f.one[k].slice(0, MAX_FIELD);
  v.formats = (f.many.formats || []).slice(0, 10);
  v.attest = (f.many.attest || []).slice(0, 10);
  return v;
}
const attestationDoc = (data) => Object.fromEntries(Object.keys(data.attestations).map((k) => [k, true]));
const formError = (c, f) => message(c.env, { title: "That form could not be read", status: f.error, body: "<p>Please go back and submit the form again.</p>" });

async function registerPageHtml(c, values, errors, status = 200) {
  const { data } = await getApp(c.env);
  const r = data.register;
  const ready = botCheckReady(c.env);
  const body = ready
    ? declarationForm({ data, values, errors, action: "/register", mode: "register", sitekey: c.env.TURNSTILE_SITEKEY })
    : `<div class="notice warn">Registration is not open yet. Please check back soon.</div>`;
  return page(c.env, {
    title: r.title, desc: r.description, status, turnstile: ready,
    content: `<article class="prose" style="max-width:52rem"><p class="eyebrow">${esc(r.eyebrow)}</p><h1>${esc(r.title)}</h1>${r.intro_html}${body}${r.after_html}</article>`,
  });
}
const registerGet = (c) => registerPageHtml(c, {}, []);

const sentPage = (c, email) => message(c.env, {
  title: "Check your email", kind: "",
  body: `<p>If the details are valid, we have sent a confirmation link to <strong>${esc(email || "your address")}</strong>. It stays valid for ${PENDING_HOURS} hours. Nothing is published until you open it.</p>
         <p class="muted">Nothing arrived? Check your spam folder, or submit the form again.</p>`,
});

// ---- registration ---------------------------------------------------------------------------------------------
async function registerPost(c) {
  const { env, d } = c;
  const f = await c.readForm();
  if (f.error) return formError(c, f);
  const values = formValues(f);
  if (!botCheckReady(env)) return unavailable(c);
  if (f.one[HONEYPOT]) return sentPage(c, f.one.email); // honeypot: pretend, store nothing
  if (!(await allow(c, `reg:${await visitor(c)}`, 1, intVar(env, "MAX_REG_PER_IP_DAY", 10)))) return tooMany(c, "registration attempts");

  const { data } = await getApp(env);
  const { errors, doc } = validateDeclaration(values, data, c.today);
  const email = normalizeEmail(values.email);
  if (!email) errors.push("Enter a valid email address, for example name@example.com.");
  if (errors.length) return registerPageHtml(c, values, errors, 400);

  if (!(await verifyTurnstile(c, f.one["cf-turnstile-response"], "register"))) {
    return registerPageHtml(c, values, ["The bot check did not complete. Please try again."], 400);
  }
  if (doc.work.isbn) {
    const owner = await dbx.findIsbnOwner(env.DB, doc.work.isbn);
    if (owner) return registerPageHtml(c, values, [`This ISBN is already registered as ${owner.id}. If that record is wrong, report it rather than registering the book again.`], 400);
  }
  const emailHash = await hmacHex(env.HASH_SECRET, "email:" + email);
  const mailbox = await hmacHex(env.HASH_SECRET, "mailbox:" + canonEmail(email)); // name+tag@ counts as name@
  if (!(await allow(c, `mail:${mailbox}`, 1, intVar(env, "MAX_EMAILS_PER_ADDR_DAY", 3)))) return tooMany(c, "messages to this address");
  if (!(await allow(c, "mail:all", 1, intVar(env, "MAX_EMAILS_TOTAL_DAY", 150)))) return unavailable(c);

  const token = randomToken(), tokenHash = await sha256Hex(token);
  await dbx.insertPending(env.DB, { tokenHash, now: c.nowSec, expires: c.nowSec + PENDING_HOURS * 3600, email, emailHash, doc });
  try {
    await d.mail({ to: email, ...confirmEmail(`${new URL(env.SITE_ORIGIN || c.url.origin).origin}/verify?t=${token}`, PENDING_HOURS) });
  } catch (e) {
    console.error("confirmation email failed:", e && e.message);
    await dbx.deletePending(env.DB, tokenHash);
    return message(env, { title: "We could not send the email", status: 503, body: "<p>We could not send the confirmation email just now. Please try again in a few minutes.</p>" });
  }
  return sentPage(c, email);
}

async function verifyGet(c) {
  const t = c.url.searchParams.get("t") || "";
  const pending = TOKEN_RE.test(t) ? await dbx.getPending(c.env.DB, await sha256Hex(t), c.nowSec) : null;
  if (!pending) return verifyProblem(c, t);
  const w = pending.doc.work;
  return message(c.env, {
    title: "Confirm your declaration",
    body: `<p>Confirm that you want to publish this declaration for <strong>${esc(w.title)}</strong> by ${esc(w.author)}. Your email address will not be published.</p>
      <form method="post" action="/verify"><input type="hidden" name="t" value="${esc(t)}">
      <div class="hp" aria-hidden="true"><label>Leave this field empty<input type="text" name="${HONEYPOT}" tabindex="-1" autocomplete="off"></label></div>
      <button class="btn" type="submit">Confirm and publish</button></form>`,
  });
}

const isIsbnConflict = (e) => dbx.isUniqueError(e) && /records\.isbn/.test(String((e && e.message) || e));

async function verifyProblem(c, t) {
  if (TOKEN_RE.test(t) && (await dbx.getRecordBySrc(c.env.DB, await sha256Hex(t)))) {
    return message(c.env, { title: "Already confirmed", body: "<p>This declaration was already confirmed. The link to manage it was shown when you confirmed it, and we emailed it to you. If you cannot find it, you can <a href=\"/manage/lost\">request a new one</a>.</p>" });
  }
  return message(c.env, { title: "This link is not valid", status: 404,
    body: `<p>The link is invalid or has expired (links last ${PENDING_HOURS} hours). You can <a href="/register">submit the declaration again</a>.</p>` });
}

async function verifyPost(c) {
  const { env, d } = c;
  const f = await c.readForm();
  if (f.error) return formError(c, f);
  if (f.one[HONEYPOT]) return verifyProblem(c, "");
  const t = f.one.t || "";
  if (!TOKEN_RE.test(t) || !botCheckReady(env)) return verifyProblem(c, t);
  const tokenHash = await sha256Hex(t);
  const done = await dbx.getRecordBySrc(env.DB, tokenHash);
  if (done) return verifyProblem(c, t);
  const pending = await dbx.getPending(env.DB, tokenHash, c.nowSec);
  if (!pending) return verifyProblem(c, t);
  const dailyMax = intVar(env, "MAX_REG_TOTAL_DAY", 100);
  if ((await dbx.peek(env.DB, dayKey(c, "regdone"))) >= dailyMax) {
    return message(env, { title: "Daily limit reached", status: 503, body: "<p>The registry has reached its daily limit for new registrations. Your confirmation link stays valid, so please try again tomorrow if it has not expired.</p>" });
  }
  const { data } = await getApp(env);
  const doc = pending.doc, w = doc.work;
  const taken = w.isbn && (await dbx.findIsbnOwner(env.DB, w.isbn));
  const same = !taken && (await dbx.findSameWork(env.DB, pending.email_hash, workKey(w), w.isbn));
  const notRegistered = async (owner, isbnClash) => {
    await dbx.deletePending(env.DB, tokenHash);
    const id = esc(owner.id);
    return message(env, { title: "Not registered", status: 409,
      body: `<p>${isbnClash ? `This ISBN was registered in the meantime as <a href="/r/${id}">${id}</a>.` : `You have already registered this work as <a href="/r/${id}">${id}</a>.`} If that record is wrong, report it, or use your private link to correct it.</p>` });
  };
  if (taken) return notRegistered(taken, true);
  if (same) return notRegistered(same, false);
  const manageToken = randomToken(), year = Number(c.today.slice(0, 4));
  const full = {
    work: w, label: doc.label, definitions_version: data.definitions_version, statement: doc.statement, components: doc.components,
    ai_tools: doc.ai_tools, attestation: attestationDoc(data), declared_by: { role: doc.role, email_verified: true },
    history: [{ date: c.today, event: "registered", by: "registrant" }],
  };
  let id;
  for (let attempt = 0; ; attempt++) {
    try {
      id = await dbx.createRecord(env.DB, { year, suffix: randomSuffix(), today: c.today, isbn: w.isbn, searchKey: searchKey(w), workKey: workKey(w),
        email: pending.email, emailHash: pending.email_hash, manageHash: await sha256Hex(manageToken), srcHash: tokenHash, doc: full });
      break;
    } catch (e) {
      if (await dbx.getRecordBySrc(env.DB, tokenHash)) return verifyProblem(c, t); // a double click got there first
      if (isIsbnConflict(e)) { // another confirmation took the ISBN between the check above and the insert
        const owner = await dbx.findIsbnOwner(env.DB, w.isbn);
        if (owner) return notRegistered(owner, true);
      }
      if (attempt >= 4) throw e;
    }
  }
  await dbx.deletePending(env.DB, tokenHash);
  await allow(c, "regdone", 1, dailyMax); // counted only now that a record exists
  const origin = new URL(env.SITE_ORIGIN || c.url.origin).origin, manageUrl = `${origin}/manage/${manageToken}`;
  try { await d.mail({ to: pending.email, ...receiptEmail(id, `${origin}/r/${id}`, manageUrl) }); } catch (e) { console.error("receipt email failed:", e && e.message); }
  return message(env, {
    title: "Your declaration is registered",
    body: `<p>Your declaration is registered as <span class="record-id">${esc(id)}</span>.</p>
      <p><a class="btn" href="/r/${esc(id)}">View the public record</a> <a class="btn secondary" href="/marks/">Get the marks</a></p>
      <div class="notice warn"><strong>Keep this link private.</strong> It is the only way to correct or withdraw the record, and anyone who has it can do so. We have also emailed it to you.
      <p class="mono" style="word-break:break-all;margin:.6rem 0 0"><a href="/manage/${esc(manageToken)}">${esc(manageUrl)}</a></p></div>`,
  });
}

// ---- lookup and record pages ----------------------------------------------------------------------------------
async function lookup(c) {
  const { env } = c, app = await getApp(env);
  const q = clean(c.url.searchParams.get("q") || "").slice(0, 100);
  if (!q) return new Response(null, { status: 302, headers: { location: "/registry/" } });
  if (!(await allow(c, `look:${await visitor(c)}`, 1, intVar(env, "MAX_LOOKUPS_PER_IP_DAY", 60)))) return tooMany(c, "searches");
  const upper = q.toUpperCase();
  if (ID_RE.test(upper)) return new Response(null, { status: 302, headers: { location: `/r/${upper}`, "cache-control": "no-store" } });

  let rows = [], note = "";
  const isbn = normalizeIsbn(q);
  if (isbn) rows = await dbx.lookupIsbn(env.DB, isbn, 5);
  else {
    const words = wordsKey(q).split(" ").filter(Boolean).slice(0, 6);
    if (words.join("").length < 4) note = "Type at least four characters of the title or author, or an ID or ISBN.";
    else if (!(await allow(c, "search:all", 1, intVar(env, "MAX_SEARCHES_TOTAL_DAY", 3000)))) return unavailable(c);
    else rows = await dbx.searchWords(env.DB, words, 5);
  }
  const results = rows.length
    ? `<p class="muted">${rows.length === 5 ? "Showing the first 5 matches. Add more of the title or the author&rsquo;s name to narrow them." : `${rows.length} match${rows.length === 1 ? "" : "es"}.`}</p>${resultsList(app, rows, dbx.recordFromRow)}`
    : `<p>${note ? esc(note) : "No matching record. Check the spelling, or try the ISBN or the ID printed in the book."}</p>`;
  return page(env, { title: "Find a record", noindex: true, content: `<article class="prose"><p class="eyebrow">Public records</p><h1>Find a record</h1>${lookupForm(q)}${results}</article>` });
}

async function recordView(c, rawId) {
  const { env } = c, id = rawId.toUpperCase();
  const miss = async () => {
    if (!(await allow(c, `view:${await visitor(c)}`, 5, intVar(env, "MAX_VIEWS_PER_IP_DAY", 300)))) return tooMany(c, "record views");
    return message(env, { title: "Record not found", status: 404, body: '<p>No record has that ID. Check it against the ID printed in the book, or <a href="/registry/">search the registry</a>.</p>' });
  };
  if (!ID_RE.test(id)) return message(env, { title: "Record not found", status: 404, body: '<p>That is not a valid record ID. Check it against the ID printed in the book, or <a href="/registry/">search the registry</a>.</p>' });
  if (!(await allow(c, `view:${await visitor(c)}`, 1, intVar(env, "MAX_VIEWS_PER_IP_DAY", 300)))) return tooMany(c, "record views");
  const row = await dbx.getRecordRow(env.DB, id);
  if (!row) return miss();
  const app = await getApp(env), rec = dbx.recordFromRow(row);
  if (rec.status === "removed") return page(env, { title: `${id} · removed`, content: removedPage(rec), status: 410, noindex: true });
  const w = rec.work, name = app.data.labels[rec.label].name;
  return page(env, {
    title: `${id} · ${w.title}${w.subtitle ? ": " + w.subtitle : ""}`,
    desc: `${name}: self-declared AI-use label for ${w.title} by ${w.author}.`, content: recordPage(app, rec),
  });
}

// ---- reports --------------------------------------------------------------------------------------------------
async function reportPageHtml(c, values, errors, status = 200) {
  const ready = botCheckReady(c.env);
  const err = errors.length ? `<div class="notice warn" role="alert"><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : "";
  const reasons = Object.entries(REPORT_REASONS).map(([k, t]) => `<option value="${esc(k)}"${values.reason === k ? " selected" : ""}>${esc(t)}</option>`).join("");
  const form = ready ? `<form method="post" action="/report" class="reg-form">
    <div class="field"><label for="record">Record ID</label><input type="text" id="record" name="record" value="${esc(values.record || "")}" maxlength="40" required placeholder="ATI-2026-000001-ABCD"></div>
    <div class="field"><label for="reason">What is the problem?</label><select id="reason" name="reason" required><option value="">Choose&hellip;</option>${reasons}</select></div>
    <div class="field"><label for="details">Details</label><textarea id="details" name="details" rows="6" maxlength="1500" required>${esc(values.details || "")}</textarea><p class="hint">What is inaccurate, with evidence where you can. 20 to 1,500 characters. Keep to the facts.</p></div>
    <div class="field"><label for="email">Your email address (optional)</label><input type="email" id="email" name="email" value="${esc(values.email || "")}" maxlength="254" autocomplete="email"><p class="hint">Only if you would like a reply. It is not published or shared with the registrant.</p></div>
    <div class="hp" aria-hidden="true"><label>Leave this field empty<input type="text" name="${HONEYPOT}" tabindex="-1" autocomplete="off"></label></div>
    <div class="field"><div class="cf-turnstile" data-sitekey="${esc(c.env.TURNSTILE_SITEKEY)}" data-action="report"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></div>
    <button class="btn" type="submit">Send report</button></form>` : `<div class="notice warn">Reports are not open yet. Please check back soon.</div>`;
  return page(c.env, { title: "Report a problem", status, turnstile: ready, noindex: true,
    content: `<article class="prose"><p class="eyebrow">Accountability</p><h1>Report a problem with a record</h1>
      <p>Reports go privately to the maintainers. See <a href="/disputes/">how disputes work</a>.</p>${err}${form}</article>` });
}
const reportGet = (c, id) => reportPageHtml(c, { record: id ? id.toUpperCase() : "" }, []);

async function reportPost(c) {
  const { env, d } = c;
  const f = await c.readForm();
  if (f.error) return formError(c, f);
  const v = formValues(f);
  if (!botCheckReady(env)) return unavailable(c);
  if (v[HONEYPOT]) return message(env, { title: "Report received", body: "<p>Thank you. The maintainers will review your report.</p>" });
  if (!(await allow(c, `rep:${await visitor(c)}`, 1, intVar(env, "MAX_REPORTS_PER_IP_DAY", 5)))) return tooMany(c, "reports");
  const errs = [], id = clean(v.record).toUpperCase(), details = clean(v.details, true), email = v.email ? normalizeEmail(v.email) : null;
  if (!ID_RE.test(id)) errs.push("Enter the record ID exactly as shown on its page.");
  if (!Object.hasOwn(REPORT_REASONS, v.reason)) errs.push("Choose what the problem is.");
  if (details.length < 20 || details.length > 1500) errs.push("The details must be between 20 and 1,500 characters.");
  if (v.email && !email) errs.push("The email address is not valid (it is optional).");
  if (errs.length) return reportPageHtml(c, v, errs, 400);
  if (!(await verifyTurnstile(c, f.one["cf-turnstile-response"], "report"))) return reportPageHtml(c, v, ["The bot check did not complete. Please try again."], 400);
  const row = await dbx.getRecordRow(env.DB, id);
  if (!row) return reportPageHtml(c, v, ["No record has that ID."], 400);
  if (row.status === "removed") return message(env, { title: "Already removed", body: "<p>That record has already been removed by the registry.</p>" });
  const n = await dbx.insertReport(env.DB, { now: c.nowSec, recordId: id, reason: v.reason, details, email });
  if (env.ADMIN_EMAIL) {
    try { await d.mail({ to: env.ADMIN_EMAIL, ...reportEmail(n, id, v.reason, new URL(env.SITE_ORIGIN || c.url.origin).origin) }); } catch (e) { console.error("report email failed:", e && e.message); }
  }
  return message(env, { title: "Report received", body: "<p>Thank you. The maintainers will review your report as capacity allows; this is a volunteer-run pilot, so there is no guaranteed response time.</p>" });
}

// ---- managing a record (private link) -------------------------------------------------------------------------
async function manage(c, token, action) {
  const { env } = c;
  const bad = async () => {
    await allow(c, `man:${await visitor(c)}`, 10, 100);
    return message(env, { title: "This link is not valid", status: 404, body: '<p>The link is wrong, or it was replaced by a newer one. You can <a href="/manage/lost">request a new link</a> by email.</p>' });
  };
  if (!TOKEN_RE.test(token)) return bad();
  if (!(await allow(c, `man:${await visitor(c)}`, 1, 100))) return tooMany(c, "attempts");
  const row = await dbx.getRecordByManage(env.DB, await sha256Hex(token));
  if (!row) return bad();
  const app = await getApp(env), rec = dbx.recordFromRow(row), live = rec.status === "active" || rec.status === "disputed";
  const doc = JSON.parse(row.doc);
  const shell = (title, content, extra = {}) => page(env, { title, content, noindex: true, ...extra });

  if (!action && c.method === "GET") return shell(`Manage ${rec.id}`, managePage(rec, token));
  if (action === "edit" && c.method === "GET") {
    if (!live) return shell(`Manage ${rec.id}`, managePage(rec, token), { status: 409 });
    return editPage(c, app, rec, token, valuesFromDoc(doc, app.data), []);
  }
  if (c.method !== "POST") return notFound(env);
  const f = await c.readForm();
  if (f.error) return formError(c, f);
  if (f.one[HONEYPOT]) return notFound(env);

  if (action === "withdraw") {
    if (rec.status !== "active" || f.one.confirm !== "yes") return shell(`Manage ${rec.id}`, managePage(rec, token, '<div class="notice warn" role="alert">This record cannot be withdrawn here.</div>'), { status: 409 });
    const next = { ...doc, history: [...doc.history, { date: c.today, event: "withdrawn", by: "registrant" }] };
    const saved = await save(c, row, { status: "withdrawn", updated: c.today, isbn: next.work.isbn, searchKey: row.search_key, workKey: row.work_key, email: row.email, doc: next });
    if (saved !== "ok") return staleResponse(c, token);
    return shell(`Manage ${rec.id}`, managePage({ ...rec, status: "withdrawn" }, token, '<div class="notice">The record has been withdrawn. It stays visible with the status &ldquo;withdrawn&rdquo;.</div>'));
  }
  if (action === "edit") {
    if (!live) return shell(`Manage ${rec.id}`, managePage(rec, token), { status: 409 });
    const values = formValues(f);
    const { errors, doc: fresh } = validateDeclaration(values, app.data, c.today);
    if (!errors.length && fresh.work.isbn && (await dbx.findIsbnOwner(env.DB, fresh.work.isbn, rec.id))) errors.push("This ISBN is registered under another record. If that record is wrong, report it.");
    if (!errors.length && (await dbx.findSameWork(env.DB, row.email_hash, workKey(fresh.work), fresh.work.isbn, rec.id))) errors.push("You have already registered this work under another record.");
    if (errors.length) return editPage(c, app, rec, token, values, errors, 400);
    const changed = changedFields(doc, fresh);
    const next = {
      ...doc, work: fresh.work, label: fresh.label, definitions_version: app.data.definitions_version, statement: fresh.statement,
      components: fresh.components, ai_tools: fresh.ai_tools, attestation: attestationDoc(app.data), declared_by: { ...doc.declared_by, role: fresh.role },
      history: [...doc.history, { date: c.today, event: "corrected", by: "registrant", note: changed.length ? `Changed: ${changed.join(", ")}.` : "No change to the declaration itself." }],
    };
    const saved = await save(c, row, { status: rec.status, updated: c.today, isbn: fresh.work.isbn, searchKey: searchKey(fresh.work), workKey: workKey(fresh.work), email: row.email, doc: next });
    if (saved === "stale") return staleResponse(c, token);
    if (saved === "isbn") return editPage(c, app, rec, token, values, ["This ISBN is registered under another record. If that record is wrong, report it."], 400);
    return shell(`Manage ${rec.id}`, managePage({ ...rec, ...next, id: rec.id, status: rec.status }, token, '<div class="notice">Your corrections are saved and recorded in the history.</div>'));
  }
  return notFound(env);
}

// Writes a changed record only if it is still exactly as it was read, so a registrant's edit made from an old copy
// can never undo a maintainer's action (or the reverse). Returns "ok", "stale" or "isbn" (another live record has it).
async function save(c, row, f) {
  try {
    return (await dbx.updateRecord(c.env.DB, row.id, { prevDoc: row.doc, emailHash: row.email_hash, ...f })) === 1 ? "ok" : "stale";
  } catch (e) {
    if (isIsbnConflict(e)) return "isbn";
    throw e;
  }
}
const staleResponse = (c, token) => message(c.env, { title: "The record has changed", status: 409,
  body: `<p>This record was changed while you were working on it (for example by a maintainer), so your change was not saved. <a href="/manage/${esc(token)}">Reload the record</a> to see its current state.</p>` });

// Which public parts of the declaration an edit changes, shown in the record's history (names only).
function changedFields(a, b) {
  const out = [], same = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  for (const k of ["title", "subtitle", "author", "year", "isbn", "edition", "url", "formats"]) if (!same(a.work[k], b.work[k])) out.push(k);
  if (a.label !== b.label) out.push("label");
  if (a.statement !== b.statement) out.push("statement");
  if (!same(a.components, b.components)) out.push("components");
  if (!same(a.ai_tools, b.ai_tools)) out.push("AI tools");
  return out;
}

const editPage = (c, app, rec, token, values, errors, status = 200) => page(c.env, {
  title: `Correct ${rec.id}`, status, noindex: true,
  content: `<article class="prose" style="max-width:52rem"><p class="eyebrow">Your private link</p><h1>Correct ${esc(rec.id)}</h1>
    <p>Changes are public and are added to the record&rsquo;s history. You need to tick the confirmations again.</p>
    ${declarationForm({ data: app.data, values, errors, action: `/manage/${token}/edit`, mode: "edit" })}</article>`,
});

// ---- lost links -----------------------------------------------------------------------------------------------
async function lostPageHtml(c, errors = [], status = 200) {
  const ready = botCheckReady(c.env);
  const err = errors.length ? `<div class="notice warn" role="alert"><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : "";
  const form = ready ? `<form method="post" action="/manage/lost" class="reg-form">
    <div class="field"><label for="email">The email address you registered with</label><input type="email" id="email" name="email" maxlength="254" required autocomplete="email"></div>
    <div class="hp" aria-hidden="true"><label>Leave this field empty<input type="text" name="${HONEYPOT}" tabindex="-1" autocomplete="off"></label></div>
    <div class="field"><div class="cf-turnstile" data-sitekey="${esc(c.env.TURNSTILE_SITEKEY)}" data-action="lost"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></div>
    <button class="btn" type="submit">Email me new links</button></form>` : `<div class="notice warn">This is not open yet. Please check back soon.</div>`;
  return page(c.env, { title: "Request a new management link", status, turnstile: ready, noindex: true,
    content: `<article class="prose"><p class="eyebrow">Your records</p><h1>Request a new management link</h1>
      <p>We will email new private links for the records registered with that address. Each new link replaces the old one.</p>${err}${form}</article>` });
}
const lostGet = (c) => lostPageHtml(c);

async function lostPost(c) {
  const { env } = c;
  const f = await c.readForm();
  if (f.error) return formError(c, f);
  if (!botCheckReady(env)) return unavailable(c);
  const generic = () => message(env, { title: "Check your email", body: "<p>If that address has registered records, we have sent new management links to it.</p>" });
  if (f.one[HONEYPOT]) return generic();
  if (!(await allow(c, `lost:${await visitor(c)}`, 1, 10))) return tooMany(c, "requests");
  const email = normalizeEmail(f.one.email);
  if (!email) return lostPageHtml(c, ["Enter a valid email address."], 400);
  if (!(await verifyTurnstile(c, f.one["cf-turnstile-response"], "lost"))) return lostPageHtml(c, ["The bot check did not complete. Please try again."], 400);
  // Everything that depends on whether the address has records happens after the reply is sent, so the reply is the
  // same, and takes the same time, for every address.
  c.defer(sendLostLinks(c, email));
  return generic();
}

async function sendLostLinks(c, email) {
  const { env, d } = c;
  const mailbox = await hmacHex(env.HASH_SECRET, "mailbox:" + canonEmail(email));
  // These limits are separate from the registration ones, so neither can be used to exhaust the other.
  if (!(await allow(c, `lostbox:${mailbox}`, 1, intVar(env, "MAX_LOST_PER_ADDR_DAY", 3)))) return;
  if (!(await allow(c, "lostmail:all", 1, intVar(env, "MAX_LOST_EMAILS_TOTAL_DAY", 50)))) return;
  const recs = await dbx.recordsByEmailHash(env.DB, await hmacHex(env.HASH_SECRET, "email:" + email));
  if (!recs.length) return;
  const origin = new URL(env.SITE_ORIGIN || c.url.origin).origin;
  const items = recs.map((r) => { const token = randomToken(); return { id: r.id, token, link: `${origin}/manage/${token}` }; });
  try {
    await d.mail({ to: email, ...lostEmail(items) });
    // the old links stop working only once the message with the new ones has been sent, and all together
    await dbx.setManageHashes(env.DB, await Promise.all(items.map(async (i) => [i.id, await sha256Hex(i.token)])));
  } catch (e) {
    console.error("lost-link email failed:", e && e.message);
  }
}
