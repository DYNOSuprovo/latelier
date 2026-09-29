import path from 'node:path';
import type { ImportFormat, ImportReport } from '@shared/types';
import { ValidationError } from '../errors.ts';
import { parseEjsonDocument } from './ejson.ts';

/** How many failures a report lists; past this they are only counted. */
export const MAX_REPORTED_ERRORS = 50;

// A `.json` file can be either shape: `mongoexport` writes one document per
// line unless it is given `--jsonArray`.
const EXTENSION_FORMATS: Readonly<Record<string, ImportFormat | 'sniff'>> = {
  '.json': 'sniff',
  '.jsonl': 'jsonl',
  '.ndjson': 'jsonl',
  '.csv': 'csv',
};

/** The format a file's extension settles, `'sniff'` when only its contents can, undefined for an extension import refuses. */
export function extensionFormat(filePath: string): ImportFormat | 'sniff' | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return Object.hasOwn(EXTENSION_FORMATS, ext) ? EXTENSION_FORMATS[ext] : undefined;
}

/**
 * The format a `.json` file's opening text shows: an array when its first
 * significant character is `[`, JSONL otherwise. Undefined while `head` is
 * still only whitespace. `\S` also steps over a UTF-8 BOM, which JavaScript
 * counts as whitespace.
 */
export function sniffFormat(head: string): ImportFormat | undefined {
  const first = /\S/.exec(head)?.[0];
  if (first === undefined) return undefined;
  return first === '[' ? 'json' : 'jsonl';
}

// Neither `readline` nor `readFile(…, 'utf8')` strips one.
function stripBom(text: string): string {
  return text.startsWith('﻿') ? text.slice(1) : text;
}

export type ImportRecord =
  | { at: number; doc: Record<string, unknown> }
  | { at: number; error: string };

function toRecord(at: number, json: string): ImportRecord {
  try {
    return { at, doc: parseEjsonDocument<Record<string, unknown>>(json, 'document') };
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    return { at, error: err.message };
  }
}

/** One JSONL line (`lineNo` is 1-based) as a record, or null for a blank line. */
export function parseJsonlLine(line: string, lineNo: number): ImportRecord | null {
  const text = lineNo === 1 ? stripBom(line) : line;
  if (text.trim() === '') return null;
  return toRecord(lineNo, text);
}

/**
 * A JSON array file's documents, `at` being the 0-based index. Invalid JSON
 * fails the whole file — past a syntax error there is no telling where the
 * next document starts — but an element that is not a document, or whose
 * EJSON will not revive, fails only itself: each is revived on its own.
 */
export function parseJsonArray(text: string): ImportRecord[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(text));
  } catch (err) {
    throw new ValidationError(`invalid JSON array: ${(err as Error).message}`);
  }
  if (!Array.isArray(raw)) throw new ValidationError('expected a JSON array of documents');
  return raw.map((el, i) => toRecord(i, JSON.stringify(el)));
}

export function emptyReport(fileName: string, format: ImportFormat): ImportReport {
  return { fileName, format, inserted: 0, failed: 0, errors: [], errorsTruncated: false, cancelled: false };
}

export function recordFailure(report: ImportReport, at: number, message: string): void {
  report.failed++;
  if (report.errors.length < MAX_REPORTED_ERRORS) report.errors.push({ at, message });
  else report.errorsTruncated = true;
}
