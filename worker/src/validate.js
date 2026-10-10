// Validation of registration forms. A port of the rules from the registry's original (GitHub-based) intake:
// all submitted text is untrusted data. It is normalised, stripped of invisible/control characters, length-limited
// and validated here, and only ever shown after HTML escaping.

// Invisible "filler" characters that render as blank but are not whitespace.
const FILLERS = new Set(["\u3164", "\u2800", "\u115F", "\u1160", "\uFFA0", "\u034F", "\u17B4", "\u17B5"]);
const KEEP_FORMAT = new Set(["\u200C", "\u200D"]); // ZWNJ / ZWJ are needed by some scripts and emoji

export function stripUnsafe(s, keepNewlines) {
  let out = "";
  for (const ch of s.normalize("NFC")) {
    if ((ch === "\n" || ch === "\t") && keepNewlines) { out += ch; continue; }
    if (/^[\p{Cc}\p{Cs}\p{Co}]$/u.test(ch) || FILLERS.has(ch)) { out += ch === "\n" || ch === "\t" ? " " : ""; continue; }
    if (/^\p{Cf}$/u.test(ch) && !KEEP_FORMAT.has(ch)) continue;
    out += ch;
  }
  return out;
}

export function clean(s, multiline = false) {
  s = stripUnsafe(String(s ?? ""), multiline);
  if (multiline) return s.replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return s.replace(/\s+/g, " ").trim();
}

const hasLetters = (s) => /[\p{L}\p{N}]/u.test(s);
export const keyOf = (s) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
// A search/duplicate key: lower-case letters and digits separated by single spaces.
export const wordsKey = (s) => keyOf(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function normalizeIsbn(raw) {
  let s = String(raw ?? "").replace(/^\s*ISBN(?:-?1[03])?\s*:?/i, "");
  s = s.replace(/[\s\-\u2010-\u2015\u2212]/g, "").toUpperCase();
  if (/^[0-9]{9}[0-9X]$/.test(s)) {
    let total = 0;
    for (let i = 0; i < 10; i++) total += (10 - i) * (s[i] === "X" ? 10 : Number(s[i]));
    if (total % 11) return null;
    const core = "978" + s.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
    return core + String((10 - (sum % 10)) % 10);
  }
  if (/^97[89][0-9]{10}$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 13; i++) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
    return sum % 10 === 0 ? s : null;
  }
  return null;
}

// A public http(s) address: a named host (never an IP address in any spelling), standard ports, no credentials.
export function validUrl(url) {
  if (!url || url.length > 300 || /[\s<>"'\\`]/.test(url)) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password || (u.port && u.port !== "80" && u.port !== "443")) return false;
  const host = u.hostname.toLowerCase();
  // dot-separated ASCII labels ending in an alphabetic TLD. This rules out IP addresses in every spelling browsers
  // accept (127.1, 0x7f.0.0.1, 0177.0.0.1, 2130706433), trailing-dot tricks and bare local names.
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(host)) return false;
  return !(host === "localhost" || /\.(localhost|local|internal|test|invalid|example)$/.test(host));
}

export function normalizeEmail(raw) {
  const s = clean(raw).toLowerCase();
  if (!s || s.length > 254) return null;
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s)) return null;
  return s.split("@")[0].length <= 64 ? s : null;
}

const own = (obj, key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key);

/**
 * input: {title, subtitle, author, role, isbn, year, edition, formats: [], url, label, statement, ai_tools,
 *         cover, interior_art, narration, translation, attest: []}   (all strings / arrays of strings)
 * data:  the labels data from dist/_app/data.json
 * Returns {errors: string[], doc: {work, label, statement, components, ai_tools, role}}.
 */
