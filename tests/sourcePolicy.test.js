import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isDevEmulator } from '../src/devMode.js';
import { startUpdateChecker, runSelfUpdate } from '../src/autoUpdate.js';
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
test('update entry points perform no automatic installation', async () => {
  startUpdateChecker();
  assert.equal(await runSelfUpdate(false), false);
  assert.doesNotMatch(read('src/autoUpdate.js'), /execSync|execAsync|setTimeout|setInterval|fetch\(/);
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
