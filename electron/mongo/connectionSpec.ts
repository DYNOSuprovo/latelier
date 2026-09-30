import type { MongoClientOptions } from 'mongodb';
import { ValidationError } from '../errors.ts';

/**
 * Everything a separate process needs to open its own MongoClient for a saved
 * Connection. Carries credentials (they are inside `uri`), so it may only be
 * sent over a message port, never placed in argv, env or a log line.
 */
export interface ConnectionSpec {
  uri: string;
  /** Driver options with TLS material as PEM contents, never file paths. */
  options: Record<string, unknown>;
  readOnly: boolean;
}

/**
 * Replace the TLS file-path options with the file contents, so the receiving
 * process needs no filesystem access of its own. `tlsCertificateKeyFile` holds
 * the client certificate and its private key in one PEM, which the driver hands
 * to TLS as both `cert` and `key`; this does the same.
 */
export function inlineTlsFiles(
  options: MongoClientOptions,
  readFile: (path: string) => string,
): Record<string, unknown> {
  const { tlsCAFile, tlsCertificateKeyFile, ...rest } = options;
  const out: Record<string, unknown> = { ...rest };
  if (tlsCAFile !== undefined) out.ca = readPem(readFile, tlsCAFile, 'CA');
  if (tlsCertificateKeyFile !== undefined) {
    const pem = readPem(readFile, tlsCertificateKeyFile, 'client certificate');
    out.cert = pem;
    out.key = pem;
  }
  return out;
}

function readPem(readFile: (path: string) => string, path: string, what: string): string {
  try {
    return readFile(path);
  } catch (err) {
    throw new ValidationError(`cannot read the TLS ${what} file: ${(err as Error).message}`, {
      field: 'tls',
    });
  }
}
