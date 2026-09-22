import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const required = [
  'packaging/macos/FPAApp.swift',
  'packaging/macos/build-app.sh',
  'packaging/macos/README.md',
  '.github/workflows/build-macos.yml',
  'scripts/portable-server.mjs',
  'scripts/studio-api.mjs',
  'src/Studio.jsx',
];

for (const file of required) {
  await readFile(new URL(`../${file}`, import.meta.url));
}

const build = await readFile(new URL('../packaging/macos/build-app.sh', import.meta.url), 'utf8');
const workflow = await readFile(new URL('../.github/workflows/build-macos.yml', import.meta.url), 'utf8');
const launcher = await readFile(new URL('../packaging/macos/FPAApp.swift', import.meta.url), 'utf8');

assert.match(build, /sharp-darwin-\$\{SHARP_ARCH\}/);
assert.match(build, /hdiutil create/);
assert.match(build, /codesign --verify/);
assert.match(build, /Library\/Application Support\/FPA/);
assert.match(workflow, /macos-15-intel/);
assert.match(workflow, /macos-15/);
assert.match(launcher, /applicationSupportDirectory/);
assert.match(launcher, /serverProcess\?\.terminate/);

console.log('FPA macOS project structure verified.');
