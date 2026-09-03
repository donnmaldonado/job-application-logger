#!/usr/bin/env node
/**
 * doctor.js - check the setup, one step at a time, and say what to do about
 * whatever is missing. Also lists the spreadsheet's tabs, reports the detected
 * header row, and (with --migrate) adds the three new columns.
 *
 * Every failure here is a human-readable instruction, never a stack trace:
 * this is the command a stranger runs first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, die, UserError } from '../src/config.js';
import {
  getAuthClient,
  gmailClient,
  sheetsClient,
  readCredentials,
  explainApiError,
  SCOPES,
} from '../src/auth.js';
import { loadFixture, fixtureSheet } from '../src/fixture.js';
import {
  listTabs,
  readValues,
  detectHeaderRow,
  buildColumns,
  columnsToLetters,
  buildSheetPayload,
  planMigration,
  writeCells,
  MIGRATION_HEADERS,
} from '../src/sheets.js';

const USAGE = `Usage: npm run doctor [-- options]

  --migrate          Add the Status / Last Heard / Source columns and backfill
                     existing rows. Additive, non-destructive, idempotent.
  --fixture <path>   Check sheet shape against a fixture; no network, no credentials
  --help
`;

const MIN_NODE_MAJOR = 22;

function ok(msg) {
  process.stdout.write(`  ok    ${msg}\n`);
}
function warn(msg) {
  process.stdout.write(`  warn  ${msg}\n`);
}
function info(msg) {
  process.stdout.write(`        ${msg}\n`);
}
function step(msg) {
  process.stdout.write(`\n${msg}\n`);
}

async function main() {
  const { values: flags } = parseArgs({
    options: {
      migrate: { type: 'boolean', default: false },
      fixture: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (flags.help) {
    process.stdout.write(USAGE);
    return;
  }

  const usingFixture = Boolean(flags.fixture);

  step('Node');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR) {
    throw new UserError(`Node ${process.versions.node} is too old; this tool needs Node ${MIN_NODE_MAJOR}+.`, {
      hint: 'Node 22 is what supplies --env-file, parseArgs, and fetch, which is why there are no dependencies beyond googleapis.',
    });
  }
  ok(`node ${process.versions.node}`);

  step('Configuration');
  if (!usingFixture && !fs.existsSync(path.join(process.cwd(), '.env'))) {
    throw new UserError('No .env file in the current directory.', {
      hint: 'Run:\n  cp .env.example .env\nthen open .env and set SHEET_ID.',
    });
  }
  const config = loadConfig({ requireSheetId: !usingFixture });
  ok(usingFixture ? 'fixture mode: SHEET_ID not required' : `SHEET_ID set (${mask(config.sheetId)})`);
  info(`tab            ${config.tabName}`);
  info(`lookback       ${config.lookback}`);
  info(`label          ${config.processedLabel}`);
  info(`max messages   ${config.maxMessages}`);
  info(`max body chars ${config.maxBodyChars}`);
  info(`timezone       ${config.timezone}`);
  if (config.queryExtra) info(`query extra    ${config.queryExtra}`);

  if (usingFixture) {
    await fixtureChecks(flags, config);
    return;
  }

  step('Google credentials');
  readCredentials(config.credentialsPath);
  ok(`OAuth client at ${config.credentialsPath}`);
  info('scopes requested:');
  for (const scope of SCOPES) info(`  ${scope}`);

  step('Authorization');
  const hadToken = fs.existsSync(config.tokenPath);
  const auth = await getAuthClient(config, { interactive: true });
  ok(hadToken ? `token loaded from ${config.tokenPath}` : `token written to ${config.tokenPath}`);

  step('Gmail');
  const gmail = gmailClient(auth);
  try {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    ok(`authorized as ${profile.data.emailAddress} (${profile.data.messagesTotal} messages)`);
  } catch (err) {
    throw explainApiError(err, { config, api: 'Gmail' });
  }
  try {
    const labels = await gmail.users.labels.list({ userId: 'me' });
    const found = (labels.data.labels ?? []).find(
      (l) => String(l.name ?? '').toLowerCase() === config.processedLabel.toLowerCase()
    );
    if (found) ok(`label "${config.processedLabel}" exists`);
    else warn(`label "${config.processedLabel}" does not exist yet; it is created on the first commit`);
  } catch (err) {
    throw explainApiError(err, { config, api: 'Gmail' });
  }

  step('Spreadsheet');
  const sheets = sheetsClient(auth);
  let meta;
  try {
    meta = await listTabs(sheets, config.sheetId);
  } catch (err) {
    throw explainApiError(err, { config, api: 'Sheets' });
  }
  ok(`opened "${meta.title}"`);
  info(`tabs: ${meta.tabs.map((t) => (t === config.tabName ? `${t} <- SHEET_TAB_NAME` : t)).join(', ')}`);
  if (!meta.tabs.includes(config.tabName)) {
    throw new UserError(`The tab "${config.tabName}" is not in this spreadsheet.`, {
      hint: `Set SHEET_TAB_NAME in .env to one of: ${meta.tabs.join(', ')}`,
    });
  }

  let values;
  try {
    values = await readValues(sheets, config.sheetId, config.tabName);
  } catch (err) {
    throw explainApiError(err, { config, api: 'Sheets' });
  }

  reportShape(values, config.tabName);

  if (flags.migrate) {
    await runMigration({ values, tabName: config.tabName, sheets, spreadsheetId: config.sheetId });
  } else {
    const plan = planMigration(values, config.tabName);
    if (plan.conflicts.length > 0) {
      warn('migration would refuse to run:');
      for (const c of plan.conflicts) info(`  ${c}`);
    } else if (plan.needed) {
      warn(
        `migration pending: ${plan.headerWrites.length} header(s) and ${plan.cellWrites.length} backfill cell(s).`
      );
      info('run `npm run doctor -- --migrate` to apply it.');
    } else {
      ok('migration already applied (Status / Last Heard / Source present)');
    }
  }

  process.stdout.write('\nAll checks passed.\n');
}

async function fixtureChecks(flags, config) {
  const sheet = fixtureSheet(loadFixture(flags.fixture));
  step('Spreadsheet (fixture)');
  ok(`fixture "${sheet.title}"`);
  info(`tabs: ${sheet.tabs.join(', ')}`);
  reportShape(sheet.values, sheet.tab);

  const plan = planMigration(sheet.values, sheet.tab);
  step('Migration');
  if (plan.conflicts.length > 0) {
    warn('migration would refuse to run:');
    for (const c of plan.conflicts) info(`  ${c}`);
  } else if (plan.needed) {
    warn(`migration pending: ${plan.headerWrites.length} header(s), ${plan.cellWrites.length} backfill cell(s)`);
    for (const w of plan.headerWrites) info(`  ${w.range} = ${w.value}`);
    for (const w of plan.cellWrites.slice(0, 10)) info(`  ${w.range} = ${w.value}`);
    if (plan.cellWrites.length > 10) info(`  ... and ${plan.cellWrites.length - 10} more`);
  } else {
    ok('migration already applied');
  }
  if (flags.migrate) {
    step('Migration (fixture)');
    warn('fixture mode writes nothing. The plan above is what --migrate would do live.');
  }
  process.stdout.write('\nFixture checks passed.\n');
}

function reportShape(values, tabName) {
  const headerIdx = detectHeaderRow(values);
  if (headerIdx < 0) {
    throw new UserError(
      `No header row found in tab "${tabName}". Scanned the first 10 rows for one containing "Updated", "Role" and "Company".`,
      {
        hint:
          'Either SHEET_TAB_NAME names the wrong tab, or the header row is further down than row 10.\n' +
          'Fix the tab name in .env, or move the header up.',
      }
    );
  }
  const columns = columnsToLetters(buildColumns(values[headerIdx]));
  ok(`header row detected at row ${headerIdx + 1}`);
  info(`columns: ${Object.entries(columns).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  const payload = buildSheetPayload(values, tabName);
  info(`data rows: ${payload.rows.length} (starting at row ${headerIdx + 2})`);
}

async function runMigration({ values, tabName, sheets, spreadsheetId }) {
  step('Migration');
  const plan = planMigration(values, tabName);

  if (plan.conflicts.length > 0) {
    throw new UserError('Refusing to migrate: the target columns are already in use.', {
      hint:
        plan.conflicts.map((c) => `  - ${c}`).join('\n') +
        '\n\nMove or rename those columns, or point SHEET_TAB_NAME at the right tab.',
    });
  }

  if (!plan.needed) {
    ok('nothing to do: Status / Last Heard / Source are present and backfilled');
    return;
  }

  for (const w of plan.headerWrites) info(`header  ${w.range} = ${w.value}`);
  info(`backfill ${plan.cellWrites.length} cell(s): status=applied, source=manual, Last Heard left blank`);

  const writes = [...plan.headerWrites, ...plan.cellWrites].map(({ range, value }) => ({ range, value }));
  try {
    const count = await writeCells(sheets, spreadsheetId, writes);
    ok(`wrote ${count} cell(s)`);
  } catch (err) {
    throw explainApiError(err, { config: {}, api: 'Sheets' });
  }
  info(`columns now: ${Object.values(MIGRATION_HEADERS).join(', ')} added`);
  ok('re-running --migrate now is a no-op');
}

function mask(id) {
  if (!id) return '';
  return id.length <= 8 ? '***' : `${id.slice(0, 4)}...${id.slice(-4)}`;
}

main().catch(die);
