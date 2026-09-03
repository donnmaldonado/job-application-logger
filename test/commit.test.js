/**
 * The core invariant: a message carries the processed label if and only if
 * its content reached the sheet. commit.js owns both halves for that reason,
 * so the ordering and the partial-failure reporting are tested here with an
 * injected io - no credentials, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { executeCommit, buildPlan, preflightErrors } from '../bin/commit.js';
import { validateCommitPayload } from '../src/schema.js';
import { buildSheetPayload } from '../src/sheets.js';

const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/messages.sample.json', import.meta.url)));
const legacy = JSON.parse(fs.readFileSync(new URL('../fixtures/sheet.legacy.json', import.meta.url)));

function makeIo(calls, { failAppend = false, failCells = false, failLabel = false } = {}) {
  return {
    appendRows: async (rows) => {
      calls.push(['appendRows', rows.length]);
      if (failAppend) throw new Error('quota exceeded');
      return rows.length;
    },
    writeCells: async (cells) => {
      calls.push(['writeCells', cells.length]);
      if (failCells) throw new Error('range not found');
      return cells.length;
    },
    label: async (ids) => {
      calls.push(['label', [...ids]]);
      if (failLabel) throw new Error('Gmail is having a day');
      return ids.length;
    },
  };
}

function planFor(input, sheetSource = fixture.sheet) {
  const { valid, errors, payload } = validateCommitPayload(input);
  assert.equal(valid, true, errors.join('\n'));
  const sheet = buildSheetPayload(sheetSource.values, sheetSource.tab);
  return { payload, sheet, plan: buildPlan(sheet, payload, sheetSource.tab) };
}

const FULL_PAYLOAD = {
  appends: [
    {
      updated: '9/3',
      role: 'Analytics Engineer',
      company: 'Ramp Robotics',
      status: 'confirmed',
      lastHeard: '9/3',
      messageIds: ['msg-append'],
    },
  ],
  updates: [{ row: 5, status: 'rejected', lastHeard: '9/3', messageIds: ['msg-update'] }],
  labelOnly: ['msg-irrelevant'],
};

test('the sheet is written before anything is labeled', async () => {
  const { payload, plan } = planFor(FULL_PAYLOAD);
  const calls = [];
  const result = await executeCommit({ plan, payload, io: makeIo(calls) });

  assert.deepEqual(calls.map((c) => c[0]), ['appendRows', 'writeCells', 'label']);
  assert.deepEqual(result, {
    appended: 1,
    updated: 1,
    labeled: 3,
    errors: [],
    unlabeled: [],
  });
  assert.deepEqual(calls[2][1], ['msg-append', 'msg-update', 'msg-irrelevant']);
});

test('when the append fails, its message is not labeled', async () => {
  const { payload, plan } = planFor(FULL_PAYLOAD);
  const calls = [];
  const result = await executeCommit({ plan, payload, io: makeIo(calls, { failAppend: true }) });

  assert.equal(result.appended, 0);
  assert.equal(result.updated, 1);
  assert.match(result.errors[0], /appending rows failed: quota exceeded/);
  const labeled = calls.find((c) => c[0] === 'label')[1];
  assert.ok(!labeled.includes('msg-append'), 'an unwritten row must stay unlabeled so it resurfaces');
  assert.ok(labeled.includes('msg-update'));
});

test('when the update fails, its message is not labeled', async () => {
  const { payload, plan } = planFor(FULL_PAYLOAD);
  const calls = [];
  const result = await executeCommit({ plan, payload, io: makeIo(calls, { failCells: true }) });

  assert.equal(result.appended, 1);
  assert.equal(result.updated, 0);
  assert.match(result.errors[0], /updating rows failed: range not found/);
  const labeled = calls.find((c) => c[0] === 'label')[1];
  assert.deepEqual(labeled, ['msg-append', 'msg-irrelevant']);
});

test('a write that succeeds and a label that fails is reported in unlabeled', async () => {
  const { payload, plan } = planFor(FULL_PAYLOAD);
  const calls = [];
  const result = await executeCommit({ plan, payload, io: makeIo(calls, { failLabel: true }) });

  assert.equal(result.appended, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.labeled, 0);
  assert.deepEqual(result.unlabeled, ['msg-append', 'msg-update', 'msg-irrelevant']);
  assert.match(result.errors[0], /sheet write succeeded but labeling failed/);
  assert.match(result.errors[0], /resurface next run and duplicate/);
});

test('irrelevant messages are labeled even when the sheet write fails', async () => {
  const { payload, plan } = planFor(FULL_PAYLOAD);
  const calls = [];
  await executeCommit({ plan, payload, io: makeIo(calls, { failAppend: true, failCells: true }) });
  assert.deepEqual(calls.find((c) => c[0] === 'label')[1], ['msg-irrelevant']);
});

test('a label-only payload never touches the sheet', async () => {
  const { payload, plan } = planFor({ labelOnly: ['a', 'b'] });
  const calls = [];
  const result = await executeCommit({ plan, payload, io: makeIo(calls) });
  assert.deepEqual(calls.map((c) => c[0]), ['label']);
  assert.equal(result.labeled, 2);
});

test('an empty payload calls nothing at all', async () => {
  const { payload, plan } = planFor({});
  const calls = [];
  const result = await executeCommit({ plan, payload, io: makeIo(calls) });
  assert.deepEqual(calls, []);
  assert.deepEqual(result, { appended: 0, updated: 0, labeled: 0, errors: [], unlabeled: [] });
});

test('duplicate message ids across sections are labeled once', async () => {
  const { payload, plan } = planFor({
    appends: [{ updated: '9/3', role: 'r', company: 'c', status: 'applied', messageIds: ['dup'] }],
    labelOnly: ['dup'],
  });
  const calls = [];
  const result = await executeCommit({ plan, payload, io: makeIo(calls) });
  assert.deepEqual(calls.find((c) => c[0] === 'label')[1], ['dup']);
  assert.equal(result.labeled, 1);
});

test('updates address the Status and Last Heard cells only', () => {
  const { plan } = planFor(FULL_PAYLOAD);
  assert.deepEqual(plan.updateCells, [
    { range: "'Applications'!F5", value: 'rejected' },
    { range: "'Applications'!G5", value: '9/3' },
  ]);
  assert.ok(
    plan.updateCells.every((c) => /![FG]\d+$/.test(c.range)),
    'no update may touch columns A-E'
  );
});

test('an update to a row that does not exist is refused before any write', () => {
  const { payload, sheet } = planFor({ updates: [{ row: 900, status: 'rejected' }] });
  const errors = preflightErrors(sheet, payload, fixture.sheet.values);
  assert.match(errors[0], /only has 8 rows/);
});

test('an update aimed at the header row or above is refused', () => {
  for (const row of [1, 2, 3]) {
    const { payload, sheet } = planFor({ updates: [{ row, status: 'rejected' }] });
    const errors = preflightErrors(sheet, payload, fixture.sheet.values);
    assert.match(errors[0], /header row/, `row ${row}`);
  }
});

test('writing to an unmigrated sheet is refused with the fix', () => {
  const { payload, sheet } = planFor(
    { appends: [{ updated: '9/3', role: 'r', company: 'c', status: 'applied' }] },
    legacy.sheet
  );
  const errors = preflightErrors(sheet, payload, legacy.sheet.values);
  assert.match(errors[0], /missing the status, lastHeard, source column\(s\)/);
  assert.match(errors[0], /doctor -- --migrate/);
});

test('label-only work is allowed on an unmigrated sheet', () => {
  const { payload, sheet } = planFor({ labelOnly: ['x'] }, legacy.sheet);
  assert.deepEqual(preflightErrors(sheet, payload, legacy.sheet.values), []);
});
