// Visit reports for the maintainer: time, page, approximate place (country and region from Cloudflare) and a coarse
// visitor type. The IP address, user-agent text, query strings and private links are never stored or sent.
//
// VISIT_ALERTS (needs ADMIN_EMAIL):  "daily" = log page views and email one summary each morning (default);
//                                    "all"   = one email per page view, capped per day;   "off" = nothing.
import { intVar, isoDate } from "./util.js";
import * as dbx from "./db.js";

// Pages that carry private links or belong to the maintainer: never reported.
const PRIVATE_PATH = /^\/(admin|manage|verify)(\/|$)/;

// Order matters: the first match wins. Read from the user-agent header, which a visitor can fake.
const KINDS = [
  [/chatgpt-user|gptbot|oai-searchbot|openai/i, "OpenAI / ChatGPT (bot)"],
  [/claudebot|claude-user|claude-searchbot|anthropic/i, "Anthropic / Claude (bot)"],
  [/google/i, "Google, search or Gemini (bot)"],
  [/bingbot|msnbot|bingpreview/i, "Microsoft Bing (bot)"],
  [/perplexity/i, "Perplexity (bot)"],
  [/applebot/i, "Apple (bot)"],
  [/duckduckbot|duckassistbot/i, "DuckDuckGo (bot)"],
  [/facebookexternalhit|meta-externalagent|facebot|twitterbot|slackbot|linkedinbot|discordbot|telegrambot|whatsapp/i, "Link preview (bot)"],
  [/bot|crawl|spider|slurp|fetch|scrape|curl|wget|python|node|go-http|java|okhttp|axios|headless|monitor|uptime/i, "Other bot or script"],
];
const PEOPLE = "Browser (probably a person)";
const NO_UA = "No user agent (a script)";
const GENERIC_BOTS = new Set(["Other bot or script", NO_UA]);

export function visitorKind(userAgent) {
  const ua = String(userAgent || "");
  if (!ua) return NO_UA;
  for (const [re, label] of KINDS) if (re.test(ua)) return label;
  return PEOPLE;
}

function countryName(code) {
  if (!code || code === "XX") return "unknown country";
  if (code === "T1") return "Tor network";
  try { return new Intl.DisplayNames(["en"], { type: "region" }).of(code) || code; } catch { return code; }
}

const tzOf = (env) => env.VISIT_TZ || "America/New_York";
const place = (r) => [r.region, r.country].filter(Boolean).join(", ") || "unknown location";
function fmtTime(ms, tz, withZone = false) {
  try {
    const t = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(ms);
    return withZone ? `${t} (${tz})` : t;
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  }
}

/** The mode in force: "daily", "all" or "off" (also "off" whenever there is nobody to send to). */
export function visitMode(env) {
  const m = String(env.VISIT_ALERTS || "").toLowerCase();
  return env.ADMIN_EMAIL && (m === "daily" || m === "all") ? m : "off";
}

/** True for a public HTML page that was served successfully. */
export function isPageView(request, response) {
  if (request.method !== "GET" || response.status !== 200) return false;
  if (!/^text\/html/i.test(response.headers.get("content-type") || "")) return false;
  return !PRIVATE_PATH.test(new URL(request.url).pathname.replace(/\/+$/, "") || "/");
}

function describeVisit(request) {
  const cf = request.cf || {};
  return {
    country: countryName(cf.country),
    region: String(cf.region || "").slice(0, 80),
    path: new URL(request.url).pathname.replace(/[^\x21-\x7e]/g, "").slice(0, 120) || "/",
    kind: visitorKind(request.headers.get("user-agent")),
  };
}

// ---- daily mode -----------------------------------------------------------------------------------------------

/** Records one page view (no IP, no user-agent text). Capped per day; never throws. */
export async function logVisit(request, env, d) {
  try {
    const now = d.now();
    const cap = intVar(env, "MAX_VISIT_LOG_DAY", 5000);
    const exp = (Math.floor(now / 86400000) + 3) * 86400; // kept two extra days so the summary can say the cap was hit
    if ((await dbx.bump(env.DB, `visitlog:${isoDate(now)}`, 1, exp, cap)) > cap) return;
    await dbx.logVisit(env.DB, { at: Math.floor(now / 1000), ...describeVisit(request) });
  } catch (e) {
    console.error("visit log failed:", e && e.message);
  }
}

