import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Text-level guard: the real proof is scripts/verify-fuses.mjs against the
// packaged output, but this catches the config being edited or dropped early.
const config = readFileSync(resolve(__dirname, '../../electron-builder.yml'), 'utf8');

describe('electron-builder.yml fuses', () => {
  it.each([
    'runAsNode: false',
    'enableNodeOptionsEnvironmentVariable: false',
    'enableNodeCliInspectArguments: false',
    'enableCookieEncryption: true',
    'onlyLoadAppFromAsar: true',
    'enableEmbeddedAsarIntegrityValidation: true',
    'grantFileProtocolExtraPrivileges: true',
  ])('sets %s', (line) => {
    expect(config).toMatch(new RegExp(`^  ${line}\\s*(#.*)?$`, 'm'));
  });

  it('declares the electronFuses block', () => {
    expect(config).toMatch(/^electronFuses:\s*$/m);
  });
});
