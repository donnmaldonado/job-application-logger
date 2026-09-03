#!/usr/bin/env node
/**
 * commit.js - JSON payload on stdin -> sheet write, then Gmail label.
 *
 * This command owns both halves on purpose. The system's core invariant is
 * that a message carries the processed label if and only if its content
 * reached the sheet. Split across two commands, they drift: a write without a
 * label duplicates the row tomorrow, and a label without a write loses the
 * application silently and forever. Keeping both here fixes the ordering -
 * write first, label second, report partial failure loudly - where the caller
 * cannot get it wrong.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, die, UserError } from '../src/config.js';
import { getAuthClient, gmailClient, sheetsClient, explainApiError } from '../src/auth.js';
import { loadFixture, fixtureSheet } from '../src/fixture.js';
import { validateCommitPayload, collectMessageIds } from '../src/schema.js';
import {
  readValues,
  buildSheetPayload,
  buildAppendRow,
  appendRows,
  writeCells,
  columnLetter,
  quoteTab,
} from '../src/sheets.js';
import { ensureLabel, batchLabel } from '../src/gmail.js';

const USAGE = `Usage: <json> | npm run commit -- [options]

Reads the commit payload on stdin:
  { "appends": [...], "updates": [...], "labelOnly": ["<messageId>"] }

  --dry-run          Print exactly what would be written. Reads the sheet to
                     resolve ranges; writes nothing and labels nothing.
  --tab <name>       Tab to write to (default: SHEET_TAB_NAME)
  --fixture <path>   Use a fixture for the sheet state; implies --dry-run
  --pretty           Indent the JSON output
  --help
`;

async function main() {
  const { values: flags } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      tab: { type: 'string' },
      fixture: { type: 'string' },
      pretty: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (flags.help) {
    process.stdout.write(USAGE);
    return;
  }

  const usingFixture = Boolean(flags.fixture);
  // A fixture run has no credentials and no network, so it can only ever be a
  // dry run. Say so in the output rather than pretending a write happened.
  const dryRun = flags['dry-run'] || usingFixture;
  const config = loadConfig({ requireSheetId: !usingFixture });

  const raw = await readStdin();
  if (raw.trim() === '') {
    throw new UserError('commit.js expects a JSON payload on stdin, and got nothing.', {
      hint: 'Pipe one in:\n  echo \'{"appends":[],"updates":[],"labelOnly":[]}\' | npm run commit',
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    emit({ errors: [`stdin is not valid JSON: ${err.message}`] }, flags.pretty);
    process.exit(2);
  }

  const { valid, errors: validationErrors, payload } = validateCommitPayload(parsed);
  if (!valid) {
    emit({ errors: validationErrors }, flags.pretty);
    process.exit(2);
  }

  // --- Read the sheet's current shape (needed to place appends and to check
  // --- that every update row actually exists).
  const tab = flags.tab ?? (usingFixture ? undefined : config.tabName);
  let values;
  let sheets = null;
  let auth = null;
  let resolvedTab = tab;

  if (usingFixture) {
    const sheet = fixtureSheet(loadFixture(flags.fixture));
    resolvedTab = tab ?? sheet.tab;
    values = sheet.values;
  } else {
    auth = await getAuthClient(config, { interactive: false });
    sheets = sheetsClient(auth);
    try {
      values = await readValues(sheets, config.sheetId, resolvedTab);
    } catch (err) {
      throw explainApiError(err, { config, api: 'Sheets' });
    }
  }

  const sheet = buildSheetPayload(values, resolvedTab);
  const preflight = preflightErrors(sheet, payload, values);
  if (preflight.length > 0) {
    emit({ errors: preflight }, flags.pretty);
    process.exit(2);
  }

  const plan = buildPlan(sheet, payload, resolvedTab);

  if (dryRun) {
    emit(
      {
        dryRun: true,
        appended: payload.appends.length,
        updated: payload.updates.length,
        labeled: plan.labelIds.length,
        errors: [],
        unlabeled: [],
        plan: {
          tab: resolvedTab,
          headerRow: sheet.headerRow,
          appendRows: plan.appendRows,
          updateCells: plan.updateCells,
          labelIds: plan.labelIds,
          label: config.processedLabel,
        },
      },
      flags.pretty
    );
    return;
  }

  // --- Write first, label second. See executeCommit below. ---------------
  const gmail = gmailClient(auth);

  const result = await executeCommit({
    plan,
    payload,
    io: {
      appendRows: (rows) => appendRows(sheets, config.sheetId, resolvedTab, rows),
      writeCells: (cells) => writeCells(sheets, config.sheetId, cells),
      label: async (ids) => {
        const { id: labelId } = await ensureLabel(gmail, config.processedLabel);
        return batchLabel(gmail, ids, labelId);
      },
    },
    describeError: (err, api) => explainApiError(err, { config, api }).message,
  });

  emit(result, flags.pretty);
  if (result.errors.length > 0) process.exit(1);
}

/**
 * The invariant, in one place: write to the sheet first, label only what
 * actually landed there, and say loudly when the label half fails.
 *
 * `io` is injected so the ordering and the partial-failure reporting can be
 * tested without credentials - which matters, because this is the one piece
 * of behavior whose failure mode is silent data loss or silent duplication.
 *
 * @param {object} args
 * @param {object} args.plan   from buildPlan()
 * @param {object} args.payload validated commit payload
 * @param {{appendRows:Function, writeCells:Function, label:Function}} args.io
 */
