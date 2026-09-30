// Asserts the Electron fuse state of a packaged app. Usage:
//   node scripts/verify-fuses.mjs [<app or binary> ...]
// With no arguments it checks every app electron-builder left under release/.
// The expected states mirror the `electronFuses` block in electron-builder.yml.
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// @electron/fuses is a transitive dependency of electron-builder; resolve it
// from app-builder-lib so no hoisting layout is assumed.
const requireFromBuilder = createRequire(
  createRequire(join(root, 'package.json')).resolve('app-builder-lib/package.json'),
);
const { getCurrentFuseWire, FuseV1Options } = requireFromBuilder('@electron/fuses');

const DISABLE = 48;
const ENABLE = 49;

const EXPECTED = {
  [FuseV1Options.RunAsNode]: DISABLE,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: DISABLE,
  [FuseV1Options.EnableNodeCliInspectArguments]: DISABLE,
  [FuseV1Options.EnableCookieEncryption]: ENABLE,
  [FuseV1Options.OnlyLoadAppFromAsar]: ENABLE,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: ENABLE,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: ENABLE,
};

const label = (state) =>
  state === ENABLE ? 'enabled' : state === DISABLE ? 'disabled' : `unknown(${state})`;

function discover() {
  const release = join(root, 'release');
  if (!existsSync(release)) return [];
  const found = [];
  for (const dir of readdirSync(release, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const base = join(release, dir.name);
    if (dir.name.startsWith('mac')) {
      for (const f of readdirSync(base)) if (f.endsWith('.app')) found.push(join(base, f));
    } else if (dir.name === 'win-unpacked') {
      for (const f of readdirSync(base)) if (f.endsWith('.exe')) found.push(join(base, f));
    }
  }
  return found;
}

const targets = process.argv.length > 2 ? process.argv.slice(2) : discover();
if (targets.length === 0) {
  throw new Error('verify-fuses: no packaged app given and none found under release/');
}

let failed = false;
for (const target of targets) {
  const wire = await getCurrentFuseWire(target);
  const wrong = Object.entries(EXPECTED)
    .filter(([index, want]) => wire[index] !== want)
    .map(
      ([index, want]) =>
        `${FuseV1Options[index]}: expected ${label(want)}, found ${label(wire[index])}`,
    );
  if (wrong.length === 0) {
    process.stdout.write(`fuses ok: ${target}\n`);
  } else {
    failed = true;
    process.stderr.write(`fuses WRONG: ${target}\n  ${wrong.join('\n  ')}\n`);
  }
}
if (failed) process.exit(1);
