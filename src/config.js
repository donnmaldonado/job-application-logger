/**
 * Environment loading and validation. This is the ONLY module that reads
 * process.env. It validates eagerly and throws errors written for a human at
 * a terminal: what is missing, what it is for, and how to fix it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * An error whose message is meant to be printed as-is to a user. Callers
 * print `err.message` (plus `err.hint`) and exit non-zero; they never print a
 * stack trace for these.
 */
export class UserError extends Error {
  constructor(message, { hint = '' } = {}) {
    super(message);
    this.name = 'UserError';
    this.hint = hint;
  }
}

/**
 * Where the two secret files live by default: outside the repository, in the
 * user's config directory. Keeping them out of the working tree means a
 * mistaken `git add -A` cannot commit a credential, and .gitignore is only a
 * second line of defence rather than the only one.
 */
export const CONFIG_DIR = '~/.config/job-application-logger';

const DEFAULTS = {
  SHEET_TAB_NAME: 'Sheet1',
  GOOGLE_CREDENTIALS_PATH: `${CONFIG_DIR}/credentials.json`,
  GOOGLE_TOKEN_PATH: `${CONFIG_DIR}/token.json`,
  GMAIL_LOOKBACK: '2d',
  GMAIL_PROCESSED_LABEL: 'logged-to-sheet',
  GMAIL_QUERY_EXTRA: '',
  MAX_MESSAGES: '50',
  MAX_BODY_CHARS: '2000',
  TIMEZONE: 'America/New_York',
};

/**
 * Load `.env` if it exists and the process was not already started with
 * --env-file. Safe to call more than once.
 */
export function loadEnvFile(cwd = process.cwd()) {
  const envPath = path.join(cwd, '.env');
  if (!fs.existsSync(envPath)) return false;
  try {
    process.loadEnvFile(envPath);
    return true;
  } catch {
    // Already loaded by --env-file, or unreadable. Validation below reports
    // anything that actually matters.
    return false;
  }
}

function envValue(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Expand a leading `~` to the home directory. `path.resolve` does not do this,
 * so without it a `.env` line pointing at `~/.config/...` would resolve to a
 * literal `~` directory inside the repository - which is exactly the mistake
 * this tool's documented layout invites.
 */
export function expandHome(p) {
  const value = String(p ?? '');
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function positiveInt(name, fallback) {
  const raw = envValue(name) ?? fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UserError(
      `${name} must be a positive whole number (got ${JSON.stringify(raw)}).`,
      { hint: `Edit .env and set ${name}=${fallback}, or remove the line to use the default.` }
    );
  }
  return parsed;
}

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the validated config object.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.requireSheetId] - false for fixture/offline runs.
 * @param {string} [opts.cwd]
 */
export function loadConfig({ requireSheetId = true, cwd = process.cwd() } = {}) {
  loadEnvFile(cwd);

  const sheetId = envValue('SHEET_ID');
  if (requireSheetId && !sheetId) {
    const hasEnvFile = fs.existsSync(path.join(cwd, '.env'));
    throw new UserError(
      'SHEET_ID is not set. It is the ID of the Google Sheet this tool writes to.',
      {
        hint: hasEnvFile
          ? 'Open .env and set SHEET_ID to the part of your spreadsheet URL between /d/ and /edit:\n' +
            '  https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit'
          : 'No .env file found. Run:\n' +
            '  cp .env.example .env\n' +
            'then set SHEET_ID to the part of your spreadsheet URL between /d/ and /edit:\n' +
            '  https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit',
      }
    );
  }

  const timezone = envValue('TIMEZONE') ?? DEFAULTS.TIMEZONE;
  if (!validTimezone(timezone)) {
    throw new UserError(`TIMEZONE is not a recognized IANA timezone: ${timezone}`, {
      hint: 'Use a name like America/New_York or Europe/Madrid.',
    });
  }

  const credentialsPath = path.resolve(
    cwd,
    expandHome(envValue('GOOGLE_CREDENTIALS_PATH') ?? DEFAULTS.GOOGLE_CREDENTIALS_PATH)
  );
  const tokenPath = path.resolve(
    cwd,
    expandHome(envValue('GOOGLE_TOKEN_PATH') ?? DEFAULTS.GOOGLE_TOKEN_PATH)
  );

  return {
    sheetId: sheetId ?? '',
    tabName: envValue('SHEET_TAB_NAME') ?? DEFAULTS.SHEET_TAB_NAME,
    credentialsPath,
    tokenPath,
    lookback: envValue('GMAIL_LOOKBACK') ?? DEFAULTS.GMAIL_LOOKBACK,
    processedLabel: envValue('GMAIL_PROCESSED_LABEL') ?? DEFAULTS.GMAIL_PROCESSED_LABEL,
    queryExtra: envValue('GMAIL_QUERY_EXTRA') ?? DEFAULTS.GMAIL_QUERY_EXTRA,
    maxMessages: positiveInt('MAX_MESSAGES', DEFAULTS.MAX_MESSAGES),
    maxBodyChars: positiveInt('MAX_BODY_CHARS', DEFAULTS.MAX_BODY_CHARS),
    timezone,
  };
}

/** Print a UserError the way a terminal user wants to read it, then exit. */
export function die(err, exitCode = 1) {
  if (err instanceof UserError) {
    process.stderr.write(`error: ${err.message}\n`);
    if (err.hint) process.stderr.write(`\n${err.hint}\n`);
  } else {
    process.stderr.write(`error: ${err?.message ?? String(err)}\n`);
    if (process.env.DEBUG) process.stderr.write(`\n${err?.stack ?? ''}\n`);
    else process.stderr.write('\nRe-run with DEBUG=1 for a stack trace.\n');
  }
  process.exit(exitCode);
}
