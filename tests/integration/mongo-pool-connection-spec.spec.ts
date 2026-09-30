import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import { NotFoundError, ValidationError } from '../../electron/errors';
import { createSafeStorageMock } from '../helpers/safeStorageMock';
import { createTempDb, type TempDb } from '../helpers/db';
import { makeConnection, makeReader } from '../helpers/mongo';
import type { Connection } from '@shared/types';

const HP = { host: 'db.example.test', port: 27017 };

describe('MongoPool.connectionSpec', () => {
  let tmp: TempDb | undefined;
  let pkiDir: string | undefined;

  afterEach(() => {
    tmp?.cleanup();
    tmp = undefined;
    if (pkiDir) fs.rmSync(pkiDir, { recursive: true, force: true });
    pkiDir = undefined;
  });

  function poolFor(conn: Connection, password?: string): MongoPool {
    tmp = createTempDb();
    const now = new Date().toISOString();
    tmp.db
      .prepare(
        `INSERT INTO connections (id, name, connection_type, host, port, auth_mech, created_at, updated_at)
         VALUES (?, ?, 'standard', 'localhost', 27017, 'none', ?, ?)`,
      )
      .run(conn.id, conn.name, now, now);
    const vault = new SecretsVault(tmp.db, createSafeStorageMock());
    if (password !== undefined) vault.set(conn.id, 'password', password);
    return new MongoPool({ repo: makeReader([conn]), vault });
  }

  it('builds the URI with the vault password and reports the read-only flag', () => {
    const conn = makeConnection('c', HP, { authMech: 'scram256', authUsername: 'alice', readOnly: true });
    const spec = poolFor(conn, 'p@ss/word').connectionSpec('c');
    expect(spec.uri).toContain('mongodb://alice:p%40ss%2Fword@db.example.test:27017/');
    expect(spec.readOnly).toBe(true);
    expect(spec.options.tls).toBe(false);
  });

  it('reads the flag fresh, not from a cached copy', () => {
    const conn = makeConnection('c', HP);
    const pool = poolFor(conn);
    expect(pool.connectionSpec('c').readOnly).toBe(false);
  });

  it('inlines TLS files as PEM contents, never paths', () => {
    pkiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-spec-pki-'));
    const ca = path.join(pkiDir, 'ca.pem');
    const client = path.join(pkiDir, 'client.pem');
    fs.writeFileSync(ca, 'CA-PEM-CONTENTS');
    fs.writeFileSync(client, 'CLIENT-PEM-CONTENTS');
    const conn = makeConnection('c', HP, {
      tls: { enabled: true, verify: true, caPath: ca, clientCertPath: client },
    });
    const { options } = poolFor(conn).connectionSpec('c');
    expect(options).toMatchObject({
      tls: true,
      ca: 'CA-PEM-CONTENTS',
      cert: 'CLIENT-PEM-CONTENTS',
      key: 'CLIENT-PEM-CONTENTS',
    });
    expect(JSON.stringify(options)).not.toContain(pkiDir);
  });

  it('fails clearly when a TLS file is unreadable', () => {
    const conn = makeConnection('c', HP, {
      tls: { enabled: true, verify: true, caPath: '/no/such/ca.pem' },
    });
    expect(() => poolFor(conn).connectionSpec('c')).toThrow(ValidationError);
  });

  it('throws NotFoundError for an unknown connection', () => {
    const pool = poolFor(makeConnection('c', HP));
    expect(() => pool.connectionSpec('missing')).toThrow(NotFoundError);
  });

  it('refuses a connection with SSH enabled, as connect() does', () => {
    const conn = makeConnection('c', HP, { ssh: { enabled: true, host: 'bastion' } });
    expect(() => poolFor(conn).connectionSpec('c')).toThrow('SSH tunnels are not supported yet');
  });
});
