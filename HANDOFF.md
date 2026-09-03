# Handoff: `job-application-logger`

Implementation spec for a Claude Code skill that batch-logs job application
emails into a Google Sheet. Written to be built by an agent and published as a
public GitHub repository.

**Status:** implemented. This file is kept as the original brief, for
provenance and for the reasoning behind the design. Where it and the README
disagree, **the README and the code are authoritative** — most importantly, the
credential and token files now live outside the repository, in
`~/.config/job-application-logger/`, not in the repo root as sketched below.
**Target:** Node 22+, ESM, zero build step.

---

## 1. Problem

A job seeker applies to ~5-10 roles a day and manually types each one into a
tracking spreadsheet. Confirmation emails ("thanks for applying"), rejections,
and interview invites all land in Gmail and already contain the information
being retyped.

**The job:** once a day, the user runs one command. It pulls recent candidate
emails, Claude judges each one and extracts company/role/outcome, shows the
user a table for approval, and on approval writes to the sheet and labels the
messages so they never appear again.

### Explicit non-goals

- **Not a daemon.** No cron, no triggers, no webhooks. Human-invoked, batched.
- **Not autonomous.** Nothing is written to the sheet without user approval in
  the terminal. This is a deliberate design choice: LLM extraction from ATS
  email lands around 90-95%, and a human glance at a table is cheaper and more
  reliable than engineering the last 5%.
- **Not a complete record.** Many employers never send a confirmation. Email is
  a floor on what gets tracked, not the whole truth.
- **No LLM API calls in the code.** The judging happens in the Claude Code
  session that invokes the skill. The scripts are dumb pipes. This keeps the
  repo free of API keys and free of an inference bill.

---

## 2. Architecture

Four small CLI commands, each doing one thing, communicating over JSON on
stdin/stdout. A `SKILL.md` orchestrates them and supplies the judgment.

```
  ┌─────────────────────────────────────────────────┐
  │  User: /log-applications 2d                     │
  └────────────────────┬────────────────────────────┘
                       │
        ┌──────────────▼──────────────┐
        │  bin/read-sheet.js          │──▶ existing rows + row numbers
        │  bin/fetch.js --since 2d    │──▶ candidate emails as JSON
        └──────────────┬──────────────┘
                       │
        ┌──────────────▼──────────────────────────┐
        │  Claude (in-session) judges each email: │
        │   confirmation / rejection / interview  │
        │   / irrelevant, extracts company+role,  │
        │   cross-checks against existing rows    │
        └──────────────┬──────────────────────────┘
                       │
        ┌──────────────▼──────────────┐
        │  Table printed to terminal  │
        │  User approves / edits      │
        └──────────────┬──────────────┘
                       │
        ┌──────────────▼─────────────────────────┐
        │  bin/commit.js  (reads JSON on stdin)  │
        │   1. write sheet rows                  │
        │   2. only then apply Gmail label       │
        └────────────────────────────────────────┘
```

### Why `commit.js` does both the write and the label

The system's core invariant is: **a message carries the processed label if and
only if its content reached the sheet.** Splitting write and label across two
commands lets them drift — a successful write followed by a failed label means
tomorrow's run duplicates the row; a successful label followed by a failed
write means the application is lost silently and forever. Keeping both behind
one command makes the ordering (write first, label second, report partial
failure loudly) impossible for the caller to get wrong.

### Repository layout

```
job-application-logger/
├── .claude/
│   └── skills/
│       └── log-applications/
│           └── SKILL.md
├── bin/
│   ├── doctor.js          # verify config, auth, sheet shape; list tabs
│   ├── fetch.js           # Gmail  -> JSON on stdout
│   ├── read-sheet.js      # Sheets -> JSON on stdout
│   └── commit.js          # JSON on stdin -> Sheets write, then Gmail label
├── src/
│   ├── auth.js            # OAuth flow, token cache, client construction
│   ├── config.js          # env loading + validation, single source of truth
│   ├── gmail.js           # search, fetch, MIME body extraction, labeling
│   ├── sheets.js          # header detection, read, append, update
│   ├── schema.js          # JSON payload validation for commit.js
│   └── fixture.js         # offline input for --fixture
├── fixtures/
│   ├── messages.sample.json
│   └── sheet.legacy.json
├── test/                  # node:test, fixtures only, no network
├── .env.example
├── .gitignore
├── package.json
├── LICENSE                # MIT
├── README.md
└── HANDOFF.md             # this file
```

