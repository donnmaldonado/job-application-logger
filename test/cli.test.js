/**
 * End-to-end runs of the four commands in --fixture mode: the JSON contracts
 * the skill depends on, the exit codes, and the promise that --dry-run
 * touches nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SAMPLE = 'fixtures/messages.sample.json';
const LEGACY = 'fixtures/sheet.legacy.json';

function run(script, args = [], stdin = '') {
  return spawnSync(process.execPath, [`bin/${script}`, ...args], {
    cwd: root,
    input: stdin,
    encoding: 'utf8',
  });
}

function runJson(script, args, stdin) {
  const res = run(script, args, stdin);
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    assert.fail(`${script} did not print JSON.\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  }
  return { ...res, json: parsed };
}

function hashOf(relPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(new URL(`../${relPath}`, import.meta.url))).digest('hex');
}

test('fetch --fixture emits the documented contract', () => {
  const { status, json } = runJson('fetch.js', ['--fixture', SAMPLE]);
  assert.equal(status, 0);
  assert.deepEqual(Object.keys(json), ['query', 'fetchedAt', 'count', 'truncated', 'messages']);
  assert.equal(json.query, 'newer_than:2d -label:logged-to-sheet');
  assert.equal(json.count, 6);
  assert.equal(json.truncated, false);
  assert.ok(!Number.isNaN(Date.parse(json.fetchedAt)));
  for (const msg of json.messages) {
    assert.deepEqual(Object.keys(msg), [
      'id', 'threadId', 'date', 'from', 'fromName', 'subject', 'snippet', 'body',
    ]);
    assert.ok(msg.body.length > 0, `${msg.id} produced an empty body`);
    assert.doesNotMatch(msg.body, /<\/?[a-z]+[ >]/i, `${msg.id} leaked HTML`);
  }
});

test('fetch --since overrides the default window', () => {
  const { json } = runJson('fetch.js', ['--fixture', SAMPLE, '--since', '7d']);
  assert.equal(json.query, 'newer_than:7d -label:logged-to-sheet');
});

test('fetch --max caps the batch and reports truncation', () => {
  const { json } = runJson('fetch.js', ['--fixture', SAMPLE, '--max', '2']);
  assert.equal(json.count, 2);
  assert.equal(json.truncated, true);
});

test('fetch rejects a bad duration without a stack trace', () => {
  const res = run('fetch.js', ['--fixture', SAMPLE, '--since', 'yesterday']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Gmail duration syntax/);
  assert.doesNotMatch(res.stderr, /at Object\.|at async/);
});

test('read-sheet --fixture emits the documented contract', () => {
  const { status, json } = runJson('read-sheet.js', ['--fixture', SAMPLE]);
  assert.equal(status, 0);
  assert.deepEqual(Object.keys(json), ['tab', 'headerRow', 'columns', 'rows']);
  assert.equal(json.headerRow, 3);
  assert.equal(json.columns.status, 'F');
  assert.deepEqual(json.rows.map((r) => r.row), [4, 5, 6, 8]);
});

test('commit --fixture is a dry run that changes nothing on disk', () => {
  const before = hashOf(SAMPLE);
  const payload = JSON.stringify({
    appends: [
      {
        updated: '9/3',
        role: 'Analytics Engineer',
        company: 'Ramp Robotics',
        link: '',
        notes: '',
        status: 'confirmed',
        lastHeard: '9/3',
        messageIds: ['fixture0000000001'],
      },
    ],
    updates: [{ row: 5, status: 'rejected', lastHeard: '9/3', messageIds: ['fixture0000000002'] }],
    labelOnly: ['fixture0000000005'],
  });

  const { status, json } = runJson('commit.js', ['--fixture', SAMPLE], payload);
  assert.equal(status, 0);
  assert.equal(json.dryRun, true);
  assert.equal(json.appended, 1);
  assert.equal(json.updated, 1);
  assert.equal(json.labeled, 3);
  assert.deepEqual(json.errors, []);
  assert.deepEqual(json.unlabeled, []);
  assert.deepEqual(json.plan.appendRows, [
    ['9/3', 'Analytics Engineer', 'Ramp Robotics', '', '', 'confirmed', '9/3', 'auto'],
  ]);
  assert.deepEqual(json.plan.updateCells, [
    { range: "'Applications'!F5", value: 'rejected' },
    { range: "'Applications'!G5", value: '9/3' },
  ]);
  assert.equal(hashOf(SAMPLE), before, 'a dry run must not modify anything');
});

test('commit reports every field of its output contract', () => {
  const { json } = runJson('commit.js', ['--fixture', SAMPLE], '{"labelOnly":["a"]}');
  for (const key of ['appended', 'updated', 'labeled', 'errors', 'unlabeled']) {
    assert.ok(key in json, `missing ${key}`);
  }
});

test('commit rejects an invalid payload with exit code 2 and no writes', () => {
  const { status, json } = runJson(
    'commit.js',
    ['--fixture', SAMPLE],
    '{"updates":[{"row":5,"company":"Nope","status":"rejected"}]}'
  );
  assert.equal(status, 2);
  assert.equal(json.appended, 0);
  assert.match(json.errors[0], /only ever write status and lastHeard/);
});

test('commit rejects malformed JSON with exit code 2', () => {
  const { status, json } = runJson('commit.js', ['--fixture', SAMPLE], '{nope');
  assert.equal(status, 2);
  assert.match(json.errors[0], /stdin is not valid JSON/);
});

test('commit refuses to write to an unmigrated sheet', () => {
  const { status, json } = runJson(
    'commit.js',
    ['--fixture', LEGACY],
    '{"appends":[{"updated":"9/3","role":"r","company":"c","status":"applied"}]}'
  );
  assert.equal(status, 2);
  assert.match(json.errors[0], /doctor -- --migrate/);
});

test('doctor --fixture reports the pending migration on a legacy sheet', () => {
  const res = run('doctor.js', ['--fixture', LEGACY]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /header row detected at row 3/);
  assert.match(res.stdout, /migration pending: 3 header\(s\), 8 backfill cell\(s\)/);
  assert.match(res.stdout, /'Applications'!F3 = Status/);
});

test('doctor --fixture --migrate still writes nothing', () => {
  const before = hashOf(LEGACY);
  const res = run('doctor.js', ['--fixture', LEGACY, '--migrate']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /fixture mode writes nothing/);
  assert.equal(hashOf(LEGACY), before);
});

test('doctor --fixture on a migrated sheet reports nothing to do', () => {
  const res = run('doctor.js', ['--fixture', SAMPLE]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /migration already applied/);
});

test('every command has --help', () => {
  for (const script of ['doctor.js', 'fetch.js', 'read-sheet.js', 'commit.js']) {
    const res = run(script, ['--help']);
    assert.equal(res.status, 0, script);
    assert.match(res.stdout, /--fixture/, script);
  }
});

/** The git-ignored files that may hold real secrets. Never opened by a test. */
function isLocalSecret(name) {
  const base = name.split('/').pop();
  if (base === '.env.example') return false;
  return (
    base === '.env' ||
    base.startsWith('.env.') ||
    base === 'credentials.json' ||
    base === 'token.json' ||
    base.startsWith('client_secret') ||
    base.endsWith('.local.json')
  );
}

