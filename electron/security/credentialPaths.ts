import { ValidationError } from '../errors.ts';

/**
 * TLS CA, TLS client-certificate and SSH private-key file paths are handed to
 * the Mongo driver (or the SSH client) as-is, so a renderer that could name any
 * absolute path could make main read any file it likes. The same rule that
 * guards data imports applies: a path is accepted only if main's own open
 * dialog returned it, or it is the value the connection already stores.
 */

export const CREDENTIAL_PURPOSES = ['tls-ca', 'tls-client-cert', 'ssh-key'] as const;
export type CredentialPurpose = (typeof CREDENTIAL_PURPOSES)[number];

/** One path per purpose; an absent or empty entry means "no path set". */
export interface CredentialPaths {
  caPath?: string;
  clientCertPath?: string;
  privateKeyPath?: string;
}

/** The wire shape (connection input or patch) the paths are read from. */
export interface CredentialPathSource {
  tls?: { caPath?: string; clientCertPath?: string };
  ssh?: { privateKeyPath?: string };
}

export interface PickedCredentialPaths {
  /** Record a dialog result; any purpose other than a credential one is ignored. */
  record(purpose: string, path: string): void;
  has(purpose: CredentialPurpose, path: string): boolean;
}

/**
 * Purpose-bound: a path picked as an SSH key is not a valid TLS CA, because a
 * set per purpose means the dialog's own filter and intent travel with the path.
 */
export function createPickedCredentialPaths(): PickedCredentialPaths {
  const sets: Record<CredentialPurpose, Set<string>> = {
    'tls-ca': new Set(),
    'tls-client-cert': new Set(),
    'ssh-key': new Set(),
  };
  return {
    record(purpose, path) {
      if (Object.hasOwn(sets, purpose)) sets[purpose as CredentialPurpose].add(path);
    },
    has(purpose, path) {
      return sets[purpose].has(path);
    },
  };
}

export function credentialPathsOf(source: CredentialPathSource): CredentialPaths {
  return {
    caPath: source.tls?.caPath,
    clientCertPath: source.tls?.clientCertPath,
    privateKeyPath: source.ssh?.privateKeyPath,
  };
}

/**
 * Throws a ValidationError, with `issues` paths the connection form renders
 * against the right field, for every non-empty path that was neither picked
 * this session for that purpose nor equal to one of `stored` for the same
 * field. Clearing a path (empty or absent) is always allowed. Equality is
 * exact on the string the dialog returned: no normalisation.
 */
export function assertCredentialPathsAllowed(
  paths: CredentialPaths,
  picked: PickedCredentialPaths,
  stored: readonly CredentialPaths[],
): void {
  const checks: Array<{
    value: string | undefined;
    purpose: CredentialPurpose;
    field: keyof CredentialPaths;
    path: string[];
  }> = [
    { value: paths.caPath, purpose: 'tls-ca', field: 'caPath', path: ['tls', 'caPath'] },
    { value: paths.clientCertPath, purpose: 'tls-client-cert', field: 'clientCertPath', path: ['tls', 'clientCertPath'] },
    { value: paths.privateKeyPath, purpose: 'ssh-key', field: 'privateKeyPath', path: ['ssh', 'privateKeyPath'] },
  ];
  const issues: Array<{ path: string[]; message: string }> = [];
  for (const { value, purpose, field, path } of checks) {
    if (!value) continue;
    if (picked.has(purpose, value) || stored.some((s) => s[field] === value)) continue;
    issues.push({ path, message: 'Choose this file with Browse; typed paths are not accepted' });
  }
  if (issues.length > 0) {
    throw new ValidationError(
      'File paths must be chosen with the file picker',
      { issues },
    );
  }
}
