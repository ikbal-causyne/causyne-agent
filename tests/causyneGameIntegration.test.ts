import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  installGameStudio,
  locateGameStudio
} from '../src/game/gameProvisioner.js';
import {
  getGameStudioStatus,
  launchGameStudio,
  stopGameStudio
} from '../src/game/gameLauncher.js';
import { startCausyneCoreBridge } from '../src/game/causyneCoreBridge.js';
import { renderSkybridgeHtml } from '../src/web/skybridgeUi.js';
import { PRIMARY_ACTIONS } from '../src/tui/home.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIBLING_GAME_DIR = path.resolve(REPO_ROOT, '..', 'causyne-game');

test('locateGameStudio prioritizes explicit dir > CAUSYNE_GAME_DIR > managed current.json > sibling checkout', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-game-loc-'));
  const prevHome = process.env.CAUSYNE_HOME;
  const prevGameDir = process.env.CAUSYNE_GAME_DIR;
  try {
    const makeFakeStudio = (dir: string, version: string) => {
      fs.mkdirSync(path.join(dir, 'studio', 'build'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'server.ts'), '// stub\n');
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@causyne/game', version }));
      fs.writeFileSync(path.join(dir, 'studio', 'build', 'index.html'), '<title>Causyne Game</title>');
    };

    const explicitDir = path.join(tmp, 'explicit');
    const envDir = path.join(tmp, 'env');
    const homeDir = path.join(tmp, 'home');
    const managedDir = path.join(homeDir, 'game', 'versions', '0.9.9');
    makeFakeStudio(explicitDir, '0.1.1');
    makeFakeStudio(envDir, '0.2.2');
    makeFakeStudio(managedDir, '0.9.9');
    fs.mkdirSync(path.join(homeDir, 'game'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, 'game', 'current.json'),
      JSON.stringify({ product: 'causyne-game', version: '0.9.9' })
    );

    process.env.CAUSYNE_HOME = homeDir;
    process.env.CAUSYNE_GAME_DIR = envDir;

    const fromExplicit = locateGameStudio(explicitDir);
    assert.equal(fromExplicit?.source, 'explicit');
    assert.equal(fromExplicit?.version, '0.1.1');
    assert.equal(fromExplicit?.hasStudioBuild, true);

    const fromEnv = locateGameStudio();
    assert.equal(fromEnv?.source, 'env');
    assert.equal(fromEnv?.version, '0.2.2');

    delete process.env.CAUSYNE_GAME_DIR;
    const fromManaged = locateGameStudio();
    assert.equal(fromManaged?.source, 'managed');
    assert.equal(fromManaged?.version, '0.9.9');

    fs.rmSync(path.join(homeDir, 'game', 'current.json'));
    const fromSibling = locateGameStudio();
    if (fs.existsSync(path.join(SIBLING_GAME_DIR, 'server.ts'))) {
      assert.equal(fromSibling?.source, 'sibling');
      assert.equal(fromSibling?.dir, SIBLING_GAME_DIR);
    }
  } finally {
    if (prevHome === undefined) delete process.env.CAUSYNE_HOME;
    else process.env.CAUSYNE_HOME = prevHome;
    if (prevGameDir === undefined) delete process.env.CAUSYNE_GAME_DIR;
    else process.env.CAUSYNE_GAME_DIR = prevGameDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('installGameStudio enforces consent, validates SHA-256, and atomically installs managed bundle', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-game-inst-'));
  const prevHome = process.env.CAUSYNE_HOME;
  try {
    const homeDir = path.join(tmp, 'home');
    const srcDir = path.join(tmp, 'bundle-src', 'causyne-game');
    fs.mkdirSync(path.join(srcDir, 'build'), { recursive: true });
    fs.mkdirSync(path.join(srcDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'server.ts'), '// causyne-game stub\n');
    fs.writeFileSync(path.join(srcDir, 'package.json'), JSON.stringify({ name: '@causyne/game', version: '0.2.0' }));
    fs.writeFileSync(path.join(srcDir, 'build', 'index.html'), '<title>Causyne Game</title>');

    const archivePath = path.join(tmp, 'causyne-game-0.2.0.tar.gz');
    execFileSync('tar', ['-czf', archivePath, '-C', path.join(tmp, 'bundle-src'), 'causyne-game']);
    const archiveBytes = fs.readFileSync(archivePath);
    const sha256 = crypto.createHash('sha256').update(archiveBytes).digest('hex');

    const manifestPath = path.join(tmp, 'causyne-game.json');
    const writeManifest = (digest: string) => {
      fs.writeFileSync(manifestPath, JSON.stringify({
        schema: 1,
        product: 'causyne-game',
        version: '0.2.0',
        license: 'Apache-2.0',
        archive: {
          url: pathToFileURL(archivePath).href,
          sha256: digest,
          size: archiveBytes.length,
          format: 'tar.gz'
        }
      }));
    };

    process.env.CAUSYNE_HOME = homeDir;

    // 1. Consent gate must hold when confirm=false
    writeManifest(sha256);
    const pending = await installGameStudio({ confirm: false, manifestUrl: pathToFileURL(manifestPath).href });
    assert.equal(pending.success, false);
    assert.equal(pending.requiresConsent, true);
    assert.equal(pending.version, '0.2.0');

    // 2. Tampered SHA-256 must fail before extraction
    writeManifest('0'.repeat(64));
    const tampered = await installGameStudio({ confirm: true, manifestUrl: pathToFileURL(manifestPath).href });
    assert.equal(tampered.success, false);
    assert.match(tampered.error || '', /SHA-256/i);

    // 3. Valid SHA-256 installs cleanly and updates current.json
    writeManifest(sha256);
    const installed = await installGameStudio({ confirm: true, manifestUrl: pathToFileURL(manifestPath).href });
    assert.equal(installed.success, true);
    assert.equal(installed.installed, true);
    assert.equal(installed.alreadyInstalled, false);
    assert.ok(installed.path && fs.existsSync(path.join(installed.path, 'server.ts')));

    // 4. Subsequent install reports alreadyInstalled=true
    const repeat = await installGameStudio({ confirm: true, manifestUrl: pathToFileURL(manifestPath).href });
    assert.equal(repeat.success, true);
    assert.equal(repeat.alreadyInstalled, true);

    // 5. Reject non-HTTPS remote manifests
    const insecure = await installGameStudio({ confirm: true, manifestUrl: 'http://example.com/causyne-game.json' });
    assert.equal(insecure.success, false);
    assert.match(insecure.error || '', /HTTPS/i);
  } finally {
    if (prevHome === undefined) delete process.env.CAUSYNE_HOME;
    else process.env.CAUSYNE_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('launchGameStudio starts sibling causyne-game on loopback, serves Causyne Game UI, and stops cleanly', async (t) => {
  const located = locateGameStudio();
  if (!located || !located.hasNodeModules || !located.hasStudioBuild) {
    t.skip('Built sibling causyne-game not present in this test environment');
    return;
  }

  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-game-live-'));
  try {
    const launched = await launchGameStudio({
      dir: located.dir,
      dataDir: tmpData,
      openBrowser: false,
      copyToClipboard: false,
      startupTimeoutMs: 25_000
    });
    assert.match(launched.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(launched.reused, false);
    assert.equal(launched.openedBrowser, false);

    const status = getGameStudioStatus();
    assert.equal(status.running, true);
    assert.equal(status.port, launched.port);

    const healthRes = await fetch(`${launched.origin}/api/health`);
    assert.equal(healthRes.status, 200);

    const htmlRes = await fetch(`${launched.origin}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /Causyne Game/i);
    assert.doesNotMatch(html, /OpenDesign —/i);

    const reused = await launchGameStudio({
      dir: located.dir,
      dataDir: tmpData,
      openBrowser: false,
      copyToClipboard: false
    });
    assert.equal(reused.reused, true);
    assert.equal(reused.port, launched.port);

    const stopped = await stopGameStudio();
    assert.equal(stopped, true);
    assert.equal(getGameStudioStatus().running, false);
  } finally {
    await stopGameStudio();
    fs.rmSync(tmpData, { recursive: true, force: true });
  }
});

test('Causyne Game is summonable from TUI Home menu and Skybridge Web GUI', () => {
  const homeGameAction = PRIMARY_ACTIONS.find((a) => a.id === 'game');
  assert.ok(homeGameAction, 'TUI PRIMARY_ACTIONS should include Causyne Game (/game)');
  assert.equal(homeGameAction.command, '/game');

  const html = renderSkybridgeHtml({ cspNonce: 'test-nonce', workspaceName: 'TestWS', version: '1.20.124' });
  assert.match(html, /id="nav-game-btn"/);
  assert.match(html, /Causyne Game/);
  assert.match(html, /src="\/assets\/client\/main\.js"/);

  const gameClientSrc = fs.readFileSync(
    path.join(process.cwd(), 'src/web/client/gameLauncherUi.ts'),
    'utf8'
  );
  assert.match(gameClientSrc, /\/api\/game\/launch/);
  assert.match(gameClientSrc, /\/api\/game\/status/);
});

test('CausyneCoreBridge enforces 256-bit Bearer auth, validates stdio MCP servers, and serves health & models', async () => {
  const bridge = await startCausyneCoreBridge();
  try {
    assert.match(bridge.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(bridge.token.length, 64);

    // 1. Unauthenticated requests must be rejected with 401
    const unauth = await fetch(`${bridge.origin}/v1/health`);
    assert.equal(unauth.status, 401);

    // 2. Wrong Bearer token must be rejected with 401
    const wrong = await fetch(`${bridge.origin}/v1/health`, {
      headers: { Authorization: 'Bearer ' + '0'.repeat(64) }
    });
    assert.equal(wrong.status, 401);

    // 3. Valid Bearer token serves health with mode='direct-core'
    const healthRes = await fetch(`${bridge.origin}/v1/health`, {
      headers: { Authorization: `Bearer ${bridge.token}` }
    });
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json() as Record<string, unknown>;
    assert.equal(health.ok, true);
    assert.equal(health.agent, 'causyne');
    assert.equal(health.mode, 'direct-core');

    // 4. Valid Bearer token serves discovered models
    const modelsRes = await fetch(`${bridge.origin}/v1/models`, {
      headers: { Authorization: `Bearer ${bridge.token}` }
    });
    assert.equal(modelsRes.status, 200);
    const models = await modelsRes.json() as { ok: boolean; models: unknown[] };
    assert.equal(models.ok, true);
    assert.ok(Array.isArray(models.models) && models.models.length > 0);

    // 5. Reject HTTP MCP servers on /v1/turn with 400
    const badMcpRes = await fetch(`${bridge.origin}/v1/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        cwd: REPO_ROOT,
        prompt: 'hello',
        mcpServers: [{ name: 'bad', type: 'http', url: 'https://example.com/mcp' }]
      })
    });
    assert.equal(badMcpRes.status, 400);

    // 6. Reject empty prompt with 400
    const emptyPromptRes = await fetch(`${bridge.origin}/v1/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ cwd: REPO_ROOT, prompt: '   ' })
    });
    assert.equal(emptyPromptRes.status, 400);
  } finally {
    await bridge.close();
  }
});