export function validateDeclaration(input, data, today) {
  const errs = [];
  const g = (k) => String(input[k] ?? "");
  const title = clean(g("title")), subtitle = clean(g("subtitle"));
  const author = clean(g("author")), edition = clean(g("edition"));
  if (!title) errs.push("The title is required.");
  else if (!hasLetters(title)) errs.push("The title must contain letters or numbers.");
  if (title.length > 200) errs.push("The title is longer than 200 characters.");
  if (subtitle.length > 200) errs.push("The subtitle is longer than 200 characters.");
  if (!author) errs.push("The author name is required.");
  else if (!hasLetters(author)) errs.push("The author name must contain letters.");
  if (author.length > 150) errs.push("The author name is longer than 150 characters.");
  if (edition.length > 80) errs.push("The edition is longer than 80 characters.");

  const roleKey = clean(g("role"));
  const role = own(data.roles, roleKey) ? roleKey : null;
  if (!role) errs.push("Choose your role in relation to this work.");

  const yearText = clean(g("year"));
  const ym = /^[0-9]{4}$/.test(yearText);
  const year = ym ? Number(yearText) : 0;
  const maxYear = Number(today.slice(0, 4)) + 1;
  if (!ym || year < 1900 || year > maxYear) errs.push(`The year must be a four-digit year between 1900 and ${maxYear}.`);

  const isbnRaw = clean(g("isbn"));
  const isbn = isbnRaw ? normalizeIsbn(isbnRaw) : null;
  if (isbnRaw && !isbn) errs.push("The ISBN is not a valid ISBN-10 or ISBN-13 (check the digits, or leave it blank).");

  const url = clean(g("url"));
  if (url && !validUrl(url)) errs.push("The link must be an http:// or https:// address on a public website (no spaces, logins or IP addresses).");

  const labelKey = clean(g("label"));
  const label = own(data.labels, labelKey) ? labelKey : null;
  if (!label) errs.push("Choose one of the three labels.");

  const statement = clean(g("statement"), true);
  if (statement.length < 20) errs.push("The statement must be at least 20 characters.");
  else if (statement.split(/\s+/).length > 200 || statement.length > 2000) errs.push("The statement must be 200 words or fewer.");
  else if (!hasLetters(statement)) errs.push("The statement must contain words.");

  const tools = g("ai_tools").split("\n").map((t) => clean(t)).filter(Boolean);
  if (tools.length > 10) errs.push("List at most 10 AI tools.");
  if (tools.some((t) => t.split(/\s+/).length > 200)) errs.push("Each AI tool line must be 200 words or fewer.");
  else if (tools.some((t) => t.length > 2000) || g("ai_tools").length > 6000) errs.push("The AI tools section is too long. Shorten it.");

  const components = [];
  for (const part of Object.keys(data.parts)) {
    const use = clean(g(part));
    if (!own(data.ai_use, use)) errs.push(`Choose an option for: ${data.parts[part]}.`);
    else if (use !== "na") components.push({ part, ai_use: use });
  }
  if (label === "human-authored" && components.some((c) => c.part === "translation" && c.ai_use !== "none")) {
    errs.push("A text declared Human Authored cannot have an AI-assisted or AI-generated translation. Choose another label, or declare the translation as human-made.");
  }
  const aiUsed = (label !== null && label !== "human-authored") || components.some((c) => c.ai_use === "assisted" || c.ai_use === "generated");
  if (aiUsed && tools.length === 0) errs.push("List the AI tools used (one per line), since AI was used in this work.");

  const given = new Set(Array.isArray(input.attest) ? input.attest : []);
  if (!Object.keys(data.attestations).every((k) => given.has(k))) errs.push("All four confirmations must be ticked.");

  const wanted = new Set(Array.isArray(input.formats) ? input.formats : []);
  const formats = Object.keys(data.formats).filter((k) => wanted.has(k));
  const work = { title, author, year };
  if (subtitle) work.subtitle = subtitle;
  if (isbn) work.isbn = isbn;
  if (edition) work.edition = edition;
  if (formats.length) work.formats = formats;
  if (url) work.url = url;
  return { errors: errs, doc: { work, label, statement, components, ai_tools: tools, role } };
}

// What a text search can match: title, subtitle and author only. The ISBN is looked up exactly, never by fragments.
export const searchKey = (w) => wordsKey([w.title, w.subtitle, w.author].filter(Boolean).join(" "));

// For rate-limit keys only: name+tag@example.com and name@example.com count as one mailbox.
export const canonEmail = (email) => email.replace(/\+[^@]*@/, "@");
export const workKey = (w) => [keyOf(w.title), keyOf(w.author), w.year, keyOf(w.edition || "")].join("|");