export async function executeCommit({ plan, payload, io, describeError = (e) => e?.message ?? String(e) }) {
  const errors = [];
  const writtenIds = [];
  let appended = 0;
  let updated = 0;

  if (plan.appendRows.length > 0) {
    try {
      await io.appendRows(plan.appendRows);
      appended = plan.appendRows.length;
      writtenIds.push(...plan.appendIds);
    } catch (err) {
      errors.push(`appending rows failed: ${describeError(err, 'Sheets')}`);
    }
  }

  if (plan.updateCells.length > 0) {
    try {
      await io.writeCells(plan.updateCells);
      updated = payload.updates.length;
      writtenIds.push(...plan.updateIds);
    } catch (err) {
      errors.push(`updating rows failed: ${describeError(err, 'Sheets')}`);
    }
  }

  // labelOnly ids carry no sheet content, so nothing about them could have
  // failed to be written: they are always eligible for the label.
  const labelable = dedupe([...writtenIds, ...payload.labelOnly]);
  let labeled = 0;
  let unlabeled = [];

  if (labelable.length > 0) {
    try {
      labeled = await io.label(labelable);
    } catch (err) {
      unlabeled = labelable;
      errors.push(
        `sheet write succeeded but labeling failed, so these messages will resurface next run and duplicate: ${describeError(err, 'Gmail')}`
      );
    }
  }

  return { appended, updated, labeled, errors, unlabeled };
}

/** Checks that must pass before anything is written. */
export function preflightErrors(sheet, payload, values) {
  const errors = [];
  const idx = sheet.indices;

  const missing = ['status', 'lastHeard', 'source'].filter((k) => idx[k] === undefined);
  if (missing.length > 0 && (payload.appends.length > 0 || payload.updates.length > 0)) {
    errors.push(
      `the sheet is missing the ${missing.join(', ')} column(s). Run \`npm run doctor -- --migrate\` once to add Status, Last Heard and Source.`
    );
  }

  const lastRow = values.length;
  for (const [i, update] of payload.updates.entries()) {
    if (update.row <= sheet.headerRow) {
      errors.push(
        `updates[${i}].row is ${update.row}, which is the header row or above it (header is row ${sheet.headerRow})`
      );
    } else if (update.row > lastRow) {
      errors.push(
        `updates[${i}].row is ${update.row}, but the tab "${sheet.tab}" only has ${lastRow} rows. Re-run \`npm run sheet\` for current row numbers.`
      );
    }
  }
  return errors;
}

export function buildPlan(sheet, payload, tab) {
  const idx = sheet.indices;

  const appendRowsPlan = payload.appends.map((a) => buildAppendRow(a, idx));
  const appendIds = payload.appends.flatMap((a) => a.messageIds ?? []);

  const updateCells = [];
  for (const update of payload.updates) {
    if (update.status !== undefined && idx.status !== undefined) {
      updateCells.push({
        range: `${quoteTab(tab)}!${columnLetter(idx.status)}${update.row}`,
        value: update.status,
      });
    }
    if (update.lastHeard !== undefined && idx.lastHeard !== undefined) {
      updateCells.push({
        range: `${quoteTab(tab)}!${columnLetter(idx.lastHeard)}${update.row}`,
        value: update.lastHeard,
      });
    }
  }
  const updateIds = payload.updates.flatMap((u) => u.messageIds ?? []);

  return {
    appendRows: appendRowsPlan,
    appendIds,
    updateCells,
    updateIds,
    labelIds: collectMessageIds(payload),
  };
}

function dedupe(ids) {
  return [...new Set(ids.filter(Boolean))];
}

function emit(partial, pretty) {
  const output = {
    appended: 0,
    updated: 0,
    labeled: 0,
    errors: [],
    unlabeled: [],
    ...partial,
  };
  process.stdout.write(JSON.stringify(output, null, pretty ? 2 : 0) + '\n');
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main().catch(die);
