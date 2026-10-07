# ATI Registry

The **Authorship Transparency Identifier** registry: a free, open registry where authors and publishers publicly declare
how AI was, or wasn't, used in a book. Self-declared, not verified, not a certification.

Site: <https://ati-registry.org> &middot; Records: CC0 &middot; Definitions and marks: CC BY 4.0 &middot; Code: MIT
(see `LICENSE-CONTENT.md`).

## How it works

Everything is static files in this repository, hosted on GitHub Pages. There is no database and no server.

```
records/ATI-2026-000001.json   one public record per work (the source of truth; git history is the audit trail)
schema/record.schema.json      what a valid record is
content/*.md  templates/*.html  static/   site text, page templates, CSS, fonts, mark kit
ati/                           build.py (site generator), issues.py + intake.py (registration), forms.py, marks.py
.github/ISSUE_TEMPLATE/        generated issue forms: register, withdraw/report
.github/workflows/registry.yml intake (commit records) -> build -> deploy, plus notify (reply to submitters)
tests/                         unittest suite
```

### Registration flow

1. An author opens the **Register a book** issue form (needs a free GitHub account).
2. The `registry` workflow runs on new issues, on pushes to `main`, hourly, and when started by hand.
   The `intake` job (the only one that can write to the repository) runs `python -m ati.intake process`, which reads open
   issues, validates them, assigns the next ID (`ATI-YYYY-NNNNNN`) and writes `records/<id>.json`, then commits and pushes.
3. The `build` job checks out `main`, builds the site (`python -m ati.build --strict`) and the `deploy` job publishes it to Pages.
4. The `notify` job runs only after the records are pushed, and replies on each issue with the ID, labels it and closes it.
   If anything fails earlier, nothing was announced and the next run simply processes the issue again. Processing is
   idempotent per issue number, so a replayed registration or withdrawal repeats its reply instead of acting twice.

Each job has only the token permissions it needs (`permissions: {}` at the top; `contents: write` only on `intake`,
`issues: write` only on `notify`, Pages permissions only on `deploy`). Third-party actions are pinned to commit SHAs;
`.github/dependabot.yml` proposes updates.

Runs are serialized (`concurrency: registry`), so IDs are assigned one at a time. GitHub keeps only one *pending* run
per concurrency group, so the hourly run is a sweep that picks up any issue whose own run was superseded.
Note that GitHub disables scheduled workflows in a repository with no activity for 60 days; any push, including the
registry's own record commits, counts as activity.

Issue text is untrusted. Only the form's own field names count as headings, and a repeated heading rejects the
submission. It is parsed as data, Unicode-normalised (NFC) with control, format, private-use and
invisible-filler characters removed, length-limited, validated against the schema, and only ever rendered through an
auto-escaping template. It is never interpolated into a shell command, and no submitted text is echoed into the bot's
replies.

Held for manual review (label `needs-review`): accounts younger than `min_account_age_days`, more than
`max_registrations_per_account_per_day` records per account per day, more than `max_registrations_per_day_total`
records per day overall, and every report or correction request. A held issue gets one bot comment containing a
fingerprint of the exact text that was held. The `approved` label only counts while the issue text still matches that
fingerprint (comments by anyone other than the bot are ignored), so an author who edits a submission after review gets
a rejection, not the approval. If GitHub's API cannot be reached to check an
account's age, the submission is left untouched and retried on the next run. The registrant is recognised by their
numeric GitHub account id (not just the login, which can be renamed or reused). A declarant states whether they are
the author, publisher or an authorized representative; the registry does not verify this.

## Maintainer guide

- **Approve a held registration:** read the issue as it stands, then add the label `approved`. The next hourly run processes it, or start the workflow by hand (Actions > registry > Run workflow). If the author edited the issue after it was held, the approval is refused and they must submit again.
- **Handle a report or correction:** edit the record JSON in a pull request (add a history event such as `corrected`,
  `disputed`, `dispute resolved` or `removed`, and set `status` and, for disputes, `dispute_note`), merge, then close the
  issue with a short explanation. IDs are never reused or deleted.
- **Withdraw a record on someone's behalf:** add `approved` to their withdrawal request (recorded in history as a maintainer action).
  Withdrawals of `disputed` records also wait for approval. Removed records can never be withdrawn.
- **Remove a record:** run `python -m ati.moderate remove ATI-YYYY-NNNNNN --issue N --note "short reason"` and commit.
  It blanks every descriptive field, sets `status` to `removed` and adds the history event; the site, search and open data
  then show only the ID, status and dates. Then edit or hide the original registration issue and any report that quotes the
  content (the issue text is not touched by the tool). Earlier versions remain in git history and in anyone's CC0 copies;
  say so to the person who asked.
- **Change a definition:** bump `definitions_version` in `config.json`, edit `ati/labels.py` (`DEFINITIONS`), and
  describe the change publicly. Existing records keep the version they were declared under.
- **Edit the issue forms:** change `ati/forms.py`, then run `python -m ati.forms`. A test fails if the committed YAML is stale.
- **Redraw the marks:** edit `ati/marks.py`, then `python -m ati.makemarks` (needs Playwright and Chromium) and commit `static/marks/`.

## Develop

```sh
pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
python -m ati.build --out dist            # then serve dist/ at the site root, e.g. python -m http.server -d dist
                                          # (add --strict to fail on a placeholder repo, as CI does)
```

## Launch checklist

1. Create the repository (ideally under an organisation so it can be transferred later) and push this code.
2. Set `repo` in `config.json` (`owner/name`), and optionally `contact_email` (forward `hello@ati-registry.org` from the registrar).
3. Settings > Pages: source **GitHub Actions**; custom domain `ati-registry.org`; tick **Enforce HTTPS** once the certificate is issued.
4. DNS for `ati-registry.org`: four `A` records for the apex (`185.199.108.153`, `185.199.109.153`, `185.199.110.153`,
   `185.199.111.153`) and a `CNAME` for `www` pointing to `<owner>.github.io`. Point the other domains at the .org with
   registrar redirects.
5. Settings > Actions > General: allow actions to run. The workflow requests its own permissions per job. If you protect `main`, allow the Actions bot to push, or the registry commits will fail.
6. Review the draft pages (terms, privacy, governance, support) and have the terms and privacy pages checked by a lawyer.
7. Seed the first records through the normal registration form, so they have a genuine history.

## Hardening to consider

- Verify the pinned action SHAs against each action's release notes when Dependabot proposes updates.
- Add a security contact (`SECURITY.md`) and enable private vulnerability reporting.
- At several thousand records, replace the single registry table with paged JSON.
