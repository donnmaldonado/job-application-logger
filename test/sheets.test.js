import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  columnLetter,
  quoteTab,
  detectHeaderRow,
  buildColumns,
  columnsToLetters,
  buildSheetPayload,
  publicSheetPayload,
  planMigration,
  buildAppendRow,
} from '../src/sheets.js';

const migrated = JSON.parse(fs.readFileSync(new URL('../fixtures/messages.sample.json', import.meta.url))).sheet;
const legacy = JSON.parse(fs.readFileSync(new URL('../fixtures/sheet.legacy.json', import.meta.url))).sheet;

test('columnLetter counts past Z', () => {
  assert.equal(columnLetter(0), 'A');
  assert.equal(columnLetter(5), 'F');
  assert.equal(columnLetter(25), 'Z');
  assert.equal(columnLetter(26), 'AA');
  assert.equal(columnLetter(27), 'AB');
  assert.equal(columnLetter(51), 'AZ');
  assert.throws(() => columnLetter(-1));
});

test('tab names with apostrophes are quoted for A1 ranges', () => {
  assert.equal(quoteTab('Sheet1'), "'Sheet1'");
  assert.equal(quoteTab("Alex's tab"), "'Alex''s tab'");
});

test('the header row is found below leading blank content', () => {
  assert.equal(detectHeaderRow(legacy.values), 2, 'header is on sheet row 3');
  assert.equal(detectHeaderRow(migrated.values), 2);
});

test('header detection is case-insensitive and tolerates whitespace', () => {
  assert.equal(detectHeaderRow([['  UPDATED ', 'Role', ' company']]), 0);
});

test('header detection needs all three of updated/role/company', () => {
  assert.equal(detectHeaderRow([['Updated', 'Role'], ['a', 'b']]), -1);
  assert.equal(detectHeaderRow([[], ['Company', 'Role']]), -1);
});

test('header detection gives up after 10 rows', () => {
  const values = Array.from({ length: 12 }, () => ['', '', '']);
  values[10] = ['Updated', 'Role', 'Company'];
  assert.equal(detectHeaderRow(values), -1);
  assert.equal(detectHeaderRow(values, 11), 10, 'and finds it if allowed to scan further');
});

test('missing header row is a readable error, not a crash', () => {
  assert.throws(() => buildSheetPayload([['nothing', 'here']], 'Sheet1'), (err) => {
    assert.match(err.message, /No header row found in tab "Sheet1"/);
    assert.match(err.hint, /SHEET_TAB_NAME/);
    return true;
  });
});

test('link and notes are the two unlabeled columns after company', () => {
  const cols = columnsToLetters(buildColumns(migrated.values[2]));
  assert.deepEqual(cols, {
    updated: 'A',
    role: 'B',
    company: 'C',
    link: 'D',
    notes: 'E',
    status: 'F',
    lastHeard: 'G',
    source: 'H',
  });
});

test('an unmigrated sheet reports only the columns it actually has', () => {
  const cols = columnsToLetters(buildColumns(legacy.values[2]));
  assert.deepEqual(cols, { updated: 'A', role: 'B', company: 'C', link: 'D', notes: 'E' });
});

test('"Last Heard" is matched by its various spellings', () => {
  for (const spelling of ['Last Heard', 'last heard', 'LastHeard', 'last_heard']) {
    const cols = buildColumns(['Updated', 'Role', 'Company', '', '', 'Status', spelling, 'Source']);
    assert.equal(cols.lastHeard, 6, spelling);
  }
});

test('rows carry 1-indexed sheet row numbers and skip blank rows', () => {
  const payload = buildSheetPayload(migrated.values, 'Applications');
  assert.equal(payload.headerRow, 3);
  assert.deepEqual(payload.rows.map((r) => r.row), [4, 5, 6, 8], 'row 7 is blank and is skipped');
  assert.deepEqual(payload.rows[0], {
    row: 4,
    updated: '8/24',
    role: 'Analytics Engineer',
    company: 'Northwind Robotics',
    status: 'applied',
    lastHeard: '',
    source: 'manual',
  });
});

test('the public payload hides the internal column indices', () => {
  const payload = publicSheetPayload(buildSheetPayload(migrated.values, 'Applications'));
  assert.deepEqual(Object.keys(payload), ['tab', 'headerRow', 'columns', 'rows']);
});

