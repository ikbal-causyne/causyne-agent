import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDevEmulator } from '../src/devMode.js';
import { compareVersions, startUpdateChecker, runSelfUpdate } from '../src/autoUpdate.js';
import { provisionCortexDependencies } from '../src/cortex/provisioner.js';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
test('release policy exposes source and prohibits hidden installation hooks', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.files.includes('src/'));
  assert.ok(!pkg.files.some(file => /HOLD|dist\/|bundle/.test(file)));
  assert.equal(pkg.dependencies.bytenode, undefined);
  for (const hook of ['preinstall','install','postinstall','prepare']) assert.equal(pkg.scripts[hook], undefined);
  assert.match(read('bin/causyne.js'), /import\('\.\.\/src\/entrypoint\.js'\)/);
});
test('remote implementations are absent from the independent project', () => {
  for (const name of ['daemon','daemonLock','pairing','webrtc','stunProbe','heartbeat','notifications','audioClipStore']) {
    assert.equal(fs.existsSync(new URL(`../src/${name}.js`, import.meta.url)), false);
  }
  const entry = read('src/entrypoint.js');
  for (const command of ['start','stop','restart','pair','unpair']) assert.ok(!entry.includes(`.command('${command}')`));
  for (const file of ['blenderAutomator.js','godotAutomator.js']) {
    const text = read(`src/tools/${file}`);
    assert.doesNotMatch(text, /new WebSocket|fetch\(['"`]http:\/\/127\.0\.0\.1:(9333|9444)/);
  }
});
test('developer flags never bypass approvals', () => {
  assert.equal(isDevEmulator({ testBypass: true }), false);
  assert.equal(isDevEmulator({ testBypass: 'anything' }), false);
});
test('updates are constrained to the official package and managed installs', async () => {
  const calls = [];
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-update-test-'));
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ name: '@causyne/agent', version: '9.0.0' })
  });
  const spawnSyncImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: '', stderr: '' };
  };
  const managedRoot = path.join(os.tmpdir(), 'causyne-managed');
  const result = await runSelfUpdate(false, {
    env: { CAUSYNE_INSTALL_ROOT: managedRoot, CAUSYNE_NPM_COMMAND: 'npm' },
    currentVersion: '1.0.0', fetchImpl, spawnSyncImpl,
    stateFile: path.join(stateRoot, 'update-state.json')
  });
  assert.equal(result.updated, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'npm');
  assert.deepEqual(calls[0].args.slice(0, 4), ['install', '--global', '--prefix', path.resolve(managedRoot)]);
  assert.ok(calls[0].args.includes('@causyne/agent@9.0.0'));
  assert.ok(calls[0].args.includes('--ignore-scripts'));
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.CAUSYNE_INSTALL_ROOT, path.resolve(managedRoot));
  assert.doesNotMatch(read('src/autoUpdate.js'), /execSync|execAsync|setTimeout|setInterval/);
  fs.rmSync(stateRoot, { recursive: true, force: true });
});
test('version comparison follows stable and prerelease ordering', () => {
  assert.equal(compareVersions('1.10.7', '1.10.6'), 1);
  assert.equal(compareVersions('1.10.7-beta.10', '1.10.7-beta.2'), 1);
  assert.equal(compareVersions('1.10.7', '1.10.7-beta.10'), 1);
  assert.equal(compareVersions('1.10.7', '1.10.7'), 0);
});
test('automatic updates can be disabled and source checkouts are never rewritten', async () => {
  assert.equal((await startUpdateChecker({ env: { CAUSYNE_DISABLE_AUTOUPDATE: '1' } })).reason, 'disabled');
  const result = await runSelfUpdate(false, {
    env: {}, packageRoot: '/tmp/causyne-source',
    fetchImpl: async () => { throw new Error('must not reach the network'); }
  });
  assert.equal(result.reason, 'source-checkout');
});
test('missing Cortex dependencies fail explicitly without being installed', async () => {
  await assert.rejects(provisionCortexDependencies(), /Automatic installation is disabled/);
  assert.doesNotMatch(read('src/cortex/provisioner.js'), /execSync|spawn\(|writeFile|npm i/);
});
test('private AI and owner documents are absent from the public project', () => {
  const rootNames = fs.readdirSync(new URL('../', import.meta.url));
  const docNames = fs.readdirSync(new URL('../docs/', import.meta.url));
  assert.equal(rootNames.includes('.agents'), false);
  assert.equal(rootNames.includes('AGENTS.md'), false);
  for (const file of [...rootNames, ...docNames]) {
    assert.doesNotMatch(file, /(?:mastery|vision.and.ambition|handoff|private|releas(?:e|ing)|ai.workflow)/i);
  }
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.author, undefined);
  assert.match(read('README.md'), /under active development/i);
});
test('interpreter scripts ship readable and are sent on stdin', () => {
  for (const file of ['axSnapshot.js','desktopAct.js','resolveAutomator.js']) {
    const text = read(`src/tools/${file}`);
    assert.match(text, /tool-scripts\//);
    assert.doesNotMatch(text, /Buffer\.from\([^\n]+['"]base64['"]|\.reverse\(\)\.join/);
  }
  assert.match(read('src/tool-scripts/resolve_automator.py'), /import sys/);
  assert.match(read('src/tool-scripts/ax_snapshot.applescript'), /tell application/);
});