---

## 3. Configuration

All configuration is environment variables, loaded from `.env` via Node 22's
built-in `--env-file` support or `process.loadEnvFile()`. **Do not add a
`dotenv` dependency.**

`src/config.js` is the only module that reads `process.env`. It validates on
load and throws a readable error naming the missing variable and what it is
for — never a bare `undefined` failure deep in an API call.

### `.env.example` (committed)

```bash
# ---- Required ----

# The spreadsheet's ID, from its URL:
# https://docs.google.com/spreadsheets/d/<THIS_PART>/edit
SHEET_ID=

# Which tab to write to. Run `npm run doctor` to list the tabs in your sheet.
SHEET_TAB_NAME=Sheet1

# ---- Optional: paths (defaults shown) ----
# Both live outside the repository so they cannot be committed at all.

# OAuth client downloaded from Google Cloud Console. Never commit this.
GOOGLE_CREDENTIALS_PATH=~/.config/job-application-logger/credentials.json

# Cached refresh token, written on first run. Never commit this.
GOOGLE_TOKEN_PATH=~/.config/job-application-logger/token.json

# ---- Optional: behavior (defaults shown) ----

# How far back to look when --since is not passed. Gmail duration syntax.
GMAIL_LOOKBACK=2d

# Label applied to messages after their data reaches the sheet. Created
# automatically if it does not exist. This label is the deduplication state.
GMAIL_PROCESSED_LABEL=logged-to-sheet

# Extra Gmail search terms ANDed onto the query. Use to narrow the sweep,
# e.g. "-from:newsletter@example.com" or "-category:promotions"
GMAIL_QUERY_EXTRA=

# Max messages pulled in one run. Guards against a runaway first run.
MAX_MESSAGES=50

# Characters of message body passed downstream. Enough for an ATS email's
# useful content without flooding the session context.
MAX_BODY_CHARS=2000

# Timezone used to format dates written to the sheet.
TIMEZONE=America/New_York
```

### `.gitignore` (committed)

```
node_modules/
.env
.env.*
!.env.example
credentials.json
token.json
client_secret*.json
*.local.json
.DS_Store
```

These are a second line of defence. The first is that the real credential and
token files are never in the working tree at all.

**This repository must contain no secrets, no email addresses, no spreadsheet
IDs, and no message contents.** `fixtures/messages.sample.json` must use
invented companies and an `example.com` sender domain. A reviewer should be
able to confirm this by reading `.gitignore` and grepping for `@`.

---

## 4. Google Cloud setup (the user does this; document it in the README)

1. Create a project at console.cloud.google.com.
2. Enable the **Gmail API** and the **Google Sheets API**.
3. OAuth consent screen → **External**, add your own account as a test user.
   The app stays unverified; that is expected and fine for single-user use.
4. Credentials → **OAuth client ID** → **Desktop app** → download JSON →
   save it as `~/.config/job-application-logger/credentials.json`, outside the
   repository.
5. `cp .env.example .env`, fill in `SHEET_ID`.
6. `npm run doctor` — opens a browser once, writes `token.json`, then prints
   the sheet's tabs and detected header row.

### Scopes

| Scope | Why |
|---|---|
| `https://www.googleapis.com/auth/gmail.modify` | Read message bodies **and** apply the processed label. Read-only cannot label, and the label is what makes runs idempotent. |
| `https://www.googleapis.com/auth/spreadsheets` | Append rows and update status cells. |

Request nothing broader. `gmail.modify` cannot delete messages permanently,
which is the property that matters here. State this tradeoff in the README —
users should know what they are granting.

---

## 5. The sheet

### Current state

Columns, in order: `Updated`, `Role`, `Company`, then an unlabeled link column
and an unlabeled notes column. Dates are `M/D` text ("8/24"). ~37 rows. The
header row is **not** guaranteed to be row 1 — there is leading blank content —
and the spreadsheet contains more than one tab.

### Required migration (additive, non-destructive)

Append three columns to the right of the existing five. Do not reorder, rename,
or rewrite anything that exists.

