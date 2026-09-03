#!/usr/bin/env node
/**
 * read-sheet.js - Google Sheet -> JSON on stdout.
 *
 * Emits 1-indexed sheet row numbers so commit.js can address rows directly.
 * That row number is the reason this cannot be replaced by a generic Drive
 * reader: a status update needs to know which physical row to touch.
 */
import { parseArgs } from 'node:util';
import { loadConfig, die } from '../src/config.js';
import { getAuthClient, sheetsClient, explainApiError } from '../src/auth.js';
import { loadFixture, fixtureSheet } from '../src/fixture.js';
import { readValues, buildSheetPayload, publicSheetPayload } from '../src/sheets.js';

const USAGE = `Usage: npm run sheet -- [options]

  --tab <name>       Tab to read (default: SHEET_TAB_NAME)
  --fixture <path>   Read sheet values from a fixture file; no network, no credentials
  --pretty           Indent the JSON output
  --help
`;

async function main() {
  const { values: flags } = parseArgs({
    options: {
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
  const config = loadConfig({ requireSheetId: !usingFixture });

  let tab;
  let values;

  if (usingFixture) {
    const sheet = fixtureSheet(loadFixture(flags.fixture));
    tab = flags.tab ?? sheet.tab;
    values = sheet.values;
  } else {
    tab = flags.tab ?? config.tabName;
    const auth = await getAuthClient(config, { interactive: false });
    const sheets = sheetsClient(auth);
    try {
      values = await readValues(sheets, config.sheetId, tab);
    } catch (err) {
      throw explainApiError(err, { config, api: 'Sheets' });
    }
  }

  const payload = buildSheetPayload(values, tab);
  process.stdout.write(
    JSON.stringify(publicSheetPayload(payload), null, flags.pretty ? 2 : 0) + '\n'
  );
}

main().catch(die);
