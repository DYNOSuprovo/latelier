import { describe, it, expect } from 'vitest';
import { classifyMongoError, SECRET_UNREADABLE_MESSAGE } from '../../electron/mongo/errors';
import { SystemError, ValidationError } from '../../electron/errors';

describe('classifyMongoError', () => {
  it('an unreadable vault secret → SECRET_UNREADABLE with the re-enter message (#396)', () => {
    expect(classifyMongoError(new SystemError('SECRET_DECRYPT_FAILED', 'decrypt failed'))).toEqual({
      code: 'SECRET_UNREADABLE',
      message: "This connection's saved password can't be read on this install. Re-enter it.",
    });
    expect(SECRET_UNREADABLE_MESSAGE).toContain('Re-enter it.');
  });

  it('only the vault error code maps to SECRET_UNREADABLE, not its text or another AppError', () => {
    expect(classifyMongoError(new Error('SECRET_DECRYPT_FAILED')).code).not.toBe('SECRET_UNREADABLE');
    expect(classifyMongoError(new ValidationError('bad')).code).not.toBe('SECRET_UNREADABLE');
  });

  it('AuthenticationFailed → AUTH', () => {
    expect(
      classifyMongoError({ code: 18, codeName: 'AuthenticationFailed', message: 'Authentication failed' }).code,
    ).toBe('AUTH');
  });

  // Each disjunct of the AUTH guard isolated on its own, so a mutant that
  // drops any single one of the three still gets caught by the other two.
  it('AUTH — each of code/codeName/message alone is enough', () => {
    expect(classifyMongoError({ code: 18, message: 'x' }).code).toBe('AUTH');
    expect(classifyMongoError({ codeName: 'AuthenticationFailed', message: 'x' }).code).toBe('AUTH');
    expect(classifyMongoError({ message: 'auth fail' }).code).toBe('AUTH');
    expect(classifyMongoError({ message: 'authentication failed for user' }).code).toBe('AUTH');
  });

  it('Unauthorized → UNAUTHORIZED', () => {
    expect(
      classifyMongoError({ code: 13, codeName: 'Unauthorized', message: 'not authorized on db' }).code,
    ).toBe('UNAUTHORIZED');
  });

  // Same isolation for UNAUTHORIZED's three disjuncts.
  it('UNAUTHORIZED — each of code/codeName/message alone is enough', () => {
    expect(classifyMongoError({ code: 13, message: 'x' }).code).toBe('UNAUTHORIZED');
    expect(classifyMongoError({ codeName: 'Unauthorized', message: 'x' }).code).toBe('UNAUTHORIZED');
    expect(classifyMongoError({ message: 'not authorized to do this' }).code).toBe('UNAUTHORIZED');
  });

  it('MongoServerSelectionError → TIMEOUT', () => {
    expect(classifyMongoError({ name: 'MongoServerSelectionError', message: 'selection' }).code).toBe(
      'TIMEOUT',
    );
  });

  // codeName alone, without the name matching, must also reach TIMEOUT.
  it('MaxTimeMSExpired codeName alone → TIMEOUT, no matching name needed', () => {
    expect(classifyMongoError({ codeName: 'MaxTimeMSExpired', message: 'exceeded' }).code).toBe('TIMEOUT');
  });

  it('ENOTFOUND/ECONNREFUSED → NETWORK', () => {
    expect(classifyMongoError({ message: 'getaddrinfo ENOTFOUND nope' }).code).toBe('NETWORK');
    expect(classifyMongoError({ message: 'connect ECONNREFUSED 127.0.0.1:1' }).code).toBe('NETWORK');
  });

  it('EAI_AGAIN/ECONNRESET/ETIMEDOUT → NETWORK', () => {
    expect(classifyMongoError({ message: 'getaddrinfo EAI_AGAIN nope' }).code).toBe('NETWORK');
    expect(classifyMongoError({ message: 'read ECONNRESET' }).code).toBe('NETWORK');
    expect(classifyMongoError({ message: 'connect ETIMEDOUT 1.2.3.4:27017' }).code).toBe('NETWORK');
  });

  it('TLS handshake failures → TLS_HANDSHAKE', () => {
    expect(
      classifyMongoError({
        message:
          'Client network socket disconnected before secure TLS connection was established',
      }).code,
    ).toBe('TLS_HANDSHAKE');
    expect(classifyMongoError({ message: 'SSL handshake failed' }).code).toBe('TLS_HANDSHAKE');
    expect(classifyMongoError({ message: 'TLS handshake timed out' }).code).toBe('TLS_HANDSHAKE');
  });

  // `/SSL.*handshake/i` needs more than one character between the two words
  // to tell it apart from a mutant narrowed to `/SSL.handshake/i`.
  it('SSL...handshake with several characters between the two words → TLS_HANDSHAKE', () => {
    expect(classifyMongoError({ message: 'SSL routines handshake failure' }).code).toBe(
      'TLS_HANDSHAKE',
    );
  });

  it('certificate-level failures → TLS', () => {
    expect(classifyMongoError({ message: 'self-signed certificate' }).code).toBe('TLS');
    expect(classifyMongoError({ message: 'unable to verify the first certificate' }).code).toBe(
      'TLS',
    );
  });

  // Isolates the `self[- ]signed` character class from the broader
  // `certificate`/`SSL`/`TLS` alternatives it sits beside — this message
  // contains none of those, so it can only reach TLS through this branch,
  // and both the hyphen and the space variant must still match.
  it('"self-signed"/"self signed" alone (no other TLS keyword) → TLS', () => {
    expect(classifyMongoError({ message: 'self-signed key rejected' }).code).toBe('TLS');
    expect(classifyMongoError({ message: 'self signed key rejected' }).code).toBe('TLS');
  });

  it('random errors → UNKNOWN', () => {
    expect(classifyMongoError({ message: 'something weird' }).code).toBe('UNKNOWN');
  });

  it('null/undefined → UNKNOWN', () => {
    expect(classifyMongoError(null)).toEqual({ code: 'UNKNOWN', message: 'unknown error' });
    expect(classifyMongoError(undefined)).toEqual({ code: 'UNKNOWN', message: 'unknown error' });
  });
});
