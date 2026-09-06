/** Sheets: header detection, column mapping, read, append, update, and the additive migration. */
import { UserError } from './config.js';

/** Canonical column keys, in sheet order. */
const COLUMN_KEYS = [
  'updated',
  'role',
  'company',
  'link',
  'notes',
  'status',
  'lastHeard',
  'source',
];

/** Keys a row object reports (link and notes are left to the human). */
const ROW_KEYS = ['updated', 'role', 'company', 'status', 'lastHeard', 'source'];

/** Columns commit.js must never write on an update. */
export const PROTECTED_KEYS = ['updated', 'role', 'company', 'link', 'notes'];

export const STATUS_VALUES = ['applied', 'confirmed', 'rejected', 'interview'];

export const MIGRATION_HEADERS = {
  status: 'Status',
  lastHeard: 'Last Heard',
  source: 'Source',
};

const HEADER_ALIASES = {
  updated: ['updated'],
  role: ['role'],
  company: ['company'],
  status: ['status'],
  lastHeard: ['last heard', 'lastheard', 'last_heard', 'last-heard'],
  source: ['source'],
};

const REQUIRED_HEADERS = ['updated', 'role', 'company'];
const HEADER_SCAN_ROWS = 10;

/** 0-based column index -> A1 letter. */
export function columnLetter(index) {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`bad column index: ${index}`);
  let n = index;
  let letters = '';
  while (true) {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return letters;
}

/** Quote a tab name for an A1 range (single quotes are doubled). */
export function quoteTab(tab) {
  return `'${String(tab).replace(/'/g, "''")}'`;
}

function norm(cell) {
  return String(cell ?? '').trim().toLowerCase();
}

function cell(values, rowIdx, colIdx) {
  const row = values?.[rowIdx];
  if (!Array.isArray(row)) return '';
  const v = row[colIdx];
  return v === undefined || v === null ? '' : String(v);
}

/**
 * Find the header row. Never assumes row 1: scans the first 10 rows for one
 * containing all of `updated`, `role`, `company`.
 *
 * @returns {number} 0-based row index, or -1 if not found.
 */
export function detectHeaderRow(values, scanRows = HEADER_SCAN_ROWS) {
  if (!Array.isArray(values)) return -1;
  const limit = Math.min(values.length, scanRows);
  for (let i = 0; i < limit; i += 1) {
    const row = Array.isArray(values[i]) ? values[i].map(norm) : [];
    const hasAll = REQUIRED_HEADERS.every((name) =>
      row.some((c) => HEADER_ALIASES[name].includes(c))
    );
    if (hasAll) return i;
  }
  return -1;
}

/**
 * Map canonical keys to 0-based column indices.
 * `link` and `notes` are the two unlabeled columns right after `company`
 * unless a named header already claims those positions.
 */
export function buildColumns(headerCells) {
  const cells = (Array.isArray(headerCells) ? headerCells : []).map(norm);
  const byKey = {};

  for (const key of ['updated', 'role', 'company', 'status', 'lastHeard', 'source']) {
    const idx = cells.findIndex((c) => HEADER_ALIASES[key].includes(c));
    if (idx >= 0) byKey[key] = idx;
  }

  const claimed = new Set(Object.values(byKey));
  if (byKey.company !== undefined) {
    const linkIdx = byKey.company + 1;
    const notesIdx = byKey.company + 2;
    if (!claimed.has(linkIdx)) byKey.link = linkIdx;
    if (!claimed.has(notesIdx) && notesIdx !== byKey.link) byKey.notes = notesIdx;
  }

  return byKey;
}

/** `{ updated: "A", role: "B", ... }` for the JSON contract. */
export function columnsToLetters(byKey) {
  const out = {};
  for (const key of COLUMN_KEYS) {
    if (byKey[key] !== undefined) out[key] = columnLetter(byKey[key]);
  }
  return out;
}

function rowIsEmpty(values, rowIdx, byKey) {
  return ROW_KEYS.every((key) => {
    const idx = byKey[key];
    return idx === undefined || cell(values, rowIdx, idx).trim() === '';
  });
}

/**
 * Build the read-sheet.js contract payload from raw cell values.
 * `row` is the 1-indexed sheet row so commit.js can address it directly.
 */
export function buildSheetPayload(values, tabName) {
  const headerIdx = detectHeaderRow(values);
  if (headerIdx < 0) {
    throw new UserError(
      `No header row found in tab "${tabName}". Looked at the first ${HEADER_SCAN_ROWS} rows for one containing "Updated", "Role", and "Company".`,
      {
        hint:
          'Check that SHEET_TAB_NAME in .env names the right tab, then run:\n' +
          '  npm run doctor\n' +
          'to list the tabs in the spreadsheet.',
      }
    );
  }

  const byKey = buildColumns(values[headerIdx]);
  const rows = [];
  for (let i = headerIdx + 1; i < (values?.length ?? 0); i += 1) {
    if (rowIsEmpty(values, i, byKey)) continue;
    const row = { row: i + 1 };
    for (const key of ROW_KEYS) {
      const idx = byKey[key];
      row[key] = idx === undefined ? '' : cell(values, i, idx).trim();
    }
    rows.push(row);
  }

  return {
    tab: tabName,
    headerRow: headerIdx + 1,
    columns: columnsToLetters(byKey),
    rows,
    indices: byKey, // internal; stripped before printing
  };
}

