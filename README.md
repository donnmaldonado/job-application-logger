# job-application-logger

Keeping track of a job search means keeping a spreadsheet: where you applied,
what came back, what is still open. Maintaining one by hand is its own small
job — every application typed twice, once into the employer's form and again
into your own sheet, then every rejection and interview invite typed in on top
of that. It is tedious enough that it stops getting done, and a tracker you
stopped updating tells you nothing.

The mail already contains all of it — the confirmations, the rejections, the
interview invites. This tool keeps the spreadsheet and drops the typing. It is
a batch job you run when you are done applying for the day, not a service
watching your inbox, and what it produces is an ordinary Google Sheet you can
open, sort and read to see the whole pipeline at a glance.

One command a day: pull the job-application email that arrived since yesterday,
judge it, print a table, and — only after you approve — write it into your
tracking spreadsheet and label the mail so it never comes back.

1. `bin/read-sheet.js` reads the applications already in the sheet.
2. `bin/fetch.js` pulls the Gmail from the last N days that hasn't been logged yet.
3. Claude, in-session, classifies each message and cross-checks it against the sheet.
4. You approve the table. `bin/commit.js` writes the rows, then labels the mail.

- **Node 22+, ESM, no build step.** One dependency: `googleapis`.
- **No LLM API calls in this repo.** The judging happens in the Claude Code
  session that runs the skill — no API key here, no inference bill.
- **Never autonomous.** Nothing reaches the spreadsheet without you approving it
  in the terminal. No cron, no triggers, no webhooks; you run it.
- **Email is a floor, not the whole truth.** Plenty of employers never send a
  confirmation, and those applications will never appear.
