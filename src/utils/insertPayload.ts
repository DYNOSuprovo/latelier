/**
 * Classify a parsed EJSON insert payload so the Document Editor's insert
 * mode can route a single document to `doc:insert` and a top-level array to
 * `doc:insertMany`. Pure and framework-free so it's unit-testable
 * independent of React (and lives in a plain `.ts` module because component
 * files here can't export non-component constants under
 * `react-refresh/only-export-components`).
 */

export type InsertPayloadClassification =
  | { kind: 'single' }
  | { kind: 'array'; count: number }
  | { kind: 'array-empty' }
  | { kind: 'array-invalid-items' };

function isPlainObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function classifyInsertPayload(value: unknown): InsertPayloadClassification {
  if (!Array.isArray(value)) {
    return { kind: 'single' };
  }
  if (value.length === 0) {
    return { kind: 'array-empty' };
  }
  if (!value.every((item) => isPlainObject(item))) {
    return { kind: 'array-invalid-items' };
  }
  return { kind: 'array', count: value.length };
}
