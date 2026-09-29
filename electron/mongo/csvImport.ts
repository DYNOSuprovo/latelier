import { ObjectId } from 'bson';
import type { CsvColumnMapping, CsvColumnType, CsvPreview } from '@shared/types';
import { ValidationError } from '../errors.ts';
import { ownSet } from '../ownProperty.ts';
import type { ImportRecord } from './importParse.ts';

/** How many data rows the import dialog's preview shows. */
export const PREVIEW_ROWS = 20;

type ValueType = Exclude<CsvColumnType, 'skip'>;

/**
 * RFC 4180, as a state machine: a quoted field may hold commas, doubled
 * quotes and line breaks, so no line-based split can find its end. Records
 * end at LF or CRLF; a lone CR is ordinary text. A quote opens a quoted
 * section only at the start of a field — anywhere else it is literal — and
 * text after a closing quote joins the same field. A leading BOM is dropped,
 * and a final line break does not start another record. A blank line is a
 * record of one empty field: row numbering has to count it.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let inRecord = false;
  const endRecord = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
    inRecord = false;
  };
  for (let i = text.startsWith('﻿') ? 1 : 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
      continue;
    }
    if (c === '\n' || (c === '\r' && text[i + 1] === '\n')) {
      if (c === '\r') i++;
      endRecord();
      continue;
    }
    inRecord = true;
    if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '"' && field === '') quoted = true;
    else field += c;
  }
  // Past an unclosed quote there is no telling where any later record starts.
  if (quoted) throw new ValidationError(`invalid CSV: row ${rows.length + 1} opens a quoted field that never closes`);
  if (inRecord) endRecord();
  return rows;
}

// Neither admits hex, `Infinity` or surrounding whitespace, all of which
// `Number()` accepts.
const NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
// A whole number however its fraction is spelled (`12`, `12.`, `12.000`):
// past 2^53 any of these would land as a different number. An exponent is
// left out on purpose — `1e300` is a float by intent, and no double holds it
// exactly either.
const INTEGER = /^[-+]?\d+(?:\.0*)?$/;
// A date, or a date-time that states its zone: a zone-less time would parse
// as the importing machine's local time.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/** `cell` (never empty) as a `type` value, or undefined when it doesn't convert. */
export function coerce(cell: string, type: ValueType): unknown {
  switch (type) {
    case 'string':
      return cell;
    case 'number': {
      if (!NUMBER.test(cell)) return undefined;
      const n = Number(cell);
      // Past 2^53 a whole number would land as a different number.
      if (INTEGER.test(cell) && !Number.isSafeInteger(n)) return undefined;
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean': {
      const lower = cell.toLowerCase();
      return lower === 'true' ? true : lower === 'false' ? false : undefined;
    }
    case 'date': {
      if (!ISO_DATE.test(cell)) return undefined;
      // `Date.parse` rolls 2024-02-30 over to March 1 instead of refusing
      // it, so the calendar date must read back unchanged.
      const ymd = cell.slice(0, 10);
      const day = Date.parse(ymd);
      if (Number.isNaN(day) || new Date(day).toISOString().slice(0, 10) !== ymd) return undefined;
      const ms = Date.parse(cell);
      return Number.isNaN(ms) ? undefined : new Date(ms);
    }
    case 'objectId':
      return OBJECT_ID.test(cell) ? ObjectId.createFromHexString(cell) : undefined;
  }
}

// Most specific first. An ObjectId's hex can be all digits, and such a
// column reads as ids, not numbers.
const INFERENCE_ORDER: ValueType[] = ['boolean', 'objectId', 'number', 'date'];

/** The first type every non-empty value converts to; `string` when none fits or the column is all empty. */
export function inferColumnType(values: string[]): CsvColumnType {
  const present = values.filter((v) => v !== '');
  if (present.length === 0) return 'string';
  return INFERENCE_ORDER.find((type) => present.every((v) => coerce(v, type) !== undefined)) ?? 'string';
}

const isBlank = (cells: string[]) => cells.length === 1 && cells[0] === '';

