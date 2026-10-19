import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('public installers use the official package without lifecycle scripts', () => {
  for (const file of ['install/install.sh', 'install/install.ps1']) {
    const source = read(file);
    assert.match(source, /@causyne\/agent@latest/);
    assert.match(source, /--ignore-scripts/);
    assert.match(source, /--no-audit/);
    assert.match(source, /--no-fund/);
    assert.doesNotMatch(source, /\bsudo\b/);
    assert.doesNotMatch(source, /NPM_TOKEN|NODE_AUTH_TOKEN|npm_[A-Za-z0-9]{20,}/);
  }
});

test('installers create both supported command names and preserve the caller workspace', () => {
  const unix = read('install/install.sh');
  const windows = read('install/install.ps1');
  for (const source of [unix, windows]) {
    assert.match(source, /causyne-agent/);
    assert.match(source, /CAUSYNE_INSTALL_ROOT/);
    assert.doesNotMatch(source, /\bcd\s+['"]?\$?(?:HOME|InstallRoot|INSTALL_ROOT)/i);
  }
});

test('GitHub release publishing is gated by cross-platform validation and provenance', () => {
  const workflow = read('.github/workflows/release.yml');
  assert.match(workflow, /os: \[ubuntu-latest, macos-latest, windows-latest\]/);
  assert.match(workflow, /publish:\n(?:.|\n)*?needs: validate/);
  assert.match(workflow, /npm publish[^\n]+--provenance/);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN/);
});
