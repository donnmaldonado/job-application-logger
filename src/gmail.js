/**
 * Gmail: query construction, search, message normalization, MIME body
 * extraction, and labeling.
 *
 * The pure functions here (decodeBase64Url, stripHtml, extractBody,
 * normalizeMessage, buildQuery) take plain data and are exercised directly by
 * the tests against fixtures - no network, no credentials.
 */
import { UserError } from './config.js';

/** Decode a base64url payload (Gmail uses `-` and `_`, not `+` and `/`). */
export function decodeBase64Url(data) {
  if (!data) return '';
  const normalized = String(data).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  eacute: 'é',
};

/** Decode the HTML entities that actually show up in ATS mail. */
export function decodeEntities(input) {
  if (!input) return '';
  return String(input)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name) => {
      const key = name.toLowerCase();
      return Object.hasOwn(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match;
    });
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Strip HTML to readable text: drop invisible elements, keep block breaks. */
export function stripHtml(html) {
  if (!html) return '';
  let text = String(html);
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style|head|title|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|tr|li|h[1-6]|table|section|header|footer)\s*>/gi, '\n');
  text = text.replace(/<\/(td|th)\s*>/gi, '\t');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  return text;
}

/** Collapse runs of whitespace so MAX_BODY_CHARS buys content, not padding. */
export function collapseWhitespace(input) {
  if (!input) return '';
  return String(input)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ​]+/g, ' ')
    .replace(/ *\n[ \n]*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * Walk a Gmail payload tree and pull out the best body text.
 * Prefers text/plain anywhere in the tree; falls back to text/html stripped.
 * Parts nest arbitrarily deep and attachments carry no inline data.
 *
 * @returns {{ text: string, mimeType: string|null }}
 */
export function extractBody(payload) {
  const found = { plain: [], html: [] };
  walk(payload, found, 0);

  if (found.plain.length > 0) {
    return { text: collapseWhitespace(found.plain.join('\n')), mimeType: 'text/plain' };
  }
  if (found.html.length > 0) {
    return {
      text: collapseWhitespace(stripHtml(found.html.join('\n'))),
      mimeType: 'text/html',
    };
  }
  return { text: '', mimeType: null };
}

function walk(part, found, depth) {
  if (!part || typeof part !== 'object' || depth > 24) return;

  const mimeType = String(part.mimeType ?? '').toLowerCase();
  const filename = part.filename ?? '';
  const isAttachment = Boolean(filename) || Boolean(part.body?.attachmentId);
  const data = part.body?.data;

  if (data && !isAttachment) {
    if (mimeType === 'text/plain' || mimeType === '') {
      found.plain.push(decodeBase64Url(data));
    } else if (mimeType === 'text/html') {
      found.html.push(decodeBase64Url(data));
    }
  }

  if (Array.isArray(part.parts)) {
    for (const child of part.parts) walk(child, found, depth + 1);
  }
}

/** Case-insensitive header lookup over Gmail's `[{name, value}]` array. */
export function header(payload, name) {
  const headers = payload?.headers;
  if (!Array.isArray(headers)) return '';
  const wanted = name.toLowerCase();
  for (const h of headers) {
    if (String(h?.name ?? '').toLowerCase() === wanted) return String(h?.value ?? '');
  }
  return '';
}

/** Split `"Greenhouse" <no-reply@example.com>` into name and address. */
export function parseFrom(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { email: '', name: '' };

  const angle = raw.match(/^(.*?)<([^>]+)>\s*$/);
  if (angle) {
    let name = angle[1].trim().replace(/^["']|["']$/g, '').trim();
    return { email: angle[2].trim(), name: decodeEntities(name) };
  }
  return { email: raw, name: '' };
}

/** Truncate to `max` characters, marking the cut so downstream knows. */
export function truncate(text, max) {
  const value = String(text ?? '');
  if (!Number.isFinite(max) || max <= 0 || value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * Turn a raw Gmail message resource into the fetch.js contract shape.
 * Pure: this is what the fixtures exercise.
 */
export function normalizeMessage(raw, { maxBodyChars = 2000 } = {}) {
  const payload = raw?.payload ?? {};
  const { email, name } = parseFrom(header(payload, 'From'));
  const { text } = extractBody(payload);

  return {
    id: String(raw?.id ?? ''),
    threadId: String(raw?.threadId ?? raw?.id ?? ''),
    date: messageDate(raw, payload),
    from: email,
    fromName: name,
    subject: collapseWhitespace(decodeEntities(header(payload, 'Subject'))),
    snippet: collapseWhitespace(decodeEntities(raw?.snippet ?? '')),
    body: truncate(text, maxBodyChars),
  };
}

function messageDate(raw, payload) {
  const internal = Number(raw?.internalDate);
  if (Number.isFinite(internal) && internal > 0) return new Date(internal).toISOString();
  const parsed = Date.parse(header(payload, 'Date'));
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return '';
}

/**
 * `newer_than:2d -label:logged-to-sheet <extra>` - the sweep query. The
 * negative label term is the whole deduplication mechanism.
 */
export function buildQuery({ since, processedLabel, extra = '' } = {}) {
  const terms = [];
  if (since) terms.push(`newer_than:${since}`);
  if (processedLabel) terms.push(`-label:${quoteLabel(processedLabel)}`);
  const trimmedExtra = String(extra ?? '').trim();
  if (trimmedExtra) terms.push(trimmedExtra);
  return terms.join(' ');
}

function quoteLabel(label) {
  return /\s/.test(label) ? `"${label}"` : label;
}

const DURATION = /^\d+[dmyhw]$/i;

/** Gmail duration syntax check, so a typo fails here and not at the API. */
export function assertDuration(value, flagName = '--since') {
  if (!DURATION.test(String(value ?? '').trim())) {
    throw new UserError(
      `${flagName} must use Gmail duration syntax like 2d, 12h, 3w, or 1m (got ${JSON.stringify(value)}).`,
      { hint: 'd = days, h = hours, w = weeks, m = months, y = years. GMAIL_LOOKBACK in .env sets the default.' }
    );
  }
  return String(value).trim();
}

// ---------------------------------------------------------------------------
// Network-touching helpers. Everything above is pure and fixture-testable.
// ---------------------------------------------------------------------------

/** @returns {{ ids: string[], truncated: boolean }} */
export async function searchMessages(gmail, { query, maxMessages }) {
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: Math.min(maxMessages, 500),
  });
  const ids = (res.data.messages ?? []).map((m) => m.id).filter(Boolean);
  return {
    ids: ids.slice(0, maxMessages),
    truncated: Boolean(res.data.nextPageToken) || ids.length > maxMessages,
  };
}

export async function getMessage(gmail, id) {
  const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  return res.data;
}

/** Look the processed label up by name, creating it if it does not exist. */
export async function ensureLabel(gmail, labelName) {
  const res = await gmail.users.labels.list({ userId: 'me' });
  const wanted = labelName.toLowerCase();
  const existing = (res.data.labels ?? []).find(
    (l) => String(l.name ?? '').toLowerCase() === wanted
  );
  if (existing) return { id: existing.id, created: false };

  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name: labelName,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    },
  });
  return { id: created.data.id, created: true };
}

/** One batchModify call, not N modifies. Gmail caps a batch at 1000 ids. */
export async function batchLabel(gmail, ids, labelId) {
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 900) {
    await gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: { ids: unique.slice(i, i + 900), addLabelIds: [labelId] },
    });
  }
  return unique.length;
}
