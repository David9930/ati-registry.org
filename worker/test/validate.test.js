import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot, buildDist, GOOD } from "./helpers.js";
import { clean, normalizeIsbn, validUrl, validateDeclaration, normalizeEmail } from "../src/validate.js";

const data = JSON.parse(readFileSync(path.join(buildDist(), "_app/data.json"), "utf8"));
const TODAY = "2026-10-08";
const run = (over = {}) => validateDeclaration({ ...GOOD, ...over }, data, TODAY);

test("a valid declaration produces a clean document", () => {
  const { errors, doc } = run();
  assert.deepEqual(errors, []);
  assert.equal(doc.work.isbn, "9780306406157");
  assert.equal(doc.label, "ai-master-edited");
  assert.deepEqual(doc.components, [{ part: "cover", ai_use: "generated" }]);
  assert.deepEqual(doc.work.formats, ["ebook"]);
  assert.equal(doc.role, "author");
});

test("every problem is listed", () => {
  const { errors } = run({ title: "", year: "20", isbn: "123", statement: "x", attest: [], label: "", role: "" });
  const all = errors.join("\n");
  for (const frag of ["title is required", "four-digit year", "ISBN", "at least 20 characters", "confirmations", "three labels", "role"]) {
    assert.ok(all.includes(frag), frag + "\n" + all);
  }
});

test("AI tools are required whenever AI was used", () => {
  assert.ok(run({ ai_tools: "" }).errors.some((e) => e.includes("AI tools")));
  assert.deepEqual(run({ label: "human-authored", ai_tools: "", cover: "none" }).errors, []);
  assert.ok(run({ label: "human-authored", ai_tools: "" }).errors.length > 0); // the generated cover still needs a tool
});

test("Human Authored cannot have an AI translation", () => {
  for (const use of ["assisted", "generated"]) {
    const { errors } = run({ label: "human-authored", translation: use, cover: "none" });
    assert.ok(errors.some((e) => e.includes("translation")), use);
  }
  assert.deepEqual(run({ label: "human-authored", translation: "none", cover: "none", ai_tools: "" }).errors, []);
});

test("keys that are not options are rejected, including prototype names", () => {
  for (const bad of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.ok(run({ role: bad }).errors.some((e) => e.includes("role")), bad);
    assert.ok(run({ label: bad }).errors.some((e) => e.includes("labels")), bad);
    assert.ok(run({ cover: bad }).errors.some((e) => e.includes("Cover")), bad);
  }
});

test("hostile text is stored as data, with invisible and control characters removed", () => {
  const { errors, doc } = run({ title: "<script>alert(1)</script>", author: "x‮​evil" });
  assert.deepEqual(errors, []);
  assert.equal(doc.work.title, "<script>alert(1)</script>");
  assert.ok(!doc.work.author.includes("‮"));
  assert.equal(doc.work.author, "xevil");
});

test("unicode hardening", () => {
  for (const title of ["ㅤㅤ", "⠀", "​​", "!!!"]) assert.ok(run({ title }).errors.length > 0, JSON.stringify(title));
  assert.ok(run({ year: "２０２６" }).errors.length > 0); // fullwidth digits
  const { errors, doc } = run({ title: "Café \ud800 ‮evil⁦", author: "A  Writer" });
  assert.deepEqual(errors, []);
  assert.equal(doc.work.title, "Café evil"); // NFC; surrogate and bidi controls removed
  assert.equal(doc.work.author, "A Writer");
  assert.doesNotThrow(() => new TextEncoder().encode(doc.work.title));
});

test("year must be four ASCII digits within range", () => {
  for (const y of ["1899", "2028", "abcd", "202", "20266"]) assert.ok(run({ year: y }).errors.length > 0, y);
  assert.deepEqual(run({ year: "2027" }).errors, []);
});

test("length limits", () => {
  assert.ok(run({ title: "x".repeat(201) }).errors.some((e) => e.includes("200")));
  assert.ok(run({ author: "x".repeat(151) }).errors.some((e) => e.includes("150")));
  const words = (n) => Array.from({ length: n }, () => "word").join(" ");
  assert.deepEqual(run({ statement: words(200) }).errors, []); // 200 words is about 1,000 characters
  assert.ok(run({ statement: words(201) }).errors.some((e) => e.includes("200 words")));
  assert.ok(run({ statement: "x".repeat(2001) }).errors.some((e) => e.includes("200 words"))); // one huge token is still capped
  assert.ok(run({ ai_tools: Array.from({ length: 11 }, (_, i) => "tool " + i).join("\n") }).errors.some((e) => e.includes("at most 10")));
});

test("each AI tool line is limited by words (200), not characters", () => {
  const words = (n) => Array.from({ length: n }, () => "word").join(" ");
  assert.deepEqual(run({ ai_tools: "Claude, Anthropic: " + words(197) }).errors, []); // about 1,000 characters, 200 words
  assert.ok(run({ ai_tools: "Claude, Anthropic: " + words(200) }).errors.some((e) => e.includes("200 words")));
  assert.ok(run({ ai_tools: "x".repeat(2001) }).errors.some((e) => e.includes("too long"))); // one enormous "word" is still capped
  assert.ok(run({ ai_tools: Array.from({ length: 10 }, () => words(150)).join("\n") }).errors.some((e) => e.includes("too long")));
});

test("isbn forms", () => {
  assert.equal(normalizeIsbn("978-1-7386519-5-5"), "9781738651955");
  assert.equal(normalizeIsbn("0-306-40615-2"), "9780306406157");
  for (const raw of ["ISBN 978-0-306-40615-7", "ISBN-13: 978‑0‑306‑40615‑7", "0306406152"]) assert.equal(normalizeIsbn(raw), "9780306406157", raw);
  for (const bad of ["9781738651950", "0-306-40615-X", "abc", ""]) assert.equal(normalizeIsbn(bad), null, bad);
});

test("url hardening", () => {
  for (const bad of ["javascript:alert(1)", "https://user:pw@example.com/", "http://127.0.0.1/x", "https://[::1]/", "https://localhost/", "https://intranet/",
    "https://example.com:8443/", "https://example.com/a b", "ftp://example.com/", "https://127.1/", "https://0x7f.0.0.1/", "https://0177.0.0.1/",
    "https://localhost./", "https://2130706433/", "https://example.com./", "https://a.test/", "https://foo.local/", "https://good.com\\@evil.com/", "data:text/html,x"]) {
    assert.equal(validUrl(bad), false, bad);
  }
  for (const ok of ["https://example.com/book?a=1&b=2", "https://www.example.co.uk/a?b=c#d", "http://example.com:80/", "https://xn--bcher-kva.example.org/"]) assert.equal(validUrl(ok), true, ok);
});

test("email addresses", () => {
  assert.equal(normalizeEmail(" Author@Example.COM "), "author@example.com");
  for (const bad of ["", "a", "a@b", "a@b.c", "a b@example.com", "a@example.com\nBcc: x@y.com", "<a@example.com>", "a@@example.com", ".a@example.com", "a..b@example.com", "a@-example.com", `${"x".repeat(65)}@example.com`]) {
    assert.equal(normalizeEmail(bad), null, JSON.stringify(bad));
  }
});

test("clean() keeps paragraph breaks in multiline text only", () => {
  assert.equal(clean("a\n\n\n\nb", true), "a\n\nb");
  assert.equal(clean("a\n b\t c"), "a b c");
});
