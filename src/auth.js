/**
 * OAuth: credential loading, the one-time loopback consent flow, token cache,
 * and construction of the Gmail and Sheets clients.
 *
 * Scopes are deliberately minimal and are documented in the README:
 *   gmail.modify  - read message bodies and apply the processed label.
 *   spreadsheets  - append rows and update status cells.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { google } from 'googleapis';
import { UserError } from './config.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/spreadsheets',
];

const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;

export function readCredentials(credentialsPath) {
  if (!fs.existsSync(credentialsPath)) {
    throw new UserError(`OAuth client file not found at ${credentialsPath}`, {
      hint:
        'Create one (this is the one-time Google Cloud setup):\n' +
        '  1. console.cloud.google.com -> create or pick a project\n' +
        '  2. Enable the Gmail API and the Google Sheets API\n' +
        '  3. OAuth consent screen -> External -> add your own account as a test user\n' +
        '  4. Credentials -> Create credentials -> OAuth client ID -> Desktop app\n' +
        `  5. Download the JSON and save it as ${credentialsPath}\n` +
        `     (create the directory first: mkdir -p ${path.dirname(credentialsPath)})\n` +
        'Keep it outside the repository so it can never be committed.\n' +
        'The README walks through this in full.',
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  } catch (err) {
    throw new UserError(`${credentialsPath} is not valid JSON: ${err.message}`, {
      hint: 'Re-download the OAuth client JSON from Google Cloud Console.',
    });
  }

  const block = parsed.installed ?? parsed.web;
  if (!block?.client_id || !block?.client_secret) {
    throw new UserError(`${credentialsPath} does not look like an OAuth client file.`, {
      hint:
        'It should contain an "installed" (Desktop app) block with client_id and client_secret.\n' +
        'A service-account key will not work: this tool acts as you, on your own mailbox.',
    });
  }
  return { clientId: block.client_id, clientSecret: block.client_secret };
}

function readToken(tokenPath) {
  if (!fs.existsSync(tokenPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  } catch {
    return null;
  }
}

export function writeToken(tokenPath, tokens) {
  // The token lives outside the repository by default, so its directory may
  // not exist yet on a first run.
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
}

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* the URL is printed too; a failed auto-open is not fatal */
  }
}

/** Run the loopback consent flow and return the granted tokens. */
async function runConsentFlow({ clientId, clientSecret }) {
  const { server, port } = await listenOnFreePort();
  const redirectUri = `http://localhost:${port}`;
  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  process.stderr.write(
    '\nAuthorization needed. A browser window should open.\n' +
      'If it does not, open this URL yourself:\n\n' +
      `${authUrl}\n\n` +
      'Google will warn that the app is unverified - that is expected for a\n' +
      'single-user desktop client. Choose your own account.\n\n'
  );
  openBrowser(authUrl);

  const code = await waitForCode(server);
  server.close();

  try {
    const { tokens } = await client.getToken(code);
    return tokens;
  } catch (err) {
    throw new UserError(`Could not exchange the authorization code: ${describe(err)}`, {
      hint: 'Run `npm run doctor` again to restart the consent flow.',
    });
  }
}

