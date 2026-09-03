/**
 * Offline input. Every command accepts `--fixture <path>` so parsing, sheet
 * shape handling, and payload validation can be exercised with no network and
 * no credentials - which is the only way this repo can be tested before the
 * Google Cloud setup exists.
 *
 * A fixture file is a single JSON object:
 *   {
 *     "messages": [ <raw Gmail users.messages.get resources> ],
 *     "resultSizeEstimate": 7,          // optional, drives `truncated`
 *     "sheet": { "tab": "Sheet1", "tabs": ["Sheet1"], "values": [[...], ...] }
 *   }
 */
import fs from 'node:fs';
import path from 'node:path';
import { UserError } from './config.js';

export function loadFixture(fixturePath) {
  const resolved = path.resolve(process.cwd(), fixturePath);
  if (!fs.existsSync(resolved)) {
    throw new UserError(`Fixture file not found: ${resolved}`, {
      hint: 'Try --fixture fixtures/messages.sample.json',
    });
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('top level must be a JSON object');
    }
    return parsed;
  } catch (err) {
    throw new UserError(`Fixture file ${resolved} is not usable: ${err.message}`);
  }
}

export function fixtureMessages(fixture) {
  const messages = fixture.messages;
  if (!Array.isArray(messages)) {
    throw new UserError('Fixture has no "messages" array.', {
      hint: 'It should hold raw Gmail message resources, as fixtures/messages.sample.json does.',
    });
  }
  return messages;
}

export function fixtureSheet(fixture) {
  const sheet = fixture.sheet;
  if (!sheet || !Array.isArray(sheet.values)) {
    throw new UserError('Fixture has no "sheet.values" 2D array.', {
      hint: 'See fixtures/messages.sample.json for the shape.',
    });
  }
  return {
    tab: sheet.tab ?? 'Sheet1',
    tabs: Array.isArray(sheet.tabs) ? sheet.tabs : [sheet.tab ?? 'Sheet1'],
    values: sheet.values,
    title: sheet.title ?? '(fixture spreadsheet)',
  };
}
