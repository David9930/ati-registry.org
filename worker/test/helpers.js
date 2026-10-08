// Test harness: a D1 stand-in on node:sqlite, a static-assets stand-in over the built site, and a tiny HTTP driver.
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handle } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../..");

let dist;
export function buildDist() {
  if (dist) return dist;
  dist = process.env.ATI_DIST || mkdtempSync(path.join(tmpdir(), "ati-dist-"));
  if (!process.env.ATI_DIST) execFileSync("python3", ["-m", "ati.build", "--out", dist], { cwd: repoRoot, stdio: "pipe" });
  return dist;
}

// Cloudflare D1 refuses LIKE/GLOB patterns longer than 50 bytes; plain SQLite does not. Mimic D1 so a regression shows up here.
const enc = new TextEncoder();
function checkD1Limits(sql, args) {
  if (/\b(LIKE|GLOB)\b/i.test(sql) && args.some((a) => typeof a === "string" && enc.encode(a).length > 50)) throw new Error("D1_ERROR: LIKE or GLOB pattern too complex");
}

class Stmt {
  constructor(sqlite, sql, args = []) { this.sqlite = sqlite; this.sql = sql; this.args = args; }
  bind(...args) { checkD1Limits(this.sql, args); return new Stmt(this.sqlite, this.sql, args); }
  async first(col) { const r = this.sqlite.prepare(this.sql).get(...this.args); return r ? (col ? r[col] : { ...r }) : null; }
  async all() { return { results: this.sqlite.prepare(this.sql).all(...this.args).map((r) => ({ ...r })), success: true, meta: {} }; }
  async run() { const i = this.sqlite.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: i.changes, last_row_id: Number(i.lastInsertRowid) } }; }
}
export class FakeD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    const dir = path.join(repoRoot, "worker/migrations");
    for (const f of readdirSync(dir).sort()) this.sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  }
  prepare(sql) { return new Stmt(this.sqlite, sql); }
  async batch(stmts) {
    this.sqlite.exec("BEGIN");
    try { const out = []; for (const s of stmts) out.push(await s.run()); this.sqlite.exec("COMMIT"); return out; }
    catch (e) { this.sqlite.exec("ROLLBACK"); throw e; }
  }
  q(sql, ...a) { return this.sqlite.prepare(sql).all(...a).map((r) => ({ ...r })); }
}

export function fakeAssets(root) {
  return {
    async fetch(req) {
      const p = new URL(req.url).pathname;
      for (const cand of [p, p.replace(/\/$/, "") + "/index.html"]) {
        const f = path.join(root, cand);
        if (f.startsWith(root) && existsSync(f) && statSync(f).isFile()) {
          const type = f.endsWith(".json") ? "application/json" : f.endsWith(".html") ? "text/html" : "application/octet-stream";
          return new Response(readFileSync(f), { status: 200, headers: { "content-type": type } });
        }
      }
      return new Response(readFileSync(path.join(root, "404.html")), { status: 404, headers: { "content-type": "text/html" } });
    },
  };
}

export const T0 = Date.parse("2026-10-08T12:00:00Z");

export function makeEnv(over = {}) {
  return {
    DB: new FakeD1(), ASSETS: fakeAssets(buildDist()), SITE_ORIGIN: "https://ati-registry.org", TURNSTILE_SITEKEY: "site-key",
    TURNSTILE_SECRET: "turnstile-secret", HASH_SECRET: "hash-secret", MAIL_PROVIDER: "log", MAIL_FROM: "registry@ati-registry.org",
    ADMIN_EMAIL: "admin@example.org", ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud-tag", ...over,
  };
}

export const GOOD = {
  title: "Test Book", subtitle: "", role: "author", author: "A. Writer", isbn: "978-0-306-40615-7", year: "2026", edition: "First Edition",
  formats: ["ebook"], url: "https://example.com/book", label: "ai-master-edited",
  statement: "The story is mine. An AI assistant edited and checked continuity; I approved every change.",
  ai_tools: "Claude, Anthropic (paid plan): editing and continuity checks",
  cover: "generated", interior_art: "na", narration: "na", translation: "na",
  attest: ["accurate", "rights", "self_declared", "terms"], email: "author@example.com",
};

export function encode(fields) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) { if (Array.isArray(v)) v.forEach((x) => p.append(k, x)); else if (v !== undefined) p.append(k, v); }
  return p.toString();
}

/** A driver around handle(): get/post return {res, text, status}. */
export function site(envOver = {}, state = {}) {
  const env = makeEnv(envOver);
  const mails = [], fetches = [];
  const s = {
    env, mails, fetches, now: T0, ip: "203.0.113.7", turnstileOk: true, mailFails: false,
    deps() {
      return {
        now: () => s.now,
        fetch: async (url, init) => {
          fetches.push({ url: String(url), init });
          if (String(url).includes("siteverify")) {
            const action = s.turnstileAction ?? ({ "/register": "register", "/report": "report", "/manage/lost": "lost" }[s.path] || "");
            return new Response(JSON.stringify({ success: s.turnstileOk, hostname: s.turnstileHost ?? "ati-registry.org", action }), { status: 200 });
          }
          if (String(url).includes("/cdn-cgi/access/certs")) return new Response(JSON.stringify({ keys: s.jwks || [] }), { status: 200 });
          return new Response("{}", { status: 200 });
        },
        mail: async (m) => { if (s.mailFails) throw new Error("mail down"); mails.push(m); },
      };
    },
    async req(method, p, { form, headers = {}, origin = true, ip } = {}) {
      const h = new Headers({ "cf-connecting-ip": ip || s.ip, ...headers });
      let body;
      if (form !== undefined) {
        body = typeof form === "string" ? form : encode(form);
        h.set("content-type", "application/x-www-form-urlencoded");
        if (!h.has("content-length")) h.set("content-length", String(new TextEncoder().encode(body).length));
      }
      if (method === "POST" && origin === true) h.set("origin", "https://ati-registry.org");
      else if (typeof origin === "string") h.set("origin", origin);
      s.path = p.split("?")[0];
      const waits = [];
      const res = await handle(new Request("https://ati-registry.org" + p, { method, headers: h, body, redirect: "manual" }), env, { waitUntil: (x) => waits.push(x) }, s.deps());
      s.waits = waits.length;
      await Promise.all(waits); // work deferred until after the response is complete before the test looks at its effects
      const text = res.status === 301 || res.status === 302 || res.status === 303 ? "" : await res.text();
      return { res, text, status: res.status, location: res.headers.get("location") };
    },
    get: (p, o) => s.req("GET", p, o),
    post: (p, form, o = {}) => s.req("POST", p, { form, ...o }),
    /** Registers a book end to end and returns {id, manageUrl, token, ...}. */
    async register(over = {}) {
      const before = mails.length;
      const r = await s.post("/register", { ...GOOD, ...over, "cf-turnstile-response": "ok" });
      if (r.status !== 200) throw new Error("register failed: " + r.status + " " + r.text.replace(/<[^>]+>/g, " ").slice(0, 300));
      const link = mails[before].text.match(/https:\/\/ati-registry\.org\/verify\?t=([A-Za-z0-9_-]{43})/);
      const v = await s.post("/verify", { t: link[1] });
      const id = (v.text.match(/class="record-id">([^<]+)</) || [])[1];
      const manage = (v.text.match(/href="\/manage\/([A-Za-z0-9_-]{43})"/) || [])[1];
      return { id, token: manage, verifyToken: link[1], verify: v };
    },
  };
  return s;
}
