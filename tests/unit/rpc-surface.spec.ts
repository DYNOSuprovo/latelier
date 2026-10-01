import { describe, it, expect } from 'vitest';
import {
  ADMIN_METHODS,
  COLLECTION_ACK_METHODS,
  COLLECTION_CURSOR_METHODS,
  COLLECTION_METHODS,
  CURSOR_SHAPING_METHODS,
  CURSOR_TERMINAL_METHODS,
  DB_ACK_METHODS,
  DB_CURSOR_METHODS,
  DB_METHODS,
  MAX_RPC_ARGS,
  MAX_RPC_ARGS_CHARS,
  MAX_RPC_IN_FLIGHT,
} from '../../electron/script-runner/rpcSurface';

const sorted = (s: ReadonlySet<string>): string[] => [...s].sort((a, b) => a.localeCompare(b));

// The allowlists are the security surface, so each is pinned by content: adding
// a method is a decision that should show up as a change to this file.
describe('rpcSurface', () => {
  it('db methods', () => {
    expect(sorted(DB_METHODS)).toEqual([
      'command',
      'createCollection',
      'createIndex',
      'dropCollection',
      'dropDatabase',
      'indexInformation',
      'listCollections',
      'profilingLevel',
      'renameCollection',
      'runCommand',
      'runCursorCommand',
      'setProfilingLevel',
      'stats',
    ]);
  });

  it('admin methods', () => {
    expect(sorted(ADMIN_METHODS)).toEqual([
      'buildInfo',
      'command',
      'listDatabases',
      'ping',
      'replSetGetStatus',
      'serverInfo',
      'serverStatus',
      'validateCollection',
    ]);
  });

  it('collection methods', () => {
    expect(sorted(COLLECTION_METHODS)).toEqual([
      'aggregate',
      'bulkWrite',
      'count',
      'countDocuments',
      'createIndex',
      'createIndexes',
      'createSearchIndex',
      'createSearchIndexes',
      'deleteMany',
      'deleteOne',
      'distinct',
      'drop',
      'dropIndex',
      'dropIndexes',
      'dropSearchIndex',
      'estimatedDocumentCount',
      'find',
      'findOne',
      'findOneAndDelete',
      'findOneAndReplace',
      'findOneAndUpdate',
      'indexes',
      'indexExists',
      'indexInformation',
      'insertMany',
      'insertOne',
      'isCapped',
      'listIndexes',
      'listSearchIndexes',
      'options',
      'rename',
      'replaceOne',
      'updateMany',
      'updateOne',
      'updateSearchIndex',
    ]);
  });

  it('cursor shaping methods', () => {
    expect(sorted(CURSOR_SHAPING_METHODS)).toEqual([
      'allowDiskUse',
      'batchSize',
      'collation',
      'comment',
      'filter',
      'hint',
      'limit',
      'max',
      'maxTimeMS',
      'min',
      'project',
      'returnKey',
      'showRecordId',
      'skip',
      'sort',
    ]);
  });

  it('cursor terminal methods', () => {
    expect(sorted(CURSOR_TERMINAL_METHODS)).toEqual(['close', 'count', 'explain', 'hasNext', 'next', 'toArray', 'tryNext']);
  });

  it('which calls hand back a cursor or an acknowledgement', () => {
    expect(sorted(DB_CURSOR_METHODS)).toEqual(['listCollections', 'runCursorCommand']);
    expect(sorted(COLLECTION_CURSOR_METHODS)).toEqual(['aggregate', 'find', 'listIndexes', 'listSearchIndexes']);
    expect(sorted(DB_ACK_METHODS)).toEqual(['createCollection', 'renameCollection']);
    expect(sorted(COLLECTION_ACK_METHODS)).toEqual(['rename']);
  });

  it('every special-cased method is itself allowed', () => {
    for (const m of DB_CURSOR_METHODS) expect(DB_METHODS.has(m)).toBe(true);
    for (const m of DB_ACK_METHODS) expect(DB_METHODS.has(m)).toBe(true);
    for (const m of COLLECTION_CURSOR_METHODS) expect(COLLECTION_METHODS.has(m)).toBe(true);
    for (const m of COLLECTION_ACK_METHODS) expect(COLLECTION_METHODS.has(m)).toBe(true);
  });

  it('nothing on any list is an Object.prototype member, and no name is shared between shaping and terminal', () => {
    const all = [DB_METHODS, ADMIN_METHODS, COLLECTION_METHODS, CURSOR_SHAPING_METHODS, CURSOR_TERMINAL_METHODS];
    for (const set of all) {
      for (const name of set) expect(name in Object.prototype).toBe(false);
    }
    for (const name of CURSOR_SHAPING_METHODS) expect(CURSOR_TERMINAL_METHODS.has(name)).toBe(false);
  });

  it('caps the argument count', () => {
    expect(MAX_RPC_ARGS).toBe(16);
  });

  it('caps the argument text and the calls in flight', () => {
    expect(MAX_RPC_ARGS_CHARS).toBe(16 * 1024 * 1024);
    expect(MAX_RPC_IN_FLIGHT).toBe(64);
  });
});
