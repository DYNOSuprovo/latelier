import ConnectionString from 'mongodb-connection-string-url';
import { z } from 'zod';
import type {
  ConnectionInput,
  RepickFile,
  UriBatchDefaults,
  UriCredentials,
  UriPreviewEntry,
} from '@shared/types';
import { AppError } from '../errors.ts';
import { parseConnectionUri } from '../mongo/uri-parse.ts';
import { applyCrossFieldRules, BaseInputShape } from '../ipc/schemas/connection.ts';
import { planNames } from './connectionExportFormat.ts';

/** C13 §7.1 — the paste box's limits, also enforced by the channel schema. */
export const MAX_URI_LINES = 100;
export const MAX_URI_LENGTH = 4096;

/** Same default as a new Connection in the form. */
const DEFAULT_COLOR = '#7c6af7';

/** A line that parsed, with what the batch needs from it. */
export interface ParsedLine {
  ok: true;
  input: Partial<ConnectionInput>;
  /** The string set `directConnection` itself, so the batch default must not override it. */
  explicitDirect: boolean;
  warnings: string[];
}
export type Line = ParsedLine | { ok: false; reason: string };

export function parseLine(uri: string): Line {
  try {
    const { input, warnings } = parseConnectionUri(uri);
    return {
      ok: true,
      input,
      // SRV lines never get direct connection, so their params are not read
      // (an SRV string with a port, which the parser tolerates, would not reparse).
      explicitDirect: input.connectionType !== 'srv' && hasParam(uri, 'directconnection'),
      // Stryker disable next-line LogicalOperator: every warning the parser pushes sets `detail` (verified by reading each `warnings.push` in uri-parse.ts); the code is a fallback for one that someday doesn't.
      warnings: warnings.map((w) => w.detail ?? w.code),
    };
  } catch (err) {
    return { ok: false, reason: err instanceof AppError ? err.message : 'Not a connection string' };
  }
}

function hasParam(uri: string, lowerName: string): boolean {
  for (const key of new ConnectionString(uri.trim()).searchParams.keys()) {
    if (key.toLowerCase() === lowerName) return true;
  }
  return false;
}

/**
 * The name each line asks for, before clash renaming: its host, or `host:port`
 * when another line in the batch has the same host on a different port.
 * Unparseable lines get an empty slot so indices stay aligned.
 */
export function baseNames(lines: readonly Line[]): string[] {
  const ports = new Map<string, Set<number>>();
  for (const l of lines) {
    if (!l.ok) continue;
    const set = ports.get(l.input.host!) ?? new Set<number>();
    set.add(l.input.port!);
    ports.set(l.input.host!, set);
  }
  return lines.map((l) => {
    if (!l.ok) return '';
    const host = l.input.host!;
    return ports.get(host)!.size > 1 ? `${host}:${l.input.port}` : host;
  });
}

/** Final names: `baseNames`, then §4.2's clash rule against `existing` and the batch. */
export function planLineNames(existing: Iterable<string>, lines: readonly Line[]): string[] {
  const bases = baseNames(lines);
  const okIdx = lines.flatMap((l, i) => (l.ok ? [i] : []));
  const planned = planNames(existing, okIdx.map((i) => bases[i]!));
  const out = lines.map(() => '');
  okIdx.forEach((i, k) => {
    out[i] = planned[k]!;
  });
  return out;
}

/** X.509 authenticates with a certificate and AWS with its own keys: neither is asked for a password here. */
export function needsCredentials(input: Partial<ConnectionInput>): boolean {
  if (input.authMech === 'x509') return false;
  return !input.authUsername || !input.password;
}

export function repickFor(input: Partial<ConnectionInput>): RepickFile[] {
  return input.authMech === 'x509' ? ['tlsClientCert'] : [];
}

export function previewEntry(line: Line, index: number, savedAs: string): UriPreviewEntry {
  if (!line.ok) return { index, ok: false, reason: line.reason };
  const { input } = line;
  return {
    index,
    ok: true,
    savedAs,
    host: input.host!,
    port: input.port!,
    srv: input.connectionType === 'srv',
    ...(input.authUsername ? { authUsername: input.authUsername } : {}),
    hasPassword: Boolean(input.password),
    needsCredentials: needsCredentials(input),
    repick: repickFor(input),
    warnings: line.warnings,
  };
}

/**
 * The Connection a line creates. Credentials typed in the second step win
 * over the string's; a username with no mechanism negotiates (`default`).
 */
export function lineToInput(
  line: ParsedLine,
  name: string,
  defaults: UriBatchDefaults,
  creds: UriCredentials | undefined,
): ConnectionInput {
  const parsed = line.input;
  const username = creds?.username || parsed.authUsername;
  const password = creds?.password || parsed.password;
  const srv = parsed.connectionType === 'srv';
  const authMech =
    parsed.authMech === 'none' && username ? 'default' : parsed.authMech!;
  return {
    name,
    color: DEFAULT_COLOR,
    connectionType: parsed.connectionType!,
    host: parsed.host!,
    port: parsed.port!,
    ...(parsed.defaultDb ? { defaultDb: parsed.defaultDb } : {}),
    authMech,
    ...(username ? { authUsername: username } : {}),
    ...(parsed.authDatabase ? { authDatabase: parsed.authDatabase } : {}),
    ...(password ? { password } : {}),
    tls: parsed.tls!,
    advanced: {
      ...parsed.advanced!,
      // The driver refuses directConnection on an SRV string.
      directConnection: srv
        ? false
        : line.explicitDirect
          ? parsed.advanced!.directConnection
          : defaults.directConnection,
    },
    readOnly: defaults.readOnly,
  };
}

/**
 * The import rules (C13 §4): a password may be missing — it can be entered
 * later — and an X.509 certificate is picked after saving.
 */
const LineInputSchema = z
  .object(BaseInputShape)
  .superRefine((data, ctx) => applyCrossFieldRules(data, ctx, { mode: 'import' }));

/** `null` when valid, otherwise the first problem in words. */
export function lineInputProblem(input: ConnectionInput): string | null {
  const r = LineInputSchema.safeParse(input);
  return r.success ? null : r.error.issues[0]!.message;
}
