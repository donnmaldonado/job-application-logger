import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, expandHome, CONFIG_DIR } from '../src/config.js';
import { writeToken } from '../src/auth.js';

const MANAGED = [
  'SHEET_ID',
  'SHEET_TAB_NAME',
  'GOOGLE_CREDENTIALS_PATH',
  'GOOGLE_TOKEN_PATH',
  'GMAIL_LOOKBACK',
  'GMAIL_PROCESSED_LABEL',
  'GMAIL_QUERY_EXTRA',
  'MAX_MESSAGES',
  'MAX_BODY_CHARS',
  'TIMEZONE',
];

/** Run `fn` with a clean environment and a cwd that holds no .env file. */
function withCleanEnv(env, fn) {
  const saved = Object.fromEntries(MANAGED.map((k) => [k, process.env[k]]));
  for (const key of MANAGED) delete process.env[key];
  Object.assign(process.env, env);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jal-config-'));
  try {
    return fn(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    for (const key of MANAGED) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

test('a leading ~ expands to the home directory, not a literal ~ folder', () => {
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('~/.config/x/y.json'), path.join(os.homedir(), '.config/x/y.json'));
  assert.equal(expandHome('./credentials.json'), './credentials.json');
  assert.equal(expandHome('/abs/credentials.json'), '/abs/credentials.json');
  assert.equal(expandHome('~notahome/x'), '~notahome/x');
});

test('the credential and token defaults live outside the repository', () => {
  const config = withCleanEnv({ SHEET_ID: 'sheet-id' }, (cwd) => loadConfig({ cwd }));
  const configDir = path.join(os.homedir(), '.config', 'job-application-logger');
  assert.equal(config.credentialsPath, path.join(configDir, 'credentials.json'));
  assert.equal(config.tokenPath, path.join(configDir, 'token.json'));
  assert.equal(CONFIG_DIR, '~/.config/job-application-logger');
});

test('a ~ path in the environment resolves under $HOME, not under the repo', () => {
  const config = withCleanEnv(
    { SHEET_ID: 'sheet-id', GOOGLE_TOKEN_PATH: '~/.config/job-application-logger/token.json' },
    (cwd) => loadConfig({ cwd })
  );
  assert.equal(
    config.tokenPath,
    path.join(os.homedir(), '.config/job-application-logger/token.json')
  );
  assert.doesNotMatch(config.tokenPath, /~/);
});

test('the documented defaults are the defaults', () => {
  const config = withCleanEnv({ SHEET_ID: 'sheet-id' }, (cwd) => loadConfig({ cwd }));
  assert.equal(config.tabName, 'Sheet1');
  assert.equal(config.lookback, '2d');
  assert.equal(config.processedLabel, 'logged-to-sheet');
  assert.equal(config.queryExtra, '');
  assert.equal(config.maxMessages, 50);
  assert.equal(config.maxBodyChars, 2000);
  assert.equal(config.timezone, 'America/New_York');
});

test('a missing SHEET_ID is a readable error, and fixture runs do not need one', () => {
  withCleanEnv({}, (cwd) => {
    assert.throws(() => loadConfig({ cwd }), /SHEET_ID is not set/);
    const config = loadConfig({ cwd, requireSheetId: false });
    assert.equal(config.sheetId, '');
  });
});

test('MAX_MESSAGES and TIMEZONE are validated, not silently coerced', () => {
  withCleanEnv({ SHEET_ID: 'x', MAX_MESSAGES: 'lots' }, (cwd) => {
    assert.throws(() => loadConfig({ cwd }), /MAX_MESSAGES must be a positive whole number/);
  });
  withCleanEnv({ SHEET_ID: 'x', TIMEZONE: 'Mars/Olympus' }, (cwd) => {
    assert.throws(() => loadConfig({ cwd }), /not a recognized IANA timezone/);
  });
});

test('the token is written 0600 into a directory that need not exist yet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jal-token-'));
  try {
    const tokenPath = path.join(dir, 'nested', 'token.json');
    writeToken(tokenPath, { refresh_token: 'not-a-real-token' });
    assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(tokenPath, 'utf8')), {
      refresh_token: 'not-a-real-token',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
