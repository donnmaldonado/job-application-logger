# job-application-logger

Once a day, one command: pull the job-application email that arrived since
yesterday, judge it, show you a table, and - only after you approve - write it
into your tracking spreadsheet and label the messages so they never come back.

It exists because a job seeker applying to 5-10 roles a day already receives
every fact they are retyping. The confirmations, rejections and interview
invites are sitting in Gmail.

- **Node 22+, ESM, no build step.**
- **One dependency:** `googleapis`. Everything else is a Node built-in.
- **No LLM API calls in this repo.** The judging happens in the Claude Code
  session that runs the skill. There is no API key here and no inference bill.
- **Status: unproven against the live APIs.** Everything offline is covered by
  89 tests; not one line of the Gmail, Sheets or OAuth code has ever run
  against Google. Read
  [What is tested, and what is not](#what-is-tested-and-what-is-not) before you
  trust it with a spreadsheet you care about.

## What this is not

**It is not autonomous.** Nothing reaches your spreadsheet without you
approving it in the terminal first. That is a deliberate design choice, not a
missing feature: ATS email is inconsistent enough that extraction will
sometimes be wrong, and a human glance at a table is cheaper and more reliable
than engineering the last few percent.

**It is not a daemon.** No cron, no triggers, no webhooks. You run it.

**It is not a complete record of your search.** Plenty of employers never send
a confirmation. Email is a floor on what gets tracked, not the whole truth.

## What the OAuth scopes let it do

You will grant exactly two scopes. In plain terms:

| Scope | What it permits |
|---|---|
| `https://www.googleapis.com/auth/gmail.modify` | Read any message in your mailbox, including full bodies, and add or remove labels. It can move mail to Trash; it **cannot** permanently delete it. |
| `https://www.googleapis.com/auth/spreadsheets` | Read and write **any** spreadsheet in your Google Drive, not only the one you configure. Google does not offer a narrower per-file scope for the Sheets API. |

Read access is broader than "the emails this tool cares about" because Gmail
has no scope for "only messages matching this query". `gmail.modify` is the
narrowest scope that can both read a body and apply a label, and the label is
what makes repeat runs idempotent - without it, every run would re-propose the
same rows.

Everything runs locally, as you. Nothing is sent anywhere except to Google's
APIs. The OAuth client and the refresh token are written **outside this
repository**, in `~/.config/job-application-logger/`, so no credential is ever
in a directory that `git add -A` can reach. The token file is written mode
`0600`. You can revoke access at any time at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Setup

### 1. Clone and install

Node 22 or newer is required (`node --version`); the tool uses `--env-file`,
`parseArgs` and `process.loadEnvFile`.

```bash
git clone <this repo> job-application-logger
cd job-application-logger
npm install
```

### 2. Create a Google Cloud project (one time, ~5 minutes)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and
   create a project (or pick an existing one).
2. **APIs & Services > Library**: enable the **Gmail API** and the
   **Google Sheets API**.
3. **APIs & Services > OAuth consent screen**: choose **External**, fill in
   the required fields, and add your own Google account as a **test user**.
   The app stays unverified. That is expected and fine for single-user use -
   Google will show you a "this app isn't verified" warning during consent,
   which you can proceed through because you are the developer and the user.
4. **APIs & Services > Credentials > Create credentials > OAuth client ID >
   Desktop app**. Download the JSON.
5. Move that file **outside the repository**, into the config directory this
   tool reads by default:

   ```bash
   mkdir -p ~/.config/job-application-logger
   chmod 700 ~/.config/job-application-logger
   mv ~/Downloads/client_secret_*.json ~/.config/job-application-logger/credentials.json
   ```

   Do not put it in the repository. `.gitignore` would catch the common
   filenames, but a secret that is not in the working tree cannot be committed
   at all, and that is the property worth having.

### 3. Configure

```bash
cp .env.example .env
```

`.env` is git-ignored; `.env.example` is not. Set `SHEET_ID` to the part of
your spreadsheet URL between `/d/` and `/edit`:

```
https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit
```

`SHEET_ID` is the only required variable. Everything else has a default:

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

Both path variables expand a leading `~`; a relative path is resolved against
the directory you run the command from. Keep them pointing outside the repo.

### 4. First run

```bash
npm run doctor
```

`doctor` requires a `.env` file in the current directory, so do step 3 first.
It opens a browser once, writes the token to `GOOGLE_TOKEN_PATH`, then prints
your spreadsheet's tabs, the detected header row, and the columns it found. If
anything is missing it tells you what to fix, one step at a time.

If `SHEET_TAB_NAME` does not name a real tab, `doctor` prints the list of tabs
and stops. Set `SHEET_TAB_NAME` in `.env` to one of them and run it again.

### 5. Add the three columns

```bash
npm run doctor -- --migrate
```

This appends `Status`, `Last Heard` and `Source` to the right of your existing
columns and backfills `applied` / `manual` into the rows already there. It is
additive by construction: nothing existing is reordered, renamed or rewritten,
it plans a second run as a no-op, and it refuses to run if those positions are
already headed or already hold data.

Run `npm run doctor` without `--migrate` first: it prints the same plan as a
warning without applying it. The plan is covered by tests; the write that
applies it has never run against a real spreadsheet, so read the plan before
you say yes. See [What is tested, and what is not](#what-is-tested-and-what-is-not).

## Daily use

In Claude Code, from this directory:

```
/log-applications 2d
```

The skill in `.claude/skills/log-applications/` reads the sheet, fetches
recent mail, classifies each message, prints a table, waits for your approval,
and then commits.

You can also drive the commands by hand:

```bash
npm run sheet                      # existing rows, with sheet row numbers
npm run fetch -- --since 2d        # candidate messages as JSON
echo '<payload>' | npm run commit -- --dry-run
echo '<payload>' | npm run commit
```

Every command takes `--help` and `--fixture <path>`. The rest:

| Command | Flags |
|---|---|
| `bin/doctor.js` | `--migrate` |
| `bin/fetch.js` | `--since <2d>`, `--max <n>`, `--query-extra <terms>`, `--pretty` |
| `bin/read-sheet.js` | `--tab <name>`, `--pretty` |
| `bin/commit.js` | `--dry-run`, `--tab <name>`, `--pretty` |

`--since` takes Gmail duration syntax (`2d`, `12h`, `3w`, `1m`, `1y`); anything
else is rejected before a request is made. `--max` and `--tab` override
`MAX_MESSAGES` and `SHEET_TAB_NAME` for one run.

`--dry-run` prints the exact rows, cell ranges and message ids it would touch,
under a `plan` key, with `"dryRun": true`. It reads the sheet to resolve those
ranges, and writes nothing anywhere.

## The sheet

| Col | Header | Contents |
|---|---|---|
| A | `Updated` | Date applied, `M/D` |
| B | `Role` | |
| C | `Company` | |
| D | *(unlabeled)* | Link |
| E | *(unlabeled)* | Notes |
| F | `Status` | `applied` / `confirmed` / `rejected` / `interview` |
| G | `Last Heard` | `M/D` of the most recent email about this application |
| H | `Source` | `manual` / `auto` |

The header row is **not** assumed to be row 1. The tools scan the first ten
rows for one containing `Updated`, `Role` and `Company`, and data starts on the
row after it. The letters above are the usual result, not an assumption: every
column is addressed by where its header actually is.

Updates only ever touch the `Status` and `Last Heard` cells of a row. A payload
that tries to set `updated`, `role`, `company`, `link` or `notes` on an update
is rejected outright, so a status change can never overwrite your apply date or
a hand-written note.

## How it works

```
  /log-applications 2d
        |
        +-- bin/read-sheet.js ....... existing rows + 1-indexed row numbers
        +-- bin/fetch.js --since 2d . candidate emails as JSON
        |
        +-- Claude (in-session) judges each email, extracts company and role,
        |   and cross-checks against the existing rows
        |
        +-- table printed, you approve or correct
        |
        +-- bin/commit.js ........... 1. write the sheet rows
                                      2. only then apply the Gmail label
```

`commit.js` owns both the write and the label on purpose. The system's core
invariant is that **a message carries the processed label if and only if its
content reached the sheet**. Split across two commands, they drift: a write
without a label means tomorrow's run duplicates the row, and a label without a
write means the application is lost silently and forever. Keeping both behind
one command fixes the ordering - write first, label second, report partial
failure loudly in `unlabeled` - where the caller cannot get it wrong.

The Gmail label (`logged-to-sheet` by default) *is* the deduplication state.
Every fetch subtracts it: `newer_than:2d -label:logged-to-sheet`.

## JSON contracts

`bin/fetch.js` -> stdout:

```json
{ "query": "newer_than:2d -label:logged-to-sheet", "fetchedAt": "2026-09-03T18:04:11.000Z",
  "count": 3, "truncated": false,
  "messages": [ { "id": "...", "threadId": "...", "date": "...", "from": "...",
                  "fromName": "...", "subject": "...", "snippet": "...", "body": "..." } ] }
```

`bin/read-sheet.js` -> stdout:

```json
{ "tab": "Sheet1", "headerRow": 2,
  "columns": { "updated": "A", "role": "B", "company": "C", "link": "D",
               "notes": "E", "status": "F", "lastHeard": "G", "source": "H" },
  "rows": [ { "row": 3, "updated": "8/24", "role": "Analytics Engineer",
              "company": "Northwind Robotics", "status": "applied",
              "lastHeard": "", "source": "manual" } ] }
```

`bin/commit.js` <- stdin:

```json
{ "appends": [ { "updated": "9/3", "role": "Analytics Engineer", "company": "Northwind Robotics",
                 "link": "", "notes": "", "status": "confirmed", "lastHeard": "9/3",
                 "messageIds": ["..."] } ],
  "updates": [ { "row": 14, "status": "rejected", "lastHeard": "9/3", "messageIds": ["..."] } ],
  "labelOnly": ["..."] }
```

`bin/commit.js` -> stdout:

```json
{ "appended": 1, "updated": 1, "labeled": 3, "errors": [], "unlabeled": [] }
```

`unlabeled` lists messages whose sheet write succeeded but whose labeling
failed. They will resurface on the next run and produce duplicates, which is
why the skill surfaces them instead of swallowing them.

Details worth knowing before you generate these by hand:

- `columns` carries only the columns the sheet actually has: on a sheet that
  has not been migrated, `status`, `lastHeard` and `source` are simply absent.
- A `rows` entry never reports `link` or `notes`. Those are yours; the tool
  reads past them and never writes them.
- An `appends` entry may not set `source`. Appended rows are always written
  `auto`.
- Exit codes from `commit.js`: `0` success, `2` the payload was rejected and
  nothing was written or labeled, `1` something was attempted and part of it
  failed — read `errors` and `unlabeled`.

## Offline mode

Every command takes `--fixture <path>` and runs with no network and no
credentials, against invented data in `fixtures/`:

```bash
node bin/fetch.js      --fixture fixtures/messages.sample.json --pretty
node bin/read-sheet.js --fixture fixtures/messages.sample.json --pretty
node bin/doctor.js     --fixture fixtures/sheet.legacy.json
echo '{"labelOnly":["fixture0000000005"]}' | node bin/commit.js --fixture fixtures/messages.sample.json --pretty
```

A fixture run of `commit.js` is always a dry run - it has nothing to write
with - and says so with `"dryRun": true`.

The test suite is the same mechanism, run over the same fixtures:

```bash
npm test
```

## Privacy

Nothing in this repository is real. The fixtures are invented companies and
`example.com` senders, there is no spreadsheet ID anywhere, and no message from
an actual mailbox is checked in.

The two secret files live in `~/.config/job-application-logger/`, outside the
working tree. `.gitignore` additionally refuses `.env`, `.env.*` (except
`.env.example`), `credentials.json`, `token.json`, `client_secret*.json` and
`*.local.json` — a second line of defence, not the first one.

`npm test` re-checks two of those properties on every run: that no file in the
working tree carries an email address outside `example.com` / `example.org`
(one exception, an ATS vendor's public `no-reply@greenhouse.io`, is
allowlisted in the test), that none carries an absolute path into a home
directory, and that `.gitignore` still contains each pattern above. It cannot
prove the absence of every kind of secret; it checks the shapes that leaked
before.

## What is tested, and what is not

`npm test` is 89 tests over fixtures. **They cover no network call**, because
this repository was built and reviewed without live Google credentials. That
line matters more than any other in this file, so it is worth being exact
about which side of it each behavior falls on.

**Covered by the test suite** (`node:test`, fixtures only, no credentials):

- MIME body extraction: base64url decoding, multipart preference for
  `text/plain`, HTML fallback and entity decoding, nested parts, attachments
  skipped, truncation at `MAX_BODY_CHARS`.
- Query construction, including the `-label:` term the deduplication depends
  on, and `--since` duration validation.
- Header-row detection, column mapping, 1-indexed row numbers, and the exact
  JSON emitted by `fetch.js`, `read-sheet.js` and `commit.js` in `--fixture`
  mode, including exit codes.
- Commit payload validation: the closed status set, the refusal of `?`, the
  refusal to write columns A–E on an update, unknown fields, bad rows.
- The write-then-label ordering and its partial-failure reporting, against an
  injected fake API: what gets labeled when an append fails, when an update
  fails, and when the label call itself fails.
- The migration *plan*: what `--migrate` would write, that it is a no-op the
  second time, and that it refuses a column already in use.
- Config resolution: defaults, `~` expansion, validation errors, and that the
  token file is written mode `0600`.

**Not covered — code-reviewed only, never executed against Google:**

- The entire OAuth flow: consent, the loopback redirect, the code exchange,
  token refresh, and the stale-token (`invalid_grant`) recovery path.
- Every Gmail API call: search, message fetch, label creation, `batchModify`.
- Every Sheets API call: reading values, appending rows, the cell
  `batchUpdate`.
- The actual write performed by `doctor --migrate`. Its plan is tested; the
  request that applies the plan is not.
- `explainApiError`: the mapping from a real Google error to a readable
  message is pattern-matching against error strings nobody has yet seen come
  back from Google.
- End-to-end idempotency. That a labeled message stays out of tomorrow's sweep
  follows from the query, which is tested — but the loop has never been run
  against a live mailbox.

So: expect the offline behavior to hold, and treat the first live run as the
first live run. Use `--dry-run`, read the `plan`, and start with a small
`--since` window.

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
HANDOFF.md          the original implementation brief, kept for provenance
```

## License

MIT. See [LICENSE](LICENSE).