const tally = (items) => {
  const m = new Map();
  for (const x of items) m.set(x, (m.get(x) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
};

export function digestEmail({ rows, tz, maxRows, capped = [], logCap }) {
  const people = rows.filter((r) => r.kind === PEOPLE);
  const named = rows.filter((r) => r.kind !== PEOPLE && !GENERIC_BOTS.has(r.kind));
  const generic = rows.filter((r) => GENERIC_BOTS.has(r.kind));
  const first = rows[0].at * 1000, last = rows[rows.length - 1].at * 1000;
  const countries = tally(rows.map((r) => r.country || "unknown country"));
  const out = [];

  out.push(`Visits to ati-registry.org`, `From ${fmtTime(first, tz)} to ${fmtTime(last, tz, true)}`, "",
    `${rows.length} page views: ${people.length} look like people, ${named.length + generic.length} are bots or scripts. ` +
    `${countries.length} ${countries.length === 1 ? "country" : "countries"}.`);
  if (capped.length) out.push(`Note: logging reached its daily limit of ${logCap} on ${capped.join(", ")}, so there were more visits than listed.`);

  out.push("", `LIKELY PEOPLE (${people.length})`);
  if (!people.length) out.push("  none");
  for (const r of people.slice(0, maxRows)) out.push(`  ${fmtTime(r.at * 1000, tz)}   ${place(r)}   ${r.path}`);
  if (people.length > maxRows) out.push(`  ... and ${people.length - maxRows} more`);

  out.push("", `NAMED BOTS: AI assistants, search engines, link previews (${named.length})`);
  if (!named.length) out.push("  none");
  for (const [kind, n] of tally(named.map((r) => r.kind))) {
    const mine = named.filter((r) => r.kind === kind);
    const places = tally(mine.map(place)).slice(0, 5).map(([p, c]) => (c > 1 ? `${p} x${c}` : p)).join("; ");
    out.push(`  ${kind}: ${n} ${n === 1 ? "visit" : "visits"}, ${fmtTime(mine[0].at * 1000, tz)} to ${fmtTime(mine[mine.length - 1].at * 1000, tz)}. From ${places}`);
  }

  out.push("", `OTHER BOTS AND SCRIPTS (${generic.length})`);
  if (!generic.length) out.push("  none");
  else out.push("  " + tally(generic.map((r) => r.country || "unknown country")).slice(0, 8).map(([c, n]) => `${c} ${n}`).join(", "));

  out.push("", "ALL VISITS BY COUNTRY", "  " + countries.slice(0, 12).map(([c, n]) => `${c} ${n}`).join(", ") + (countries.length > 12 ? `, and ${countries.length - 12} more` : ""));
  out.push("", "—", "Places come from Cloudflare (approximate); the visitor type is the browser's own label, which can be faked. No IP addresses are recorded. " +
    'Set VISIT_ALERTS to "all" for an email per visit, or "off" to stop these, in worker/wrangler.toml.');

  return { subject: `[ATI] Daily visits: ${rows.length} (${people.length} likely ${people.length === 1 ? "person" : "people"})`, text: out.join("\n") };
}

/** Emails the summary of every unsent logged visit; the rows are marked sent only after the email went out. */
export async function sendVisitDigest(env, d) {
  if (visitMode(env) !== "daily") return;
  const rows = await dbx.unsentVisits(env.DB, 5000);
  if (!rows.length) return;
  const logCap = intVar(env, "MAX_VISIT_LOG_DAY", 5000);
  const capped = [];
  for (const day of [...new Set(rows.map((r) => isoDate(r.at * 1000)))]) {
    if ((await dbx.peek(env.DB, `visitlog:${day}`)) >= logCap) capped.push(day);
  }
  await d.mail({ to: env.ADMIN_EMAIL, ...digestEmail({ rows, tz: tzOf(env), maxRows: intVar(env, "VISIT_DIGEST_ROWS", 200), capped, logCap }) });
  await dbx.markVisitsSent(env.DB, rows[rows.length - 1].n);
}

// ---- "all" mode: one email per page view ----------------------------------------------------------------------

export function visitEmail({ ms, tz, v, cap }) {
  const where = place(v);
  return {
    subject: `[ATI] Visit from ${where} · ${v.kind}`,
    text: `Someone opened a page on ati-registry.org.\n\nWhen:     ${fmtTime(ms, tz, true)}  =  ${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC\nFrom:     ${where}\nPage:     ${v.path}\nVisitor:  ${v.kind}\n\n` +
          `The place is the visitor's approximate location from Cloudflare, and the visitor type is read from the browser's own label, which can be faked. ` +
          `No IP address is recorded or included. At most ${cap} of these are sent a day; set VISIT_ALERTS to "daily" for one summary a day or "off" to stop them.`,
  };
}

/** Sends the alert for one page view. Never throws; resolves when done. */
export async function sendVisitAlert(request, env, d) {
  try {
    const cap = intVar(env, "MAX_VISIT_ALERTS_DAY", 60);
    const now = d.now();
    const exp = (Math.floor(now / 86400000) + 1) * 86400 + 3600;
    const day = isoDate(now);
    const n = await dbx.bump(env.DB, `visitmail:${day}`, 1, exp, cap);
    if (n > cap) {
      // The cap was reached: say so once, then stay quiet until the next day.
      if ((await dbx.bump(env.DB, `visitcap:${day}`, 1, exp, 1)) === 1) {
        await d.mail({ to: env.ADMIN_EMAIL, subject: "[ATI] Visit alerts paused for today",
          text: `${cap} visit alerts have been sent today, so no more will be sent until tomorrow (UTC). Raise MAX_VISIT_ALERTS_DAY, or set VISIT_ALERTS to "daily" or "off", in worker/wrangler.toml.` });
      }
      return;
    }
    await d.mail({ to: env.ADMIN_EMAIL, ...visitEmail({ ms: now, tz: tzOf(env), v: describeVisit(request), cap }) });
  } catch (e) {
    console.error("visit alert failed:", e && e.message);
  }
}
