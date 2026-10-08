// Visit alerts: an email to the maintainer for each public page view, with time, country, region, page and a coarse
// visitor type. The IP address, the user-agent text, query strings and private links never go into the email or the
// database. Off unless VISIT_ALERTS = "all" and ADMIN_EMAIL is set; capped per day so a crawler cannot flood the inbox.
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

export function visitorKind(userAgent) {
  const ua = String(userAgent || "");
  if (!ua) return "No user agent (a script)";
  for (const [re, label] of KINDS) if (re.test(ua)) return label;
  return "Browser (probably a person)";
}

function countryName(code) {
  if (!code || code === "XX") return "unknown country";
  if (code === "T1") return "Tor network";
  try { return new Intl.DisplayNames(["en"], { type: "region" }).of(code) || code; } catch { return code; }
}

function when(ms, tz) {
  const utc = new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  try {
    const local = new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(ms);
    return `${local} (${tz})  =  ${utc}`;
  } catch {
    return utc;
  }
}

export function visitEmail({ ms, tz, country, region, path, kind, cap }) {
  const place = [region, country].filter(Boolean).join(", ");
  return {
    subject: `[ATI] Visit from ${place} · ${kind}`,
    text: `Someone opened a page on ati-registry.org.\n\nWhen:     ${when(ms, tz)}\nFrom:     ${place}\nPage:     ${path}\nVisitor:  ${kind}\n\n` +
          `The place is the visitor's approximate location from Cloudflare, and the visitor type is read from the browser's own label, which can be faked. ` +
          `No IP address is recorded or included. At most ${cap} of these are sent a day; set VISIT_ALERTS to "off" to stop them.`,
  };
}

/** True for a public HTML page that was served successfully. */
export function isPageView(request, response) {
  if (request.method !== "GET" || response.status !== 200) return false;
  if (!/^text\/html/i.test(response.headers.get("content-type") || "")) return false;
  return !PRIVATE_PATH.test(new URL(request.url).pathname.replace(/\/+$/, "") || "/");
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
          text: `${cap} visit alerts have been sent today, so no more will be sent until tomorrow (UTC). Raise MAX_VISIT_ALERTS_DAY, or set VISIT_ALERTS to "off", in worker/wrangler.toml.` });
      }
      return;
    }
    const cf = request.cf || {};
    const path = new URL(request.url).pathname.replace(/[^\x21-\x7e]/g, "").slice(0, 120) || "/";
    await d.mail({ to: env.ADMIN_EMAIL, ...visitEmail({
      ms: now, tz: env.VISIT_TZ || "America/New_York", country: countryName(cf.country), region: cf.region || "", path,
      kind: visitorKind(request.headers.get("user-agent")), cap,
    }) });
  } catch (e) {
    console.error("visit alert failed:", e && e.message);
  }
}
