/**
 * MIME body extraction is the fiddliest part of this tool and the part most
 * likely to fail silently, so it is tested directly against the fixture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  decodeBase64Url,
  decodeEntities,
  stripHtml,
  collapseWhitespace,
  extractBody,
  parseFrom,
  header,
  truncate,
  normalizeMessage,
  buildQuery,
  assertDuration,
} from '../src/gmail.js';

const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/messages.sample.json', import.meta.url)));
const byId = (id) => fixture.messages.find((m) => m.id === id);

const MULTIPART = byId('fixture0000000001');
const HTML_ONLY = byId('fixture0000000002');
const PLAIN_ONLY = byId('fixture0000000003');
const DEEP_NESTED = byId('fixture0000000004');
const HTML_FALLBACK = byId('fixture0000000006');

test('base64url decoding translates - and _', () => {
  const encoded = Buffer.from('subject?~ ünïcode ~?', 'utf8').toString('base64url');
  assert.equal(decodeBase64Url(encoded), 'subject?~ ünïcode ~?');
});

test('the multipart fixture body really is base64url, not base64', () => {
  const data = MULTIPART.payload.parts[0].parts[0].body.data;
  assert.ok(data.includes('-'), 'fixture body should contain a base64url "-"');
  assert.ok(data.includes('_'), 'fixture body should contain a base64url "_"');

  // A decoder that only knows the standard alphabet cannot see `-` and `_`,
  // so its output shifts into mojibake. That is the failure the spec warns
  // about, and this asserts our decoder does not share it.
  assert.notEqual(strictBase64Decode(data), decodeBase64Url(data));
  assert.match(decodeBase64Url(data), /Northwind Robotics/);
});

/** A deliberately strict base64 decoder: it ignores anything outside the
 *  standard alphabet, which is how base64url input gets mangled. */