| Col | Header | Contents |
|---|---|---|
| A | `Updated` | Date applied, `M/D`. Unchanged. |
| B | `Role` | Unchanged. |
| C | `Company` | Unchanged. |
| D | *(existing, unlabeled)* | Link. Leave as is. |
| E | *(existing, unlabeled)* | Notes. Leave as is. |
| F | `Status` | `applied` \| `confirmed` \| `rejected` \| `interview` |
| G | `Last Heard` | `M/D` of the most recent email about this application |
| H | `Source` | `manual` \| `auto` |

`doctor.js --migrate` performs this: writes the three headers and backfills
`applied` / `manual` into existing rows, leaving `Last Heard` blank. It must be
idempotent — running it twice changes nothing — and must refuse to run if the
headers are already present with different names.

### Header detection

Never assume row 1. Scan the first 10 rows for one containing (case-insensitive,
trimmed) all of `updated`, `role`, `company`. That row index is `headerRow`;
data begins at `headerRow + 1`. If no such row is found, exit non-zero with a
message telling the user to check `SHEET_TAB_NAME` and run `doctor`.

---

## 6. JSON contracts

These shapes are the integration surface between the scripts and the model.
Implement them exactly; the skill depends on the field names.

### `bin/fetch.js --since <duration>` → stdout

```json
{
  "query": "newer_than:2d -label:logged-to-sheet",
  "fetchedAt": "2026-09-03T18:04:11.000Z",
  "count": 3,
  "truncated": false,
  "messages": [
    {
      "id": "18fa2b3c4d5e6f70",
      "threadId": "18fa2b3c4d5e6f70",
      "date": "2026-09-03T14:22:00.000Z",
      "from": "no-reply@greenhouse.io",
      "fromName": "Greenhouse",
      "subject": "Thank you for applying to Ramp",
      "snippet": "Thanks for your interest in the Analytics Engineer role...",
      "body": "…plain text, HTML stripped, truncated to MAX_BODY_CHARS…"
    }
  ]
}
```

`truncated` is `true` when Gmail returned more results than `MAX_MESSAGES`.

### `bin/read-sheet.js` → stdout

Row numbers are 1-indexed **sheet** rows, so `commit.js` updates can address
them directly. This is why the Drive connector cannot substitute for this
script — it returns no row numbers.

```json
{
  "tab": "Sheet1",
  "headerRow": 2,
  "columns": { "updated": "A", "role": "B", "company": "C",
               "link": "D", "notes": "E", "status": "F",
               "lastHeard": "G", "source": "H" },
  "rows": [
    { "row": 3, "updated": "8/24", "role": "Analytics Engineer",
      "company": "iHeartMedia", "status": "applied", "lastHeard": "",
      "source": "manual" }
  ]
}
```

### `bin/commit.js` ← stdin

```json
{
  "appends": [
    {
      "updated": "9/3",
      "role": "Analytics Engineer",
      "company": "Ramp",
      "link": "",
      "notes": "",
      "status": "confirmed",
      "lastHeard": "9/3",
      "messageIds": ["18fa2b3c4d5e6f70"]
    }
  ],
  "updates": [
    { "row": 14, "status": "rejected", "lastHeard": "9/3",
      "messageIds": ["18fa2b3c4d5e6f71"] }
  ],
  "labelOnly": ["18fa2b3c4d5e6f72"]
}
```

`labelOnly` carries messages Claude judged irrelevant — recruiter spam, job
alerts, newsletters. **This field is not optional polish.** Without it, every
irrelevant email in the lookback window is re-examined on every run, and the
sweep gets noisier the longer the job search runs.

`updates` never writes columns A-E. A status change must not overwrite the
apply date or a hand-written note.

### `bin/commit.js` → stdout

```json
{
  "appended": 1, "updated": 1, "labeled": 3,
  "errors": [],
  "unlabeled": []
}
```

`unlabeled` lists message IDs whose sheet write succeeded but whose labeling
failed. These will resurface next run and produce duplicates, so the skill must
surface them to the user rather than swallowing them.

`--dry-run` prints exactly what would be written and exits without touching
Gmail or Sheets.

---

## 7. Implementation notes

**Dependency budget: `googleapis` only.** Node 22 covers env files, fetch, and
argument parsing (`node:util` `parseArgs`). Resist adding anything else.