/** Drop the internal `indices` field before the payload goes to stdout. */
export function publicSheetPayload(payload) {
  const { indices, ...rest } = payload;
  return rest;
}

/**
 * Plan the additive migration. Pure, so `doctor --migrate --fixture` and the
 * tests can see exactly what would be written.
 *
 * @returns {{
 *   needed: boolean,
 *   conflicts: string[],
 *   headerWrites: Array<{key:string,range:string,value:string,index:number}>,
 *   cellWrites: Array<{range:string,value:string,row:number,key:string}>,
 *   indices: object
 * }}
 */
export function planMigration(values, tabName) {
  const headerIdx = detectHeaderRow(values);
  if (headerIdx < 0) {
    throw new UserError(
      `No header row found in tab "${tabName}", so there is nothing to migrate.`,
      { hint: 'Run `npm run doctor` to list tabs and check SHEET_TAB_NAME.' }
    );
  }

  const byKey = buildColumns(values[headerIdx]);
  const headerCells = Array.isArray(values[headerIdx]) ? values[headerIdx] : [];
  const conflicts = [];
  const headerWrites = [];

  // Default landing spots: immediately right of the existing five columns.
  const base = byKey.company !== undefined ? byKey.company + 3 : headerCells.length;
  const defaults = { status: base, lastHeard: base + 1, source: base + 2 };
  const indices = { ...byKey };

  for (const key of ['status', 'lastHeard', 'source']) {
    if (indices[key] !== undefined) continue; // already migrated for this column

    const target = defaults[key];
    const existingHeader = cell(values, headerIdx, target).trim();
    if (existingHeader !== '') {
      conflicts.push(
        `column ${columnLetter(target)} is already headed "${existingHeader}", expected "${MIGRATION_HEADERS[key]}"`
      );
      continue;
    }
    // Refuse to plant a header on top of a column that already holds data.
    for (let i = headerIdx + 1; i < values.length; i += 1) {
      if (cell(values, i, target).trim() !== '') {
        conflicts.push(
          `column ${columnLetter(target)} has no header but contains data (row ${i + 1}), so "${MIGRATION_HEADERS[key]}" cannot be added there`
        );
        break;
      }
    }
    indices[key] = target;
    headerWrites.push({
      key,
      index: target,
      range: `${quoteTab(tabName)}!${columnLetter(target)}${headerIdx + 1}`,
      value: MIGRATION_HEADERS[key],
    });
  }

  const cellWrites = [];
  if (conflicts.length === 0) {
    const backfill = { status: 'applied', source: 'manual' };
    for (let i = headerIdx + 1; i < values.length; i += 1) {
      if (rowIsEmpty(values, i, byKey)) continue;
      for (const [key, value] of Object.entries(backfill)) {
        const idx = indices[key];
        if (idx === undefined) continue;
        if (cell(values, i, idx).trim() !== '') continue;
        cellWrites.push({
          key,
          row: i + 1,
          range: `${quoteTab(tabName)}!${columnLetter(idx)}${i + 1}`,
          value,
        });
      }
    }
  }

  return {
    needed: conflicts.length === 0 && (headerWrites.length > 0 || cellWrites.length > 0),
    conflicts,
    headerWrites,
    cellWrites,
    indices,
    headerRow: headerIdx + 1,
  };
}

/** Build the flat cell array for an appended row, positioned by column index. */
export function buildAppendRow(append, indices) {
  const width = Math.max(...Object.values(indices).filter((n) => Number.isInteger(n))) + 1;
  const row = new Array(width).fill('');
  const source = { ...append, source: 'auto' };
  for (const key of COLUMN_KEYS) {
    const idx = indices[key];
    if (idx === undefined) continue;
    const value = source[key];
    row[idx] = value === undefined || value === null ? '' : String(value);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Network-touching helpers.
// ---------------------------------------------------------------------------

export async function listTabs(sheets, spreadsheetId) {
  const res = await sheets.spreadsheets.get({ spreadsheetId, fields: 'properties.title,sheets.properties' });
  return {
    title: res.data.properties?.title ?? '',
    tabs: (res.data.sheets ?? []).map((s) => s.properties?.title).filter(Boolean),
  };
}

export async function readValues(sheets, spreadsheetId, tabName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: quoteTab(tabName),
    majorDimension: 'ROWS',
    valueRenderOption: 'FORMATTED_VALUE',
  });
  return res.data.values ?? [];
}

export async function appendRows(sheets, spreadsheetId, tabName, rows) {
  if (rows.length === 0) return 0;
  const width = Math.max(...rows.map((r) => r.length));
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${quoteTab(tabName)}!A:${columnLetter(width - 1)}`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
  return res.data.updates?.updatedRows ?? rows.length;
}

/** Write individual cells. Only ever the status and lastHeard cells; callers build ranges. */
export async function writeCells(sheets, spreadsheetId, data) {
  if (data.length === 0) return 0;
  const res = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: data.map(({ range, value }) => ({ range, values: [[value]] })),
    },
  });
  return res.data.totalUpdatedCells ?? data.length;
}
