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

## What this is not

**It is not autonomous.** Nothing reaches your spreadsheet without you
approving it in the terminal first. That is a deliberate design choice, not a
missing feature: extraction from ATS email lands around 90-95%, and a human
glance at a table is cheaper and more reliable than engineering the last 5%.

**It is not a daemon.** No cron, no triggers, no webhooks. You run it.

**It is not a complete record of your search.** Plenty of employers never send
a confirmation. Email is a floor on what gets tracked, not the whole truth.

## What the OAuth scopes let it do

You will grant exactly two scopes. In plain terms:

| Scope | What it permits |
|---|---|
| `https://www.googleapis.com/auth/gmail.modify` | Read any message in your mailbox, including full bodies, and add or remove labels. It **cannot** permanently delete mail. |
| `https://www.googleapis.com/auth/spreadsheets` | Read and write **any** spreadsheet in your Google Drive, not only the one you configure. Google does not offer a narrower per-file scope for the Sheets API. |

Read access is broader than "the emails this tool cares about" because Gmail
has no scope for "only messages matching this query". `gmail.modify` is the
narrowest scope that can both read a body and apply a label, and the label is
what makes repeat runs idempotent - without it, every run would re-propose the
same rows.

Everything runs locally, as you. Nothing is sent anywhere except to Google's
APIs. The token lives in `token.json` in this directory, mode `0600`, and is
git-ignored. You can revoke access at any time at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Setup

### 1. Clone and install

```bash
git clone <this repo>
cd job-search
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
5. Save that file as `credentials.json` in this directory. It is git-ignored.

### 3. Configure

```bash
cp .env.example .env
```

Set `SHEET_ID` to the part of your spreadsheet URL between `/d/` and `/edit`:

```
https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit
```

Everything else has a default. See `.env.example` for what each variable does.

### 4. First run

```bash
npm run doctor
```

This opens a browser once, writes `token.json`, then prints your spreadsheet's
tabs, the detected header row, and the columns it found. If anything is
missing it tells you what to fix, one step at a time.

Set `SHEET_TAB_NAME` in `.env` to whichever tab `doctor` listed, then run it
again.

### 5. Add the three columns

```bash
npm run doctor -- --migrate
```

This appends `Status`, `Last Heard` and `Source` to the right of your existing
columns and backfills `applied` / `manual` into the rows already there. It is
additive: nothing existing is reordered, renamed or rewritten. It is
idempotent: running it twice changes nothing. It refuses to run if those
positions are already occupied by something else.

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

`--dry-run` prints the exact rows, cell ranges and message ids it would touch.
It reads the sheet to resolve those ranges, and writes nothing anywhere.

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
row after it. Updates only ever touch columns F and G, so a status change can
never overwrite your apply date or a hand-written note.

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

```bash
npm test
```

## Privacy

This repository contains no secrets, no email addresses, no spreadsheet IDs
and no message content. `.env`, `credentials.json` and `token.json` are
git-ignored, and the fixtures use invented companies and `example.com`
senders. `npm test` asserts all of that on every run.

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