/** Every file in the repo except the ones git never sees. */
function repoFiles(dir = root, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const full = `${dir}${entry.name}${entry.isDirectory() ? '/' : ''}`;
    if (entry.isDirectory()) repoFiles(full, out);
    else out.push(full);
  }
  return out;
}

test('the repository carries no real email addresses or secrets', () => {
  const addressPattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  // The one exception: HANDOFF.md's example contract quotes an ATS vendor's
  // public no-reply address. It belongs to no person and identifies no user.
  const allowed = new Set(['no-reply@greenhouse.io']);

  for (const file of repoFiles()) {
    const name = file.slice(root.length);
    // Git-ignored local secrets and binaries are never read by this test.
    if (isLocalSecret(name) || name.endsWith('.DS_Store')) continue;

    const text = fs.readFileSync(file, 'utf8');
    for (const address of text.match(addressPattern) ?? []) {
      assert.ok(
        address.endsWith('example.com') || address.endsWith('example.org') || allowed.has(address),
        `${name} contains a non-example address: ${address}`
      );
    }
    assert.doesNotMatch(
      text,
      /\/(Users|home)\/[a-z][a-z0-9._-]*\//i,
      `${name} contains an absolute path into someone's home directory`
    );
  }

  const gitignore = fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  for (const pattern of ['.env', '.env.*', '!.env.example', 'credentials.json', 'token.json', 'client_secret*.json', '*.local.json']) {
    assert.ok(
      gitignore.split('\n').some((line) => line.trim() === pattern),
      `.gitignore must contain the line "${pattern}"`
    );
  }
  assert.match(fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8'), /^SHEET_ID=$/m,
    '.env.example must not carry a real spreadsheet id');
});
