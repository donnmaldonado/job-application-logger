/**
 * commit.js is the only thing here that writes, so the payload gate gets
 * tested hard: a bad extraction must be refused, not repaired.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommitPayload, collectMessageIds } from '../src/schema.js';

const validAppend = {
  updated: '9/3',
  role: 'Analytics Engineer',
  company: 'Northwind Robotics',
  link: '',
  notes: '',
  status: 'confirmed',
  lastHeard: '9/3',
  messageIds: ['fixture0000000001'],
};

test('the documented payload validates', () => {
  const { valid, errors, payload } = validateCommitPayload({
    appends: [validAppend],
    updates: [{ row: 14, status: 'rejected', lastHeard: '9/3', messageIds: ['fixture0000000002'] }],
    labelOnly: ['fixture0000000005'],
  });
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
  assert.equal(payload.appends[0].company, 'Northwind Robotics');
  assert.equal(payload.updates[0].row, 14);
  assert.deepEqual(payload.labelOnly, ['fixture0000000005']);
});

test('an empty payload is valid and does nothing', () => {
  const { valid, payload } = validateCommitPayload({});
  assert.equal(valid, true);
  assert.deepEqual(payload, { appends: [], updates: [], labelOnly: [] });
});

test('non-objects are rejected', () => {
  for (const input of [null, 'nope', 42, ['a']]) {
    assert.equal(validateCommitPayload(input).valid, false);
  }
});

test('updates may only write status and lastHeard', () => {
  for (const key of ['updated', 'role', 'company', 'link', 'notes']) {
    const { valid, errors } = validateCommitPayload({
      updates: [{ row: 5, status: 'rejected', [key]: 'x' }],
    });
    assert.equal(valid, false, key);
    assert.match(errors[0], new RegExp(`may not set "${key}"`));
    assert.match(errors[0], /only ever write status and lastHeard/);
  }
});

test('an update must name a real row and change something', () => {
  assert.match(validateCommitPayload({ updates: [{ status: 'rejected' }] }).errors.join(), /row must be a positive integer/);
  assert.match(validateCommitPayload({ updates: [{ row: 0, status: 'rejected' }] }).errors.join(), /positive integer/);
  assert.match(validateCommitPayload({ updates: [{ row: 2.5, status: 'rejected' }] }).errors.join(), /positive integer/);
  assert.match(validateCommitPayload({ updates: [{ row: 5 }] }).errors.join(), /at least one of status or lastHeard/);
});

test('status is a closed set', () => {
  assert.equal(validateCommitPayload({ updates: [{ row: 5, status: 'ghosted' }] }).valid, false);
  for (const status of ['applied', 'confirmed', 'rejected', 'interview']) {
    assert.equal(validateCommitPayload({ updates: [{ row: 5, status }] }).valid, true, status);
  }
});

test('appends require updated, role, company and status', () => {
  const { errors } = validateCommitPayload({ appends: [{}] });
  assert.match(errors.join('\n'), /appends\[0\]\.updated is required/);
  assert.match(errors.join('\n'), /appends\[0\]\.role is required/);
  assert.match(errors.join('\n'), /appends\[0\]\.company is required/);
  assert.match(errors.join('\n'), /appends\[0\]\.status is required/);
});

test('an unresolved "?" never reaches the sheet', () => {
  const { valid, errors } = validateCommitPayload({
    appends: [{ ...validAppend, company: '?' }],
  });
  assert.equal(valid, false);
  assert.match(errors[0], /never resolved. Ask the user/);
});

test('unknown fields are refused rather than silently dropped', () => {
  assert.match(validateCommitPayload({ nope: 1 }).errors.join(), /unknown top-level field "nope"/);
  assert.match(
    validateCommitPayload({ appends: [{ ...validAppend, sheet: 'x' }] }).errors.join(),
    /appends\[0\] has unknown field "sheet"/
  );
  assert.match(
    validateCommitPayload({ updates: [{ row: 3, status: 'applied', foo: 1 }] }).errors.join(),
    /updates\[0\] has unknown field "foo"/
  );
});

test('message ids must be non-empty strings', () => {
  assert.match(validateCommitPayload({ labelOnly: [''] }).errors.join(), /labelOnly\[0\]/);
  assert.match(validateCommitPayload({ labelOnly: [17] }).errors.join(), /labelOnly\[0\]/);
  assert.match(
    validateCommitPayload({ appends: [{ ...validAppend, messageIds: 'abc' }] }).errors.join(),
    /messageIds must be an array/
  );
});

test('every error in a bad payload is reported at once', () => {
  const { errors } = validateCommitPayload({
    appends: [{ updated: '9/3' }],
    updates: [{ row: -1 }],
  });
  assert.ok(errors.length >= 5, `expected several errors, got ${errors.length}`);
});

test('collectMessageIds de-duplicates across all three sections', () => {
  const { payload } = validateCommitPayload({
    appends: [{ ...validAppend, messageIds: ['a', 'b'] }],
    updates: [{ row: 5, status: 'rejected', messageIds: ['b', 'c'] }],
    labelOnly: ['c', 'd'],
  });
  assert.deepEqual(collectMessageIds(payload), ['a', 'b', 'c', 'd']);
});