function listenOnFreePort() {
  return new Promise((resolve, reject) => {
    const pending = [];
    const server = http.createServer((req, res) => {
      const handler = pending[0];
      const url = new URL(req.url, `http://localhost`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      // The browser also asks for /favicon.ico. Ignore anything that is not
      // the redirect, or a favicon request would look like a denied consent.
      if (!code && !error) {
        res.writeHead(204).end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        code
          ? '<!doctype html><meta charset="utf-8"><p>Authorized. You can close this tab and return to the terminal.</p>'
          : '<!doctype html><meta charset="utf-8"><p>Authorization failed. Return to the terminal.</p>'
      );

      if (handler) {
        pending.shift();
        if (code) handler.resolve(code);
        else handler.reject(new UserError(`Authorization was denied or cancelled${error ? `: ${error}` : '.'}`));
      }
    });
    server.pending = pending;
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function waitForCode(server) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new UserError('Timed out waiting for the browser to complete authorization.'));
    }, CONSENT_TIMEOUT_MS);

    server.pending.push({
      resolve: (code) => {
        clearTimeout(timer);
        resolve(code);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
  });
}

function describe(err) {
  return err?.response?.data?.error_description ?? err?.message ?? String(err);
}

function isInvalidGrant(err) {
  const code = err?.response?.data?.error ?? err?.message ?? '';
  return String(code).includes('invalid_grant');
}

/**
 * Return an authorized OAuth2 client, running the consent flow if there is no
 * usable cached token.
 *
 * @param {object} config
 * @param {object} [opts]
 * @param {boolean} [opts.interactive] - when false, a missing/stale token is
 *   an error instead of a browser prompt (used by non-doctor commands).
 */
export async function getAuthClient(config, { interactive = true } = {}) {
  const { clientId, clientSecret } = readCredentials(config.credentialsPath);
  const cached = readToken(config.tokenPath);

  if (cached?.refresh_token || cached?.access_token) {
    const client = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost');
    client.setCredentials(cached);
    client.on('tokens', (tokens) => {
      writeToken(config.tokenPath, { ...cached, ...tokens });
    });

    try {
      await client.getAccessToken();
      return client;
    } catch (err) {
      if (!isInvalidGrant(err)) throw err;
      try {
        fs.unlinkSync(config.tokenPath);
      } catch {
        /* already gone */
      }
      throw new UserError(
        'The saved Google token is stale or was revoked, so it has been deleted.',
        { hint: 'Run `npm run doctor` to authorize again.' }
      );
    }
  }

  if (!interactive) {
    throw new UserError(`No saved Google token at ${config.tokenPath}.`, {
      hint: 'Run `npm run doctor` once to authorize. It opens a browser and writes the token.',
    });
  }

  const tokens = await runConsentFlow({ clientId, clientSecret });
  if (!tokens.refresh_token) {
    throw new UserError('Google returned no refresh token, so every run would re-prompt.', {
      hint:
        'Revoke this app at https://myaccount.google.com/permissions and run\n' +
        '`npm run doctor` again to force a fresh consent screen.',
    });
  }
  writeToken(config.tokenPath, tokens);
  process.stderr.write(`Saved credentials to ${config.tokenPath} (mode 0600).\n\n`);

  const client = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost');
  client.setCredentials(tokens);
  return client;
}

export function gmailClient(auth) {
  return google.gmail({ version: 'v1', auth });
}

export function sheetsClient(auth) {
  return google.sheets({ version: 'v4', auth });
}

/** Turn a Google API error into something a human can act on. */
export function explainApiError(err, { config, api }) {
  const status = err?.code ?? err?.response?.status;
  const message = err?.response?.data?.error?.message ?? err?.message ?? String(err);

  if (status === 403 && /has not been used|is disabled/i.test(message)) {
    return new UserError(`The ${api} API is not enabled for this Google Cloud project.`, {
      hint: 'Enable it in console.cloud.google.com under APIs & Services > Library, then retry.\n' + message,
    });
  }
  if (status === 403 && /insufficient|scope/i.test(message)) {
    return new UserError(`The saved token does not grant the scopes this tool needs (${api}).`, {
      hint: `Delete ${config?.tokenPath ?? 'token.json'} and run \`npm run doctor\` to re-authorize.`,
    });
  }
  if (status === 404 && api === 'Sheets') {
    return new UserError('That spreadsheet was not found, or your account cannot open it.', {
      hint: `Check SHEET_ID in .env. It is the part of the URL between /d/ and /edit.\n${message}`,
    });
  }
  if (/exceeds grid limits/i.test(message)) {
    return new UserError('The tab does not have enough columns for the new Status / Last Heard / Source columns.', {
      hint: 'Add a few empty columns to the right of your data in Google Sheets, then re-run.\n' + message,
    });
  }
  if (status === 400 && /Unable to parse range/i.test(message)) {
    return new UserError(`The tab named in SHEET_TAB_NAME does not exist in that spreadsheet.`, {
      hint: 'Run `npm run doctor` to list the tabs.',
    });
  }
  return new UserError(`${api} API error: ${message}`);
}
