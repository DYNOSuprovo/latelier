import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../electron/errors';
import { inlineTlsFiles } from '../../electron/mongo/connectionSpec';
import { scrubbedRunnerEnv } from '../../electron/services/runner/spawner';

describe('inlineTlsFiles', () => {
  const files: Record<string, string> = {
    '/pki/ca.pem': 'CA-PEM',
    '/pki/client.pem': 'CLIENT-CERT-AND-KEY-PEM',
  };
  const read = (p: string): string => {
    const v = files[p];
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  };

  it('replaces the file-path options with PEM contents', () => {
    const out = inlineTlsFiles(
      { tls: true, tlsCAFile: '/pki/ca.pem', tlsCertificateKeyFile: '/pki/client.pem', maxPoolSize: 5 },
      read,
    );
    expect(out).toEqual({
      tls: true,
      maxPoolSize: 5,
      ca: 'CA-PEM',
      cert: 'CLIENT-CERT-AND-KEY-PEM',
      key: 'CLIENT-CERT-AND-KEY-PEM',
    });
    expect('tlsCAFile' in out).toBe(false);
    expect('tlsCertificateKeyFile' in out).toBe(false);
  });

  it('leaves options without TLS files untouched and reads nothing', () => {
    let reads = 0;
    const out = inlineTlsFiles({ tls: false, connectTimeoutMS: 1000 }, (p) => {
      reads++;
      return p;
    });
    expect(out).toEqual({ tls: false, connectTimeoutMS: 1000 });
    expect(reads).toBe(0);
  });

  it('inlines only the CA when there is no client certificate', () => {
    const out = inlineTlsFiles({ tlsCAFile: '/pki/ca.pem' }, read);
    expect(out).toEqual({ ca: 'CA-PEM' });
  });

  it('inlines only the client certificate when there is no CA', () => {
    const out = inlineTlsFiles({ tlsCertificateKeyFile: '/pki/client.pem' }, read);
    expect(out).toEqual({ cert: 'CLIENT-CERT-AND-KEY-PEM', key: 'CLIENT-CERT-AND-KEY-PEM' });
  });

  it('turns an unreadable CA file into a ValidationError that names what failed', () => {
    let caught: unknown;
    try {
      inlineTlsFiles({ tlsCAFile: '/pki/missing.pem' }, read);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toBe('cannot read the TLS CA file: ENOENT: /pki/missing.pem');
    expect((caught as ValidationError).details).toEqual({ field: 'tls' });
  });

  it('turns an unreadable client certificate into a ValidationError that names what failed', () => {
    expect(() => inlineTlsFiles({ tlsCertificateKeyFile: '/pki/missing.pem' }, read)).toThrow(
      'cannot read the TLS client certificate file: ENOENT: /pki/missing.pem',
    );
  });
});

describe('scrubbedRunnerEnv', () => {
  it('passes the OS basics through and nothing else', () => {
    const out = scrubbedRunnerEnv({
      PATH: '/usr/bin',
      SystemRoot: 'C:\\Windows',
      windir: 'C:\\Windows',
      TEMP: '/t',
      TMP: '/t2',
      TMPDIR: '/t3',
      HOME: '/home/u',
      USERPROFILE: 'C:\\Users\\u',
      AWS_SECRET_ACCESS_KEY: 'leak',
      NODE_OPTIONS: '--inspect',
      ELECTRON_RUN_AS_NODE: '1',
    });
    expect(out).toEqual({
      PATH: '/usr/bin',
      SystemRoot: 'C:\\Windows',
      windir: 'C:\\Windows',
      TEMP: '/t',
      TMP: '/t2',
      TMPDIR: '/t3',
      HOME: '/home/u',
      USERPROFILE: 'C:\\Users\\u',
    });
  });

  it('skips variables that are not set', () => {
    // Keys, not toEqual: toEqual treats a present-but-undefined key as absent.
    expect(Object.keys(scrubbedRunnerEnv({ PATH: '/bin' }))).toEqual(['PATH']);
  });
});