function splitHeader(text: string): { headers: string[]; rows: string[][] } {
  const [headers, ...rows] = parseCsv(text);
  if (headers === undefined) throw new ValidationError('the CSV file is empty');
  return { headers, rows };
}

/** The preview a file's text gives, minus its file name. */
export function previewCsv(text: string): Omit<CsvPreview, 'fileName'> {
  const { headers, rows } = splitHeader(text);
  const data = rows.filter((cells) => !isBlank(cells));
  return {
    headers,
    rows: data.slice(0, PREVIEW_ROWS),
    inferred: headers.map((_h, i) => inferColumnType(data.map((cells) => cells[i] ?? ''))),
  };
}

/**
 * Refuses a mapping that no longer matches the file's header row, and one
 * whose kept columns would write the same field twice: a repeated header, or
 * `a` beside `a.b`. `skip` is how the user resolves either.
 */
function checkColumns(headers: string[], columns: CsvColumnMapping[]): void {
  if (columns.length !== headers.length || columns.some((c, i) => c.header !== headers[i])) {
    throw new ValidationError("the column mapping doesn't match the file's header row — preview the file again");
  }
  const leaves = new Set<string>();
  const branches = new Set<string>();
  for (const { header, type } of columns) {
    if (type === 'skip') continue;
    const segments = header.split('.');
    if (segments.includes('')) {
      throw new ValidationError(`column "${header}" has an empty field name — skip it to import the rest`);
    }
    // `a`, `a.b`, …, ending with the header itself.
    const paths = segments.map((_s, i) => segments.slice(0, i + 1).join('.'));
    if (branches.has(header) || paths.some((p) => leaves.has(p))) {
      throw new ValidationError(`column "${header}" writes the same field as another column — skip one of them`);
    }
    leaves.add(header);
    for (const p of paths) branches.add(p);
  }
}

// `checkColumns` has already ruled out a segment that is taken by a value,
// so an existing intermediate is always one this walk created.
function setPath(doc: Record<string, unknown>, segments: string[], value: unknown): void {
  let target = doc;
  for (const segment of segments.slice(0, -1)) {
    if (!Object.hasOwn(target, segment)) ownSet(target, segment, Object.create(null));
    target = target[segment] as Record<string, unknown>;
  }
  ownSet(target, segments.at(-1)!, value);
}

const FAILURE: Record<Exclude<ValueType, 'string'>, string> = {
  number: 'not a number',
  boolean: 'not true or false',
  date: 'not an ISO-8601 date',
  objectId: 'not a 24-digit hex ObjectId',
};

function toRecord(cells: string[], columns: CsvColumnMapping[], at: number): ImportRecord {
  if (cells.length > columns.length) {
    return { at, error: `${cells.length} fields, but the header row has ${columns.length}` };
  }
  const doc: Record<string, unknown> = {};
  for (const [i, column] of columns.entries()) {
    if (column.type === 'skip') continue;
    // A short row's missing trailing cells read as empty.
    const cell = cells[i] ?? '';
    let value: unknown = null;
    if (cell === '') {
      if (!column.emptyAsNull) continue;
    } else {
      value = coerce(cell, column.type);
      if (value === undefined) {
        return { at, error: `column "${column.header}": ${FAILURE[column.type as keyof typeof FAILURE]}` };
      }
    }
    setPath(doc, column.header.split('.'), value);
  }
  return { at, doc };
}

/**
 * A CSV file's documents under `columns`, `at` being the spreadsheet row (the
 * header is row 1, and a blank line still takes a row). A cell that won't
 * convert fails only its own row; a mapping that doesn't fit the file fails
 * the whole import before anything is written.
 */
export function csvRecords(text: string, columns: CsvColumnMapping[]): ImportRecord[] {
  const { headers, rows } = splitHeader(text);
  checkColumns(headers, columns);
  const records: ImportRecord[] = [];
  rows.forEach((cells, i) => {
    if (!isBlank(cells)) records.push(toRecord(cells, columns, i + 2));
  });
  return records;
}