test('migration plans three headers and backfills existing rows', () => {
  const plan = planMigration(legacy.values, 'Applications');
  assert.equal(plan.needed, true);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(
    plan.headerWrites.map((w) => [w.range, w.value]),
    [
      ["'Applications'!F3", 'Status'],
      ["'Applications'!G3", 'Last Heard'],
      ["'Applications'!H3", 'Source'],
    ]
  );
  // 4 data rows x {status, source}; Last Heard is left blank on purpose.
  assert.equal(plan.cellWrites.length, 8);
  assert.deepEqual(
    plan.cellWrites.filter((w) => w.row === 4).map((w) => [w.range, w.value]),
    [
      ["'Applications'!F4", 'applied'],
      ["'Applications'!H4", 'manual'],
    ]
  );
  assert.ok(!plan.cellWrites.some((w) => w.range.includes('!G')), 'Last Heard stays blank');
  assert.ok(!plan.cellWrites.some((w) => w.row === 7), 'the blank row is not backfilled');
});

test('migration is idempotent: a migrated sheet needs nothing', () => {
  const plan = planMigration(migrated.values, 'Applications');
  assert.equal(plan.needed, false);
  assert.deepEqual(plan.headerWrites, []);
  assert.deepEqual(plan.cellWrites, []);
});

test('applying the plan once makes the second run a no-op', () => {
  const values = legacy.values.map((row) => [...row]);
  const plan = planMigration(values, 'Applications');
  for (const write of [...plan.headerWrites, ...plan.cellWrites]) {
    const match = write.range.match(/!([A-Z]+)(\d+)$/);
    const col = match[1].charCodeAt(0) - 65;
    const row = Number(match[2]) - 1;
    while (values[row].length <= col) values[row].push('');
    values[row][col] = write.value;
  }
  assert.equal(planMigration(values, 'Applications').needed, false);
});

test('a partially migrated sheet only fills in what is missing', () => {
  const values = legacy.values.map((row) => [...row]);
  values[2] = ['Updated', 'Role', 'Company', '', '', 'Status'];
  values[3] = ['8/24', 'Analytics Engineer', 'Northwind Robotics', '', '', 'confirmed'];
  const plan = planMigration(values, 'Applications');
  assert.deepEqual(plan.headerWrites.map((w) => w.value), ['Last Heard', 'Source']);
  assert.ok(!plan.cellWrites.some((w) => w.range === "'Applications'!F4"), 'existing status is kept');
  assert.ok(plan.cellWrites.some((w) => w.range === "'Applications'!F5" && w.value === 'applied'));
});

test('migration refuses when the target header is already something else', () => {
  const values = legacy.values.map((row) => [...row]);
  values[2] = ['Updated', 'Role', 'Company', '', '', 'Salary'];
  const plan = planMigration(values, 'Applications');
  assert.equal(plan.needed, false);
  assert.match(plan.conflicts[0], /column F is already headed "Salary", expected "Status"/);
  assert.deepEqual(plan.cellWrites, [], 'nothing is backfilled when there is a conflict');
});

test('migration refuses to plant a header over an unlabeled column that holds data', () => {
  const values = legacy.values.map((row) => [...row]);
  values[3] = ['8/24', 'Analytics Engineer', 'Northwind Robotics', '', '', 'do not clobber me'];
  const plan = planMigration(values, 'Applications');
  assert.equal(plan.needed, false);
  assert.match(plan.conflicts[0], /column F has no header but contains data \(row 4\)/);
});

test('append rows are positioned by column index and always marked auto', () => {
  const indices = buildSheetPayload(migrated.values, 'Applications').indices;
  const row = buildAppendRow(
    {
      updated: '9/3',
      role: 'Analytics Engineer',
      company: 'Ramp Robotics',
      link: '',
      notes: '',
      status: 'confirmed',
      lastHeard: '9/3',
    },
    indices
  );
  assert.deepEqual(row, ['9/3', 'Analytics Engineer', 'Ramp Robotics', '', '', 'confirmed', '9/3', 'auto']);
});

test('append rows ignore a caller-supplied source: it is always auto', () => {
  const indices = buildSheetPayload(migrated.values, 'Applications').indices;
  const row = buildAppendRow({ updated: '9/3', role: 'r', company: 'c', status: 'applied', source: 'manual' }, indices);
  assert.equal(row[7], 'auto');
});
