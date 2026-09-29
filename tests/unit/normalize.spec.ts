import { describe, it, expect } from 'vitest';
import { normalizeConnectionInput } from '../../electron/mongo/normalize';
import type { ConnectionInput } from '../../shared/types';

describe('normalizeConnectionInput', () => {
  it('trims and collapses whitespace in name', () => {
    const out = normalizeConnectionInput({ name: '  my   conn  ' });
    expect(out.name).toBe('my conn');
  });

  it('lowercases host', () => {
    const out = normalizeConnectionInput({ host: ' CLUSTER.MongoDB.NET ' });
    expect(out.host).toBe('cluster.mongodb.net');
  });

  it('trims authUsername, authDatabase, defaultDb', () => {
    const out = normalizeConnectionInput({
      authUsername: '  alice  ',
      authDatabase: '  admin  ',
      defaultDb: '  mydb  ',
    });
    expect(out.authUsername).toBe('alice');
    expect(out.authDatabase).toBe('admin');
    expect(out.defaultDb).toBe('mydb');
  });

  it('trims appName within advanced', () => {
    const out = normalizeConnectionInput({
      advanced: {
        connectTimeoutMs: 1000,
        socketTimeoutMs: 1000,
        serverSelectionTimeoutMs: 1000,
        readPreference: 'primary',
        maxPoolSize: 1,
        directConnection: false,
        appName: '  my-app  ',
      },
    });
    expect(out.advanced?.appName).toBe('my-app');
  });

  it('leaves a non-string appName alone (does not crash trying to trim it)', () => {
    const out = normalizeConnectionInput({
      advanced: {
        connectTimeoutMs: 1000,
        socketTimeoutMs: 1000,
        serverSelectionTimeoutMs: 1000,
        readPreference: 'primary',
        maxPoolSize: 1,
        directConnection: false,
        appName: 123 as unknown as string,
      },
    });
    expect(out.advanced?.appName as unknown).toBe(123);
  });

  it('leaves `tls` untouched (not even set to `{}`) when absent', () => {
    const out = normalizeConnectionInput<Partial<ConnectionInput>>({ name: 'x' });
    expect(out.tls).toBeUndefined();
  });

  it('trims both TLS paths independently', () => {
    const out = normalizeConnectionInput({
      tls: {
        enabled: true,
        verify: true,
        caPath: '  /abs/ca.pem  ',
        clientCertPath: '  /abs/client.pem  ',
      },
    });
    expect(out.tls?.caPath).toBe('/abs/ca.pem');
    expect(out.tls?.clientCertPath).toBe('/abs/client.pem');
  });

  it('leaves a non-string clientCertPath alone', () => {
    const out = normalizeConnectionInput({
      tls: { enabled: true, verify: true, clientCertPath: 42 as unknown as string },
    });
    expect(out.tls?.clientCertPath as unknown).toBe(42);
  });

  it('leaves `ssh` untouched (not even set to `{}`) when absent', () => {
    const out = normalizeConnectionInput<Partial<ConnectionInput>>({ name: 'x' });
    expect(out.ssh).toBeUndefined();
  });

  it('trims ssh.host, ssh.username, and ssh.privateKeyPath independently', () => {
    const out = normalizeConnectionInput({
      ssh: {
        enabled: true,
        host: '  bastion.example.com  ',
        port: 22,
        username: '  deploy  ',
        privateKeyPath: '  /home/deploy/.ssh/id_ed25519  ',
      },
    });
    expect(out.ssh?.host).toBe('bastion.example.com');
    expect(out.ssh?.username).toBe('deploy');
    expect(out.ssh?.privateKeyPath).toBe('/home/deploy/.ssh/id_ed25519');
  });

  it('leaves non-string ssh.host/username/privateKeyPath alone', () => {
    const out = normalizeConnectionInput({
      ssh: {
        enabled: true,
        host: 7 as unknown as string,
        port: 22,
        username: false as unknown as string,
        privateKeyPath: null as unknown as string,
      },
    });
    expect(out.ssh?.host as unknown).toBe(7);
    expect(out.ssh?.username as unknown).toBe(false);
    expect(out.ssh?.privateKeyPath).toBeNull();
  });

  it('leaves unrelated fields alone', () => {
    const out = normalizeConnectionInput({ color: '#1A6835', port: 27017 });
    expect(out.color).toBe('#1A6835');
    expect(out.port).toBe(27017);
  });

  it('is non-destructive of the input object', () => {
    const original = { name: '  X  ' };
    const out = normalizeConnectionInput(original);
    expect(original.name).toBe('  X  ');
    expect(out.name).toBe('X');
  });
});
