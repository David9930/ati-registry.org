// Small shared helpers: hashing, tokens, escaping, dates.
const enc = new TextEncoder();

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(text) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

// Keyed hash: the same input hashes differently without the secret, so stored hashes cannot be reversed by guessing.
export async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}

export function randomToken(bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Crockford base32 (no I, L, O, U): easy to read aloud and to copy. 32 symbols divide 256, so masking is unbiased.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function randomSuffix(n = 4) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => ALPHABET[b & 31]).join("");
}

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

export const ID_RE = /^ATI-([0-9]{4})-([0-9]{6})-([0-9A-HJKMNP-TV-Z]{4})$/;

// Per-visitor limits key on the network, not the single address: an IPv6 visitor controls a whole /64.
// The hidden trap field. Not a name that password managers or browsers autofill ("website", "url", "email" ...).
export const HONEYPOT = "ati_trap";

export function ipKey(ip) {
  const s = String(ip || "unknown").toLowerCase();
  if (!s.includes(":")) return s;
  const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return mapped[1];
  const [head, tail] = s.split("::");
  const left = head ? head.split(":") : [], right = tail ? tail.split(":") : [];
  const fill = s.includes("::") ? Array(Math.max(0, 8 - left.length - right.length)).fill("0") : [];
  return [...left, ...fill, ...right].slice(0, 4).map((g) => g.padStart(4, "0")).join(":");
}

export function intVar(env, name, fallback) {
  const n = Number.parseInt(env[name], 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Reads a small urlencoded/multipart form. Returns {one, many} (null-prototype maps) or {error: status}. */
export async function readForm(request, max = 40000) {
  const type = request.headers.get("content-type") || "";
  if (!/^(application\/x-www-form-urlencoded|multipart\/form-data)/i.test(type)) return { error: 415 };
  const len = Number(request.headers.get("content-length"));
  if (!Number.isFinite(len) || request.headers.get("content-length") === null) return { error: 411 };
  if (len > max) return { error: 413 };
  let fd;
  try { fd = await request.formData(); } catch { return { error: 400 }; }
  const one = Object.create(null), many = Object.create(null);
  for (const [k, v] of fd.entries()) {
    if (typeof v !== "string") continue;
    (many[k] ||= []).push(v);
    if (!(k in one)) one[k] = v;
  }
  return { one, many };
}
