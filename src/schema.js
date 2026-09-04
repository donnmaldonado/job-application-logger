/**
 * Validation for the JSON payload commit.js reads on stdin.
 *
 * commit.js is the only thing in this repo that writes, so this is the last
 * gate before a bad extraction becomes a bad row. It rejects rather than
 * repairs: a payload that is wrong is a bug in the caller, and a silently
 * "fixed" payload writes something the user never approved.
 */
import { STATUS_VALUES, PROTECTED_KEYS } from './sheets.js';

const APPEND_KEYS = new Set([
  'updated',
  'role',
  'company',
  'link',
  'notes',
  'status',
  'lastHeard',
  'messageIds',
]);
const UPDATE_KEYS = new Set(['row', 'status', 'lastHeard', 'messageIds']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkMessageIds(raw, path, errors) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${path}.messageIds must be an array of Gmail message id strings`);
    return [];
  }
  const ids = [];
  raw.forEach((id, i) => {
    if (typeof id !== 'string' || id.trim() === '') {
      errors.push(`${path}.messageIds[${i}] must be a non-empty string`);
      return;
    }
    ids.push(id.trim());
  });
  return ids;
}

function checkStatus(value, path, errors, { required }) {
  if (value === undefined) {
    if (required) errors.push(`${path}.status is required (one of ${STATUS_VALUES.join(', ')})`);
    return undefined;
  }
  if (typeof value !== 'string' || !STATUS_VALUES.includes(value)) {
    errors.push(
      `${path}.status must be one of ${STATUS_VALUES.join(', ')} (got ${JSON.stringify(value)})`
    );
    return undefined;
  }
  return value;
}

function checkText(value, path, errors, { required = false, allowQuestionMark = true } = {}) {
  if (value === undefined || value === null) {
    if (required) errors.push(`${path} is required`);
    return '';
  }
  if (typeof value !== 'string') {
    errors.push(`${path} must be a string (got ${typeof value})`);
    return '';
  }
  const trimmed = value.trim();
  if (required && trimmed === '') {
    errors.push(`${path} must not be empty`);
    return '';
  }
  if (!allowQuestionMark && trimmed === '?') {
    errors.push(
      `${path} is "?", which means the value was never resolved. Ask the user instead of writing it to the sheet.`
    );
    return '';
  }
  return trimmed;
}

/**
 * @param {unknown} input parsed JSON from stdin
 * @returns {{ valid: boolean, errors: string[], payload: object }}
 */
export function validateCommitPayload(input) {
  const errors = [];

  if (!isPlainObject(input)) {
    return {
      valid: false,
      errors: ['payload must be a JSON object with "appends", "updates", and/or "labelOnly"'],
      payload: { appends: [], updates: [], labelOnly: [] },
    };
  }

  for (const key of Object.keys(input)) {
    if (!['appends', 'updates', 'labelOnly'].includes(key)) {
      errors.push(`unknown top-level field "${key}" (expected appends, updates, labelOnly)`);
    }
  }

  const appends = [];
  if (input.appends !== undefined) {
    if (!Array.isArray(input.appends)) {
      errors.push('appends must be an array');
    } else {
      input.appends.forEach((raw, i) => {
        const path = `appends[${i}]`;
        if (!isPlainObject(raw)) {
          errors.push(`${path} must be an object`);
          return;
        }
        for (const key of Object.keys(raw)) {
          if (!APPEND_KEYS.has(key)) errors.push(`${path} has unknown field "${key}"`);
        }
        appends.push({
          updated: checkText(raw.updated, `${path}.updated`, errors, { required: true }),
          role: checkText(raw.role, `${path}.role`, errors, {
            required: true,
            allowQuestionMark: false,
          }),
          company: checkText(raw.company, `${path}.company`, errors, {
            required: true,
            allowQuestionMark: false,
          }),
          link: checkText(raw.link, `${path}.link`, errors),
          notes: checkText(raw.notes, `${path}.notes`, errors),
          status: checkStatus(raw.status, path, errors, { required: true }),
          lastHeard: checkText(raw.lastHeard, `${path}.lastHeard`, errors),
          messageIds: checkMessageIds(raw.messageIds, path, errors),
        });
      });
    }
  }

  const updates = [];
  if (input.updates !== undefined) {
    if (!Array.isArray(input.updates)) {
      errors.push('updates must be an array');
    } else {
      input.updates.forEach((raw, i) => {
        const path = `updates[${i}]`;
        if (!isPlainObject(raw)) {
          errors.push(`${path} must be an object`);
          return;
        }
        for (const key of Object.keys(raw)) {
          if (UPDATE_KEYS.has(key)) continue;
          if (PROTECTED_KEYS.includes(key)) {
            errors.push(
              `${path} may not set "${key}": updates only ever write status and lastHeard, so a status change cannot overwrite the apply date or a hand-written note`
            );
          } else {
            errors.push(`${path} has unknown field "${key}"`);
          }
        }

        const row = raw.row;
        if (!Number.isInteger(row) || row < 1) {
          errors.push(`${path}.row must be a positive integer sheet row (1-indexed)`);
        }

        const status = checkStatus(raw.status, path, errors, { required: false });
        const lastHeard =
          raw.lastHeard === undefined
            ? undefined
            : checkText(raw.lastHeard, `${path}.lastHeard`, errors);

        if (status === undefined && lastHeard === undefined) {
          errors.push(`${path} must set at least one of status or lastHeard`);
        }

        updates.push({
          row: Number.isInteger(row) ? row : 0,
          ...(status === undefined ? {} : { status }),
          ...(lastHeard === undefined ? {} : { lastHeard }),
          messageIds: checkMessageIds(raw.messageIds, path, errors),
        });
      });
    }
  }

  let labelOnly = [];
  if (input.labelOnly !== undefined) {
    if (!Array.isArray(input.labelOnly)) {
      errors.push('labelOnly must be an array of Gmail message id strings');
    } else {
      input.labelOnly.forEach((id, i) => {
        if (typeof id !== 'string' || id.trim() === '') {
          errors.push(`labelOnly[${i}] must be a non-empty string`);
          return;
        }
        labelOnly.push(id.trim());
      });
    }
  }

  return { valid: errors.length === 0, errors, payload: { appends, updates, labelOnly } };
}

/** Every message id in the payload, de-duplicated, in payload order. */
export function collectMessageIds(payload) {
  const ids = [];
  const seen = new Set();
  const push = (id) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };
  for (const a of payload.appends ?? []) (a.messageIds ?? []).forEach(push);
  for (const u of payload.updates ?? []) (u.messageIds ?? []).forEach(push);
  (payload.labelOnly ?? []).forEach(push);
  return ids;
}