function strictBase64Decode(input) {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = [];
  let bits = 0;
  let count = 0;
  for (const ch of input) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) continue;
    bits = (bits << 6) | value;
    count += 6;
    if (count >= 8) {
      count -= 8;
      bytes.push((bits >> count) & 0xff);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

test('decodeBase64Url handles missing padding and empty input', () => {
  assert.equal(decodeBase64Url(Buffer.from('abcde').toString('base64url')), 'abcde');
  assert.equal(decodeBase64Url(''), '');
  assert.equal(decodeBase64Url(undefined), '');
});

test('multipart/alternative prefers text/plain and ignores attachments', () => {
  const { text, mimeType } = extractBody(MULTIPART.payload);
  assert.equal(mimeType, 'text/plain');
  assert.match(text, /Thanks for applying to the Analytics Engineer role at Northwind Robotics/);
  assert.doesNotMatch(text, /<p>|<b>/, 'the HTML alternative must not leak in');
  assert.doesNotMatch(text, /application-summary\.pdf/, 'attachment names are not body text');
});

test('HTML-only messages fall back to stripped, entity-decoded text', () => {
  const { text, mimeType } = extractBody(HTML_ONLY.payload);
  assert.equal(mimeType, 'text/html');
  assert.match(text, /Thank you for your interest in the Data Engineer position at Vantage Grid/);
  assert.match(text, /we've decided to move forward/, '&#39; should decode');
  assert.match(text, /apply again — we post new roles often/, '&mdash; should decode');
  assert.doesNotMatch(text, /<[a-z]/i, 'no tags survive');
  assert.doesNotMatch(text, /console\.log|padding: 24px/, 'script and style contents are dropped');
  assert.doesNotMatch(text, /&nbsp;|&#39;|&mdash;/, 'no raw entities survive');
});

test('plain-text messages with no parts are read from payload.body', () => {
  const { text, mimeType } = extractBody(PLAIN_ONLY.payload);
  assert.equal(mimeType, 'text/plain');
  assert.match(text, /Senior Analyst opening at Aurora Labs/);
});

test('deeply nested parts are walked, inline images skipped', () => {
  const { text, mimeType } = extractBody(DEEP_NESTED.payload);
  assert.equal(mimeType, 'text/plain');
  assert.match(text, /Thank you for your interest in employment opportunities at Meridian Health/);
});

test('an empty text/plain part falls through to the HTML alternative', () => {
  const { text, mimeType } = extractBody(HTML_FALLBACK.payload);
  assert.equal(mimeType, 'text/html');
  assert.match(text, /Business Systems Analyst/);
});

test('a payload with nothing readable yields empty text', () => {
  const { text, mimeType } = extractBody({
    mimeType: 'multipart/mixed',
    parts: [{ mimeType: 'application/pdf', filename: 'cv.pdf', body: { attachmentId: 'x' } }],
  });
  assert.equal(text, '');
  assert.equal(mimeType, null);
});

test('extractBody survives cycles-by-depth and junk input', () => {
  assert.deepEqual(extractBody(null), { text: '', mimeType: null });
  assert.deepEqual(extractBody({}), { text: '', mimeType: null });
});

test('whitespace runs collapse before truncation', () => {
  assert.equal(collapseWhitespace('a   \n\n\n   b \t\t c   '), 'a\nb c');
  const { text } = extractBody(MULTIPART.payload);
  assert.doesNotMatch(text, /\n\n|   /, 'ATS layout padding is collapsed away');
});

test('truncation respects MAX_BODY_CHARS', () => {
  const long = normalizeMessage(DEEP_NESTED, { maxBodyChars: 120 });
  assert.equal(long.body.length, 120);
  assert.ok(long.body.endsWith('…'));

  const short = normalizeMessage(PLAIN_ONLY, { maxBodyChars: 100000 });
  assert.ok(!short.body.endsWith('…'));
  assert.equal(truncate('abc', 10), 'abc');
});

test('the default MAX_BODY_CHARS actually truncates a long ATS boilerplate mail', () => {
  const msg = normalizeMessage(DEEP_NESTED, { maxBodyChars: 2000 });
  assert.equal(msg.body.length, 2000);
});

test('parseFrom splits display name from address', () => {
  assert.deepEqual(parseFrom('"Northwind Robotics" <no-reply@greenhouse.example.com>'), {
    name: 'Northwind Robotics',
    email: 'no-reply@greenhouse.example.com',
  });
  assert.deepEqual(parseFrom('priya@aurora-labs.example.com'), {
    name: '',
    email: 'priya@aurora-labs.example.com',
  });
  assert.deepEqual(parseFrom(''), { name: '', email: '' });
});

test('header lookup is case-insensitive', () => {
  assert.equal(header(MULTIPART.payload, 'subject'), 'Thank you for applying to Northwind Robotics');
  assert.equal(header(MULTIPART.payload, 'x-nope'), '');
});

test('normalizeMessage produces the documented contract shape', () => {
  const msg = normalizeMessage(MULTIPART, { maxBodyChars: 2000 });
  assert.deepEqual(Object.keys(msg), [
    'id',
    'threadId',
    'date',
    'from',
    'fromName',
    'subject',
    'snippet',
    'body',
  ]);
  assert.equal(msg.id, 'fixture0000000001');
  assert.equal(msg.from, 'no-reply@greenhouse.example.com');
  assert.equal(msg.fromName, 'Northwind Robotics');
  assert.equal(msg.date, new Date(Number(MULTIPART.internalDate)).toISOString());
  assert.doesNotMatch(msg.snippet, /&hellip;|&#39;|&quot;/, 'snippet entities are decoded');
});

test('a message without internalDate falls back to the Date header', () => {
  assert.equal(normalizeMessage(DEEP_NESTED).date, new Date('Thu, 3 Sep 2026 09:05:00 -0400').toISOString());
  assert.equal(normalizeMessage({ id: 'x', payload: { headers: [] } }).date, '');
});

test('buildQuery excludes the processed label - the whole dedup mechanism', () => {
  assert.equal(
    buildQuery({ since: '2d', processedLabel: 'logged-to-sheet' }),
    'newer_than:2d -label:logged-to-sheet'
  );
  assert.equal(
    buildQuery({ since: '7d', processedLabel: 'logged to sheet', extra: '-category:promotions' }),
    'newer_than:7d -label:"logged to sheet" -category:promotions'
  );
});

test('assertDuration rejects human durations', () => {
  assert.equal(assertDuration('2d'), '2d');
  assert.equal(assertDuration('12h'), '12h');
  assert.throws(() => assertDuration('2 days'), /Gmail duration syntax/);
  assert.throws(() => assertDuration(''), /Gmail duration syntax/);
});

test('entity decoding leaves unknown entities alone', () => {
  assert.equal(decodeEntities('a &amp; b &#65; &#x42; &notreal;'), 'a & b A B &notreal;');
});

test('stripHtml keeps block structure as line breaks', () => {
  assert.equal(collapseWhitespace(stripHtml('<p>one</p><p>two</p><br>three')), 'one\ntwo\nthree');
});