**MIME body extraction** is the fiddliest part and deserves its own tested
function in `src/gmail.js`:
- Walk `payload.parts` recursively; parts nest arbitrarily deep.
- Prefer `text/plain`. Fall back to `text/html` with tags stripped and entities
  decoded.
- Bodies are **base64url**, not base64 — `-` and `_` must be translated before
  decoding, or ATS emails will decode to mojibake.
- Collapse runs of whitespace before truncating, so `MAX_BODY_CHARS` buys real
  content instead of the layout padding ATS templates are full of.

**Label creation:** look up `GMAIL_PROCESSED_LABEL` by name; create it if
absent; cache the ID for the run.

**Batch the labeling** via `users.messages.batchModify` — one call, not N.

**Auth flow:** loopback redirect on `http://localhost:<random-port>`, open the
consent URL, capture the code, exchange it, write `token.json` with mode
`0600`. On a stale or revoked refresh token, delete the token file and tell the
user to re-run `doctor` — do not silently loop.

**Errors are for a human at a terminal.** A missing `SHEET_ID` should print
what to set and where to find it, not a stack trace.

### `package.json` scripts

```json
{
  "doctor":  "node --env-file=.env bin/doctor.js",
  "fetch":   "node --env-file=.env bin/fetch.js",
  "sheet":   "node --env-file=.env bin/read-sheet.js",
  "commit":  "node --env-file=.env bin/commit.js"
}
```

---

## 8. `SKILL.md`

Frontmatter `name: log-applications`, with a description covering "log job
applications", "check application emails", "update the job tracker".

The body instructs the model to:

1. Run `npm run sheet` and `npm run fetch -- --since <arg or default>`.
2. Classify each message into `confirmation` / `rejection` / `interview` /
   `irrelevant`, and extract company and role.
   - The company is frequently **not** the sender — ATS platforms
     (Greenhouse, Lever, Ashby, Workday, iCIMS, SmartRecruiters) send on the
     employer's behalf. Read the body for the employer name.
   - The role is often absent from the subject and present in the body, and
     Workday confirmations are frequently generic about both.
   - When company or role cannot be determined confidently, mark the row `?`
     and ask — never guess a company name into the sheet.
3. Cross-check every extraction against the rows from `npm run sheet`. A match
   on company plus a similar role is an **update**, not an append. The user
   logs rows manually when applying, so the confirmation email for a
   just-logged application is the common case, not the edge case.
4. Print a table with a leading marker per row: `+` append, `~` update,
   `-` ignore, `?` needs the user's input. Show what will be written.
5. Wait for approval. Apply any corrections the user gives.
6. Pipe the payload to `npm run commit`, then report `appended` / `updated` /
   `labeled`, and surface any `unlabeled` or `errors` prominently.

**The skill must not write without approval, and must not invent a company
name to avoid asking a question.**

---

## 9. Definition of done

- [ ] `npm run doctor` on a fresh clone gives an actionable error for every
      missing piece of setup, in order, without a stack trace.
- [ ] First run completes OAuth and writes `token.json`; later runs are silent.
- [ ] `doctor --migrate` adds the three columns, backfills, and is idempotent.
- [ ] `fetch.js` handles multipart, HTML-only, and plain-text messages, and
      base64url decodes correctly.
- [ ] `commit.js --dry-run` writes nothing anywhere.
- [ ] `commit.js` labels only after a successful sheet write, and reports
      `unlabeled` when labeling fails.
- [ ] Running the skill twice over the same window produces no duplicate rows.
- [ ] `git status` on a configured working copy shows no `.env`,
      `credentials.json`, or `token.json`.
- [ ] README lets a stranger go from clone to first run, states plainly what
      the OAuth scopes permit, and says the tool is not autonomous.

### Verification limits at implementation time

`credentials.json` does not exist yet — the Google Cloud setup in §4 has not
been done. **The implementer cannot run an end-to-end test.** Therefore:

- Every script must accept `--fixture <path>` to run against
  `fixtures/messages.sample.json` with no network and no credentials. This is
  how parsing, classification shaping, and payload validation get exercised.
- Report honestly which behavior was tested against fixtures and which is
  written but unverified against the live APIs. Do not describe unverified
  paths as working.
