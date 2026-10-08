# ATI Registry

The **Authorship Transparency Identifier**: a free registry where authors and publishers publicly self-declare how AI was
(or was not) used in a book, with three labels: Human Authored (HA), AI Master Edited (AME) and AI Co-Authored (ACA).
Self-declared and not verified; a transparency record, not a certification.

Site: <https://ati-registry.org> &middot; Definitions and marks: CC BY 4.0 &middot; Code: MIT (see `LICENSE-CONTENT.md`)

## How it is built

Everything runs on Cloudflare: one Worker serves the static site and the registry's dynamic routes, with a private D1 (SQLite)
database. No server to maintain.

```
ati/            Python site generator: templates + content -> dist/ (static pages, marks, and the files the Worker reuses)
content/        site text (Markdown), including the Terms, Privacy and Register pages
templates/      Jinja templates;  static/  CSS, fonts and the mark kit
worker/src/     the Worker: index.js (routes), validate.js, render.js, db.js, mail.js, admin.js, util.js
worker/migrations/   D1 schema
worker/test/    Worker tests (node:test, with a SQLite stand-in for D1)
tests/          Python tests for the site generator
schema/         JSON Schema of a record (the stored public document), also used by the tests
```

Flow: the author fills in the form (`/register`, bot check by Cloudflare Turnstile) and the Worker validates it, stores it as
*pending*, and emails a confirmation link. Opening the link and pressing the button creates the record and assigns an ID
(`ATI-YYYY-NNNNNN-XXXX`: a sequence number plus a random suffix), and shows a private management link for correcting or
withdrawing it. Records are public one at a time at `/r/<id>`; they are found by ID, ISBN or a short title/author search.
There is no bulk listing, and per-visitor daily limits (hashed, never raw IPs) slow down automated copying.
Emails are held privately. The registry can later publish everything as open data (the Terms allow it).

The maintainer's page (`/admin`) is behind a Cloudflare Access application *and* verifies the Access token itself, for one
address (`ADMIN_EMAIL`). It handles reports, disputes, withdrawals and removals (a removal blanks the record, keeping its ID,
status, label and dates, and deletes the stored email).

## Develop

```
pip install -r requirements.txt
python -m unittest discover -s tests          # site generator
python -m ati.build --out dist                # build the static site
cd worker && npm ci && npm test               # Worker tests (they build the site first)
```

Local run on Cloudflare's runtime: create `worker/.dev.vars` (never committed) with Turnstile's public test keys and
`MAIL_PROVIDER=log` (messages are printed instead of sent), apply the schema with
`npx wrangler d1 migrations apply DB --local`, then `npx wrangler dev`. Turnstile test keys:
<https://developers.cloudflare.com/turnstile/troubleshooting/testing/>.

## Deploy (Cloudflare)

Connect the repository under Workers &amp; Pages (Workers Builds), with the Worker name `ati-registry-org` (it must match `name` in `wrangler.toml`) and the root directory empty.
Build command: `pip install -r requirements.txt && python -m ati.build --out dist && cd worker && npm ci`;
deploy command: `cd worker && npx wrangler d1 migrations apply DB --remote && npx wrangler deploy`. Then:

1. Create the D1 database `ati-registry` and put its id in `worker/wrangler.toml`.
2. Create a Turnstile widget for `ati-registry.org`; set `TURNSTILE_SITEKEY` in `wrangler.toml` and the **secrets**
   `TURNSTILE_SECRET` and `HASH_SECRET` (a long random string) in the dashboard. Secrets never go in the repository.
3. Email: onboard the domain to Email Sending (Workers Paid plan) and keep `MAIL_PROVIDER = "cloudflare"`, or set
   `MAIL_PROVIDER = "brevo"` with the secret `BREVO_API_KEY`. Set `MAIL_FROM`.
4. Admin: create an Access application for `ati-registry.org/admin*` allowing only your address; set `ACCESS_TEAM_DOMAIN` and
   `ACCESS_AUD` (the application's Audience tag) in `wrangler.toml`, and add your address as the **secret** `ADMIN_EMAIL` in the
   dashboard (not in `wrangler.toml`, which is public). It receives report notices and visit alerts (`VISIT_ALERTS`; see `wrangler.toml`).
5. Add one rate-limiting rule (Security &rarr; WAF) on the burst rate, for example 20 requests per 10 seconds per IP. The Worker
   enforces the daily limits itself (`MAX_*` variables in `wrangler.toml`; visitors are counted per network, an IPv6 /64).
   In the Turnstile widget settings, list only `ati-registry.org` as its hostname; the Worker also checks the hostname
   and the form name on every token.
6. Forward `hello@ati-registry.org` with Email Routing (the address shown on the site), and keep the domain registered at the
   registrar.

`HASH_SECRET` must never change once records exist: it keys the hash that links a registrant's email address to their
records (the "lost link" lookup and the duplicate-work check), so a new value silently breaks both. A missing value makes
searches and record pages fail with an error in the log.

Keep the database backed up: `npx wrangler d1 export ati-registry --remote --output backup.sql` (D1 is plain SQLite, so the
data is portable).

## Maintainer guide

- **Report:** an email arrives; open `/admin`, read it, then mark the record disputed (with a short neutral note), correct,
  withdraw or remove it, and close the report.
- **Removal:** blanks every descriptive field and deletes the stored email, its hash and the private links; the ID is never reused.
- **Notes:** the note on a *dispute* is public (it is shown on the record). Notes on every other action are private and
  appear only in the admin page's private log. Edits by registrants are listed in the public history by field name.
- **Definitions change:** add a new version to `DEFINITIONS_BY_VERSION` in `ati/labels.py` and bump `definitions_version`
  in `config.json`. Existing records keep the version they were declared under.
- **Mark kit:** `python -m ati.makemarks` regenerates the PNGs (needs `pip install playwright` and Chromium).
