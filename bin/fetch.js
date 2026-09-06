#!/usr/bin/env node
/** fetch.js - Gmail search -> JSON on stdout. No judgment here; this is a pipe. */
import { parseArgs } from 'node:util';
import { loadConfig, die, UserError } from '../src/config.js';
import { getAuthClient, gmailClient, explainApiError } from '../src/auth.js';
import { loadFixture, fixtureMessages } from '../src/fixture.js';
import {
  buildQuery,
  assertDuration,
  normalizeMessage,
  searchMessages,
  getMessage,
} from '../src/gmail.js';

const USAGE = `Usage: npm run fetch -- [options]

  --since <duration>   Gmail duration to look back (default: GMAIL_LOOKBACK, e.g. 2d)
  --max <n>            Cap on messages pulled (default: MAX_MESSAGES)
  --query-extra <q>    Extra Gmail search terms ANDed onto the query
  --fixture <path>     Read messages from a fixture file; no network, no credentials
  --pretty             Indent the JSON output
  --help
`;

async function main() {
  const { values: flags } = parseArgs({
    options: {
      since: { type: 'string' },
      max: { type: 'string' },
      'query-extra': { type: 'string' },
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

  const since = assertDuration(flags.since ?? config.lookback);
  const maxMessages = flags.max ? positiveInt(flags.max, '--max') : config.maxMessages;
  const query = buildQuery({
    since,
    processedLabel: config.processedLabel,
    extra: flags['query-extra'] ?? config.queryExtra,
  });

  const { messages, truncated } = usingFixture
    ? fromFixture(flags.fixture, config, maxMessages)
    : await fromGmail(config, query, maxMessages);

  const output = {
    query,
    fetchedAt: new Date().toISOString(),
    count: messages.length,
    truncated,
    messages,
  };
  process.stdout.write(JSON.stringify(output, null, flags.pretty ? 2 : 0) + '\n');
}

function positiveInt(raw, flag) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UserError(`${flag} must be a positive whole number (got ${JSON.stringify(raw)}).`);
  }
  return n;
}

function fromFixture(fixturePath, config, maxMessages) {
  const fixture = loadFixture(fixturePath);
  const raw = fixtureMessages(fixture);
  const capped = raw.slice(0, maxMessages);
  return {
    messages: capped.map((m) => normalizeMessage(m, { maxBodyChars: config.maxBodyChars })),
    truncated:
      raw.length > maxMessages ||
      (Number.isFinite(fixture.resultSizeEstimate) && fixture.resultSizeEstimate > maxMessages),
  };
}

async function fromGmail(config, query, maxMessages) {
  const auth = await getAuthClient(config, { interactive: false });
  const gmail = gmailClient(auth);

  let found;
  try {
    found = await searchMessages(gmail, { query, maxMessages });
  } catch (err) {
    throw explainApiError(err, { config, api: 'Gmail' });
  }

  const messages = [];
  for (const id of found.ids) {
    try {
      const raw = await getMessage(gmail, id);
      messages.push(normalizeMessage(raw, { maxBodyChars: config.maxBodyChars }));
    } catch (err) {
      throw explainApiError(err, { config, api: 'Gmail' });
    }
  }
  return { messages, truncated: found.truncated };
}

main().catch(die);
