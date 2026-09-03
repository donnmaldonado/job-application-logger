---
name: log-applications
description: Log job applications from Gmail into the tracking spreadsheet. Use when the user asks to log job applications, check application emails, sweep the inbox for rejections or interview invites, or update the job tracker. Reads recent mail, classifies each message, shows a table for approval, and only then writes to the sheet.
---

# Log applications

Batch-log job application email into the tracking sheet. You supply the
judgment; the scripts are dumb pipes.

**You must not write anything without the user's explicit approval, and you
must not invent a company name to avoid asking a question.**

Run everything from the repository root.

## 1. Gather

Run both, in either order:

```bash
npm run sheet
npm run fetch -- --since <duration>
```

`<duration>` is the user's argument if they gave one (`/log-applications 2d`),
otherwise omit `--since` and let `GMAIL_LOOKBACK` decide.

`npm run sheet` returns `{ tab, headerRow, columns, rows }`, where each row
carries its 1-indexed sheet `row`. `npm run fetch` returns
`{ query, fetchedAt, count, truncated, messages }`.

If `truncated` is `true`, say so: Gmail had more messages than `MAX_MESSAGES`,
so this run is a partial sweep and the user may want a second pass.

If either command exits non-zero, print its error and stop. The errors are
written for the user; do not paraphrase them into something vaguer.

## 2. Classify and extract

For each message decide one of:

- `confirmation` - "we received your application"
- `rejection` - "we are moving forward with other candidates"
- `interview` - a request to schedule, a recruiter screen, an assessment
- `irrelevant` - job alerts, newsletters, cold recruiter outreach, anything
  not about an application this person actually submitted

Then extract **company** and **role**.

- The company is frequently **not** the sender. Greenhouse, Lever, Ashby,
  Workday, iCIMS and SmartRecruiters all send on the employer's behalf, so
  a no-reply address at the ATS domain tells you nothing about who is hiring. Read the
  body for the employer name.
- The role is often absent from the subject and present only in the body.
  Workday confirmations are frequently generic about both company and role.
- If you cannot determine the company or the role confidently, mark that field
  `?` and ask the user. Never guess a company name into the sheet. `commit.js`
  rejects a payload containing `?` on purpose.

## 3. Cross-check against the sheet

Compare every extraction against the rows from `npm run sheet`.

A match on company plus a similar role is an **update**, not an append. The
user logs rows by hand when they apply, so a confirmation email for an
application already in the sheet is the common case, not the edge case.

- Existing row, new information -> update (`~`), addressed by its `row` number.
- No matching row -> append (`+`).
- Irrelevant -> ignore (`-`); it still gets labeled so it never comes back.
- Ambiguous -> `?`; ask.

Status mapping: `confirmation` -> `confirmed`, `rejection` -> `rejected`,
`interview` -> `interview`. `applied` is what the user writes by hand when
they apply and nothing has come back yet.

## 4. Show the table

Print one row per message, with a leading marker, showing exactly what will be
written:

```
  + 9/3  Analytics Engineer        Northwind Robotics   confirmed  (new row)
  ~ 8/25 Data Engineer             Vantage Grid         rejected   (row 5)
  ? 9/3  ???                       Meridian Health      confirmed  (generic Workday mail)
  - 9/3  job alert digest          -                    -          (will be labeled only)
```

Then say what would change: N appends, N updates, N labeled-only.

## 5. Wait for approval

Stop and ask. Apply any correction the user gives - a company name, a role, a
row number, a reclassification - and re-print the table if the change is
substantial. Only proceed on an explicit go-ahead.

If any row is still `?` after the user answers, it must become a real value or
be dropped from the payload. It cannot be committed as `?`.

## 6. Commit

Pipe the payload to `commit.js`:

```bash
echo '<json>' | npm run commit
```

```json
{
  "appends": [
    { "updated": "9/3", "role": "Analytics Engineer", "company": "Northwind Robotics",
      "link": "", "notes": "", "status": "confirmed", "lastHeard": "9/3",
      "messageIds": ["18fa2b3c4d5e6f70"] }
  ],
  "updates": [
    { "row": 5, "status": "rejected", "lastHeard": "9/3", "messageIds": ["18fa2b3c4d5e6f71"] }
  ],
  "labelOnly": ["18fa2b3c4d5e6f72"]
}
```

Rules the payload must respect:

- `updates` may only carry `row`, `status`, `lastHeard`, `messageIds`. It must
  never carry `updated`, `role`, `company`, `link` or `notes`: a status change
  must not overwrite the apply date or a hand-written note.
- Every message you looked at belongs in exactly one of the three sections.
  A message left out of all three is re-examined tomorrow, and the sweep gets
  noisier every day the job search runs. `labelOnly` is how irrelevant mail
  stops coming back.
- Dates are `M/D` text, matching the sheet's existing format.

Use `--dry-run` first if the payload is large or the user is unsure:

```bash
echo '<json>' | npm run commit -- --dry-run
```

## 7. Report

`commit.js` prints:

```json
{ "appended": 1, "updated": 1, "labeled": 3, "errors": [], "unlabeled": [] }
```

Report `appended`, `updated` and `labeled`. Then:

- If `errors` is non-empty, show every entry verbatim.
- If `unlabeled` is non-empty, **say so prominently**. Those messages reached
  the sheet but did not get labeled, so tomorrow's run will see them again and
  propose duplicate rows. Tell the user which ones, and that they can label
  them by hand in Gmail (the label is `GMAIL_PROCESSED_LABEL`, default
  `logged-to-sheet`) or watch for duplicates on the next run.

## Setup problems

If a command reports missing configuration, missing credentials, a missing
tab, or a missing `Status` column, run `npm run doctor` and relay what it
says. `npm run doctor -- --migrate` adds the `Status`, `Last Heard` and
`Source` columns; it is additive and idempotent, but it writes to the sheet,
so ask the user before running it.