- **Run against one real account.** The daily loop — OAuth, Gmail search and
  labeling, sheet read, append and update — works end to end on the author's
  mailbox and spreadsheet. A few paths still have not run; see
  [What is tested, and what is not](#what-is-tested-and-what-is-not).

## Prerequisites

- **Node 22 or newer** (`node --version`) — the tool uses `--env-file`,
  `parseArgs` and `process.loadEnvFile`.
- **A Google Cloud project** with the Gmail and Sheets APIs enabled and a
  Desktop OAuth client ([step 2](#2-create-a-google-cloud-project)).
- **A tracking spreadsheet** whose header row contains `Updated`, `Role` and
  `Company`.

## Quick start

### 1. Install

```bash
git clone <this repo> job-application-logger
cd job-application-logger
npm install
```

### 2. Create a Google Cloud project

One time, about five minutes. See [Scopes and secrets](#scopes-and-secrets) for
what you are granting.

1. At [console.cloud.google.com](https://console.cloud.google.com), create a
   project (or pick an existing one).
2. **APIs & Services → Library**: enable the **Gmail API** and the
   **Google Sheets API**.
3. **APIs & Services → OAuth consent screen**: choose **External**, fill in the
   required fields, and add your own Google account as a **test user**. The app
   stays unverified, which is expected for single-user use — proceed through the
   "this app isn't verified" warning during consent.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID →
   Desktop app**. Download the JSON.
5. Move it **outside the repository**:

   ```bash
   mkdir -p ~/.config/job-application-logger
   chmod 700 ~/.config/job-application-logger
   mv ~/Downloads/client_secret_*.json ~/.config/job-application-logger/credentials.json
   ```

   `.gitignore` would catch the common filenames, but a secret that is not in
   the working tree cannot be committed at all, and that is the property worth
   having.

### 3. Configure

```bash
cp .env.example .env
```

`SHEET_ID` is the only required variable — the part of your spreadsheet URL
between `/d/` and `/edit`:

```
https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit
```

Everything else has a default:

| Variable | Default | What it does |
|---|---|---|
| `SHEET_ID` | *(required)* | The spreadsheet to read and write. |
| `SHEET_TAB_NAME` | `Sheet1` | Tab to use. `npm run doctor` lists the tabs. |
| `GOOGLE_CREDENTIALS_PATH` | `~/.config/job-application-logger/credentials.json` | The OAuth client JSON from step 2. |
| `GOOGLE_TOKEN_PATH` | `~/.config/job-application-logger/token.json` | Where the refresh token is cached, mode `0600`. |
| `GMAIL_LOOKBACK` | `2d` | Window used when `--since` is not passed. |
| `GMAIL_PROCESSED_LABEL` | `logged-to-sheet` | The label that *is* the deduplication state. |
| `GMAIL_QUERY_EXTRA` | *(empty)* | Extra Gmail search terms ANDed onto the query. |
| `MAX_MESSAGES` | `50` | Cap on messages pulled per run. |
| `MAX_BODY_CHARS` | `2000` | Body characters passed downstream, then truncated. |
| `TIMEZONE` | `America/New_York` | IANA zone used to format `M/D` dates. |

Both path variables expand a leading `~`; a relative path resolves against the
directory you run from. Keep them pointing outside the repo.

### 4. Authenticate and check the sheet

```bash
npm run doctor
```

Opens a browser once, writes the token to `GOOGLE_TOKEN_PATH`, then prints your
spreadsheet's tabs, the detected header row and the columns it found. If
`SHEET_TAB_NAME` doesn't name a real tab, it prints the list and stops. It needs
a `.env` in the current directory, so do step 3 first.

### 5. Add the three tracking columns

```bash
npm run doctor -- --migrate
```

Appends `Status`, `Last Heard` and `Source` to the right of your existing
columns and backfills `applied` / `manual` into the rows already there. It is
additive by construction: nothing existing is reordered, renamed or rewritten, a
second run is a no-op, and it refuses to run if those positions are already
headed or already hold data.

Run `npm run doctor` without `--migrate` first — it prints the same plan as a
warning without applying it. Read the plan before you say yes: the migration
rewrites your header row, and it is the one write with no undo.

## Daily use

In Claude Code, from this directory:

```
/log-applications 2d
```

The skill in `.claude/skills/log-applications/` reads the sheet, fetches recent
mail, classifies each message, prints a table, waits for your approval, then
commits.

The Gmail label (`logged-to-sheet` by default) *is* the deduplication state —
every fetch subtracts it: `newer_than:2d -label:logged-to-sheet`. `commit.js`
owns both the sheet write and the label on purpose, because the invariant the
system rests on is that **a message carries the label if and only if its content
reached the sheet**. Split across two commands they drift: a write without a
label duplicates the row tomorrow, a label without a write loses the application
silently. One command fixes the ordering — write, then label, then report any
partial failure in `unlabeled`.

### Commands

You can also drive them by hand:

```bash
npm run sheet                      # existing rows, with sheet row numbers
npm run fetch -- --since 2d        # candidate messages as JSON
echo '<payload>' | npm run commit -- --dry-run
echo '<payload>' | npm run commit
```

| Command | Flags |
|---|---|
| `bin/doctor.js` | `--migrate` |
| `bin/fetch.js` | `--since <2d>`, `--max <n>`, `--query-extra <terms>`, `--pretty` |
| `bin/read-sheet.js` | `--tab <name>`, `--pretty` |
| `bin/commit.js` | `--dry-run`, `--tab <name>`, `--pretty` |

Every command also takes `--help` and `--fixture <path>`
([offline mode](#offline-mode)).

- `--since` takes Gmail duration syntax (`2d`, `12h`, `3w`, `1m`, `1y`);
  anything else is rejected before a request is made.
- `--max` and `--tab` override `MAX_MESSAGES` and `SHEET_TAB_NAME` for one run.
- `--dry-run` prints the exact rows, cell ranges and message ids it would touch
  under a `plan` key, with `"dryRun": true`. It reads the sheet to resolve those
  ranges and writes nothing anywhere.

## The sheet

| Col | Header | Contents |
|---|---|---|
| A | `Updated` | Date applied, `M/D` |
| B | `Role` | |
| C | `Company` | |
| D | `Status` | `applied` / `confirmed` / `rejected` / `interview` |
| E | `Last Heard` | `M/D` of the most recent email about this application |
| F | `Source` | `manual` / `auto` |

The header row is **not** assumed to be row 1. The tools scan the first ten rows
for one containing `Updated`, `Role` and `Company`; data starts on the row after
it. The letters above are the usual result, not an assumption — every column is
addressed by where its header actually is, so inserting or deleting a column
moves the tools with it.

Columns of your own are fine. If the two columns immediately right of `Company`
are unlabeled, the tools treat them as `Link` and `Notes`: read past, never
written, and `Status` / `Last Heard` / `Source` sit to the right of them
instead. Anything further out is invisible to the tools.

Updates only ever touch the `Status` and `Last Heard` cells of a row. A payload
that tries to set `updated`, `role`, `company`, `link` or `notes` on an update
is rejected outright, so a status change can never overwrite your apply date or
a hand-written note.

## JSON contracts

`fetch.js` and `read-sheet.js` print their shapes on demand — run either with
`--fixture ... --pretty` ([offline mode](#offline-mode)) to see one. The
contract worth writing down is `commit.js`, because it is the one you generate.

Stdin:

```json
{ "appends": [ { "updated": "9/3", "role": "Analytics Engineer", "company": "Northwind Robotics",
                 "link": "", "notes": "", "status": "confirmed", "lastHeard": "9/3",
                 "messageIds": ["..."] } ],
  "updates": [ { "row": 14, "status": "rejected", "lastHeard": "9/3", "messageIds": ["..."] } ],
  "labelOnly": ["..."] }
```

Stdout:

```json
{ "appended": 1, "updated": 1, "labeled": 3, "errors": [], "unlabeled": [] }
```

- An `appends` entry may not set `source`. Appended rows are always `auto`.
- `updates` addresses rows by the 1-indexed `row` that `read-sheet.js` reports,
  and may only carry `status` and `lastHeard`.
- `unlabeled` lists messages whose sheet write succeeded but whose labeling
  failed. They resurface next run and produce duplicates, which is why the skill
  surfaces them instead of swallowing them.
- Exit codes: `0` success, `2` the payload was rejected and nothing was written
  or labeled, `1` something was attempted and part of it failed — read `errors`
  and `unlabeled`.
- `read-sheet.js` reports only the columns the sheet actually has: on an
  unmigrated sheet, `status`, `lastHeard` and `source` are simply absent. It
  never reports `link` or `notes` — those are yours; the tool reads past them
  and never writes them.

## Offline mode

Every command takes `--fixture <path>` and runs with no network and no
credentials, against invented data in `fixtures/`:

```bash
node bin/fetch.js      --fixture fixtures/messages.sample.json --pretty
node bin/read-sheet.js --fixture fixtures/messages.sample.json --pretty
node bin/doctor.js     --fixture fixtures/sheet.legacy.json
echo '{"labelOnly":["fixture0000000005"]}' | node bin/commit.js --fixture fixtures/messages.sample.json --pretty
```

A fixture run of `commit.js` is always a dry run — it has nothing to write with
— and says so with `"dryRun": true`. The test suite is the same mechanism over
the same fixtures:

```bash
npm test
```

## What is tested, and what is not

`npm test` is 89 tests over fixtures. **They cover no network call** — the
network paths are covered by having actually been run, not by the suite.

**Covered** (`node:test`, fixtures only, no credentials):

- MIME body extraction — base64url, multipart preference for `text/plain`, HTML
  fallback and entity decoding, nested parts, attachments skipped, truncation.
- Query construction, including the `-label:` term deduplication depends on, and
  `--since` duration validation.
- Header-row detection, column mapping, 1-indexed row numbers, and the exact
  JSON and exit codes of all three commands in `--fixture` mode.
- Commit payload validation: the closed status set, the refusal of `?`, the
  refusal to write anything but `status` and `lastHeard` on an update,
  unknown fields, bad rows.
- The write-then-label ordering and its partial-failure reporting, against an
  injected fake API.
- The migration *plan*: what `--migrate` would write, that a second run is a
  no-op, and that it refuses a column already in use.
- Config resolution: defaults, `~` expansion, validation errors, mode `0600`.

**Exercised against Google, but not by the suite** (one account, real
mailbox and spreadsheet, across several days of ordinary use):

- OAuth consent, the loopback redirect, the code exchange, and refreshing a
  stored token on later runs.
- Gmail search, message fetch, creating the `logged-to-sheet` label, and
  applying it with `batchModify`.
- Sheets read, append, and `batchUpdate` on an existing row.
- The `doctor --migrate` write that appends the `Status`, `Last Heard` and
  `Source` columns to a sheet that predates them.
- End-to-end idempotency: messages labeled on one day's run do not come back
  in the next day's sweep.

**Still never executed against Google — code-reviewed only:**

- The stale-token (`invalid_grant`) recovery path — no token has expired yet.
- `explainApiError` — pattern-matching against Google error strings nobody has
  seen come back yet.
- Partial-failure reporting: a run where the sheet write lands and the labeling
  does not, leaving `unlabeled` non-empty.

So: the daily path is proven on one setup, and the failure paths are not. Use
`--dry-run` when a payload is large, and start with a small `--since` window.

## Scopes and secrets

You grant exactly two scopes:

| Scope | What it permits |
|---|---|
| `gmail.modify` | Read any message in your mailbox, including full bodies, and add or remove labels. It can move mail to Trash; it **cannot** permanently delete it. |
| `spreadsheets` | Read and write **any** spreadsheet in your Drive, not only the one you configure. Google offers no narrower per-file scope for the Sheets API. |

Read access is broader than "the emails this tool cares about" because Gmail has
no scope for "only messages matching this query". `gmail.modify` is the
narrowest scope that can both read a body and apply a label, and the label is
what makes repeat runs idempotent. Both are the usual
`https://www.googleapis.com/auth/…` forms, requested in `src/auth.js`.

Everything runs locally, as you; nothing is sent anywhere except to Google's
APIs. The OAuth client and refresh token live in
`~/.config/job-application-logger/`, **outside this repository**, so no
credential sits where `git add -A` can reach it; the token file is written mode
`0600`. Revoke access any time at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

Nothing in this repository is real: the fixtures are invented companies and
`example.com` senders, there is no spreadsheet ID anywhere, and no message from
an actual mailbox is checked in. `.gitignore` refuses `.env`, `.env.*` (except
`.env.example`), `credentials.json`, `token.json`, `client_secret*.json` and
`*.local.json`. `npm test` re-checks those patterns on every run, along with two
shapes that leaked before: an email address outside `example.com` /
`example.org`, and an absolute path into a home directory.

## Layout

```
.claude/skills/log-applications/SKILL.md   the orchestration and the judgment
bin/doctor.js       verify config, auth and sheet shape; list tabs; --migrate
bin/fetch.js        Gmail  -> JSON on stdout
bin/read-sheet.js   Sheets -> JSON on stdout
bin/commit.js       JSON on stdin -> sheet write, then Gmail label
src/auth.js         OAuth flow, token cache, client construction
src/config.js       env loading and validation, the only reader of process.env
src/gmail.js        search, MIME body extraction, labeling
src/sheets.js       header detection, read, append, update, migration plan
src/schema.js       commit payload validation
src/fixture.js      offline input for --fixture
fixtures/           invented messages and sheet states
test/               node:test, no framework
```

## License

MIT. See [LICENSE](LICENSE).
