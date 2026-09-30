import { describe, it, expect } from 'vitest';
import {
  AppError,
  ConflictError,
  MongoOpError,
  NotFoundError,
  ReadOnlyConnectionError,
  SystemError,
  ValidationError,
} from '../../electron/errors';
import { fromWireError, isRunnerMessage, toWireError } from '../../electron/script-runner/protocol';

describe('toWireError / fromWireError', () => {
  const cases: Array<[string, AppError, new (...a: never[]) => AppError]> = [
    ['ValidationError', new ValidationError('bad', { field: 'source' }), ValidationError],
    ['NotFoundError', new NotFoundError('gone', { id: 1 }), NotFoundError],
    ['ConflictError', new ConflictError('clash', { mongoCode: 11000 }), ConflictError],
    ['ReadOnlyConnectionError', new ReadOnlyConnectionError('ro', { op: 'x' }), ReadOnlyConnectionError],
    ['SystemError', new SystemError('TIMEOUT', 'slow', { ms: 5 }), SystemError],
    ['MongoOpError', new MongoOpError('MONGO_ERROR', 'op failed', { c: 1 }), MongoOpError],
  ];

  it.each(cases)('round-trips %s with its class, code, message and details', (_name, err, cls) => {
    const back = fromWireError(structuredClone(toWireError(err)));
    expect(back).toBeInstanceOf(cls);
    expect(back.code).toBe(err.code);
    expect(back.message).toBe(err.message);
    expect(back.details).toEqual(err.details);
    expect(back.name).toBe(err.name);
  });

  it('keeps the original stack text', () => {
    const err = new ValidationError('bad');
    err.stack = 'Error: bad\n    at script.js:3:5';
    expect(fromWireError(toWireError(err)).stack).toBe('Error: bad\n    at script.js:3:5');
  });

  it('an error that never had a stack text keeps the one it was built with', () => {
    const back = fromWireError({ name: 'ValidationError', code: 'VALIDATION', message: 'm' });
    expect(typeof back.stack).toBe('string');
    expect(back.stack).toContain('ValidationError');
  });

  it('an unknown error name comes back as a plain AppError with its code', () => {
    const back = fromWireError({ name: 'Mystery', code: 'NETWORK', message: 'm' });
    expect(back.constructor).toBe(AppError);
    expect(back.code).toBe('NETWORK');
  });

  it('a non-AppError becomes INTERNAL, keeping message and stack', () => {
    const plain = new TypeError('nope');
    const wire = toWireError(plain);
    expect(wire).toMatchObject({ name: 'AppError', code: 'INTERNAL', message: 'nope', stack: plain.stack });
  });

  it('a thrown non-error value is stringified', () => {
    expect(toWireError('just a string')).toMatchObject({ code: 'INTERNAL', message: 'just a string' });
    expect(toWireError(null)).toMatchObject({ code: 'INTERNAL', message: 'null' });
  });

  it('drops details that cannot cross the port instead of failing the whole error', () => {
    const wire = toWireError(new SystemError('INTERNAL', 'x', { fn: () => 1 }));
    expect(wire.details).toBeUndefined();
    expect(wire.message).toBe('x');
    // The result must itself be postable.
    expect(() => structuredClone(wire)).not.toThrow();
  });

  it('omits details when there are none', () => {
    expect('details' in toWireError(new ValidationError('x'))).toBe(false);
  });
});

describe('isRunnerMessage', () => {
  it('accepts a well-formed result and error', () => {
    expect(isRunnerMessage({ type: 'result', valueJson: null, printBuffer: '', durationMs: 1 })).toBe(true);
    expect(isRunnerMessage({ type: 'result', valueJson: '3', printBuffer: 'x', durationMs: 0 })).toBe(true);
    expect(
      isRunnerMessage({ type: 'error', error: { name: 'AppError', code: 'INTERNAL', message: 'm' } }),
    ).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 5],
    ['an unknown type that carries a valid error body', { type: 'ping', error: { name: 'AppError', code: 'INTERNAL', message: 'm' } }],
    ['a string', 'result'],
    ['no type', {}],
    ['unknown type', { type: 'ping' }],
    ['result with a numeric valueJson', { type: 'result', valueJson: 3, printBuffer: '', durationMs: 1 }],
    ['result without valueJson', { type: 'result', printBuffer: '', durationMs: 1 }],
    ['result with a non-string printBuffer', { type: 'result', valueJson: null, printBuffer: 1, durationMs: 1 }],
    ['result with a non-number duration', { type: 'result', valueJson: null, printBuffer: '', durationMs: '1' }],
    ['error without a body', { type: 'error' }],
    ['error with a null body', { type: 'error', error: null }],
    ['error without a name', { type: 'error', error: { code: 'INTERNAL', message: 'm' } }],
    ['error without a code', { type: 'error', error: { name: 'AppError', message: 'm' } }],
    ['error without a message', { type: 'error', error: { name: 'AppError', code: 'INTERNAL' } }],
  ])('rejects %s', (_what, value) => {
    expect(isRunnerMessage(value)).toBe(false);
  });
});
