import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runCommand, resolveCommand } from '../src/commands.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { openBrowserUrl } from '../src/utils/browserOpen.js';
import { getGuiServerStatus, stopGuiServer } from '../src/web/guiLauncher.js';
import { renderSkybridgeHtml, getCausyneFaviconSvg } from '../src/web/skybridgeUi.js';
import { StatusLine } from '../src/tui/statusLine.js';
import { ChatPrompt } from '../src/tui/prompt.js';
import { sessionSidebarRows } from '../src/tui/sessionSidebar.js';
import { cycleModeControl, cycleVariantControl } from '../src/tui/composerControls.js';
import { stripAnsi } from '../src/tui/text.js';
import { parseVariantOption, runHeadlessTask } from '../src/headlessCli.js';
import { PRIMARY_ACTIONS } from '../src/tui/home.js';
import { suggest } from '../src/tui/completion.js';

const BIN_PATH = fileURLToPath(new URL('../bin/causyne.js', import.meta.url));

describe('CLI Public Release Readiness — /gui, Variant Pill, Shortcuts, Doctor, Headless', () => {
  test('/gui command launches, reuses, reports status, and stops cleanly with zero orphan server', async () => {
    assert.equal(resolveCommand('gui')?.name, 'gui');
    assert.equal(resolveCommand('web')?.name, 'gui');
    assert.equal(resolveCommand('studio')?.name, 'gui');
    assert.ok(PRIMARY_ACTIONS.some((a) => a.id === 'gui' && a.command === '/gui'));

    const { items } = suggest('/', 1);
    assert.ok(items.some((item) => item.label === '/gui'));

    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-gui-cmd-'));
    try {
      const startRes = await runCommand('gui', ['--no-open'], {
        loop: { workspaceRoot: tmpWs }
      });
      assert.equal(startRes.ok, true);
      assert.match(startRes.output || '', /http:\/\/127\.0\.0\.1:\d+\/#token=/);

      const running = getGuiServerStatus();
      assert.equal(running.running, true);
      const expectedRoot = typeof fs.realpathSync.native === 'function'
        ? fs.realpathSync.native(tmpWs)
        : fs.realpathSync(tmpWs);
      assert.equal(running.workspaceRoot, expectedRoot);

      // Re-invoking on same workspace reuses the same port without spawning a second server
      const reuseRes = await runCommand('gui', ['--no-open'], {
        loop: { workspaceRoot: tmpWs }
      });
      assert.equal(reuseRes.ok, true);
      assert.match(reuseRes.output || '', /already running/i);
      assert.equal(getGuiServerStatus().port, running.port);

      const statusRes = await runCommand('gui', ['status'], {});
      assert.equal(statusRes.ok, true);
      assert.match(statusRes.output || '', /Running/);

      const stopRes = await runCommand('gui', ['stop'], {});
      assert.equal(stopRes.ok, true);
      assert.equal(getGuiServerStatus().running, false);
    } finally {
      await stopGuiServer();
      fs.rmSync(tmpWs, { recursive: true, force: true });
    }
  });

  test('openBrowserUrl blocks invalid URLs and skips spawn with port-forward hint on SSH/headless Linux', async () => {
    const bad = await openBrowserUrl('javascript:alert(1)');
    assert.equal(bad.opened, false);
    assert.equal(bad.reason, 'invalid-url');

    const sshRes = await openBrowserUrl('http://127.0.0.1:41234/#token=abc', {
      platform: 'linux',
      env: { SSH_TTY: '/dev/pts/0' }
    });
    assert.equal(sshRes.opened, false);
    assert.equal(sshRes.reason, 'ssh');
    assert.match(sshRes.hint || '', /ssh -L 41234:127\.0\.0\.1:41234/);

    const headlessRes = await openBrowserUrl('http://127.0.0.1:41234/#token=abc', {
      platform: 'linux',
      env: {}
    });
    assert.equal(headlessRes.opened, false);
    assert.equal(headlessRes.reason, 'headless');
  });

  test('StatusLine, ChatPrompt.agentRow, and sessionSidebarRows render active variant pill cleanly', () => {
    const status = new StatusLine();
    status.setSession({ provider: 'openai', model: 'gpt-5.4', variant: 'xhigh' });
    const renderedStatus = stripAnsi(status.render({ message: 'working', width: 100 }));
    assert.match(renderedStatus, /gpt-5\.4 \[xhigh\]/);
    const staticStatus = stripAnsi(status.renderStatic('done', 100));
    assert.match(staticStatus, /gpt-5\.4 \[xhigh\]/);

    const out = { columns: 120, rows: 40, write: () => true };
    const input = { isTTY: true };
    const prompt = new ChatPrompt({ out, input });
    prompt.attach({ status });
    const row = stripAnsi(prompt.agentRow(120) || '');
    assert.match(row, /gpt-5\.4/);
    assert.match(row, /\[xhigh\]/);

    prompt.updateModel('openai', 'gpt-5.4', '');
    const clearedRow = stripAnsi(prompt.agentRow(120) || '');
    assert.ok(!clearedRow.includes('[xhigh]'));

    const sidebar = sessionSidebarRows({
      title: 'Session',
      provider: 'openai',
      model: 'gpt-5.4',
      variant: 'high',
      cwd: '/tmp/ws'
    }, 30, 34).map(stripAnsi).join('\n');
    assert.match(sidebar, /Variant · high/);
  });

  test('Ctrl+T cycles detected variants and Shift+Tab cycles autonomy modes A -> B -> C', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-cycle-test-'));
    const prevHome = process.env.CAUSYNE_HOME;
    process.env.CAUSYNE_HOME = tmpHome;
    try {
      saveConfig({ provider: 'openai', model: 'gpt-5.4', autonomyMode: 'A' });
      const delivered: string[] = [];
      const mockPrompt = {
        notice: '',
        openLayer() {},
        deliver(cmd: string) { delivered.push(cmd); return true; },
        scheduleDraw() {}
      };
      const modes: string[] = [];
      const mockLoop = {
        config: { autonomyMode: 'A' as string },
        setAutonomyMode(m: string) {
          this.config.autonomyMode = m;
          modes.push(m);
        }
      };

      cycleModeControl(mockPrompt, mockLoop);
      cycleModeControl(mockPrompt, mockLoop);
      cycleModeControl(mockPrompt, mockLoop);
      assert.deepEqual(modes, ['B', 'C', 'A']);

      // First Ctrl+T moves from auto -> first supported variant ('none')
      cycleVariantControl(mockPrompt, mockLoop);
      assert.equal(delivered[0], '/variant none');

      saveConfig({ provider: 'openai', model: 'gpt-5.4', reasoningEffort: 'high' });
      cycleVariantControl(mockPrompt, mockLoop);
      assert.equal(delivered[1], '/variant xhigh');

      // Shift+Tab key binding triggers onCycleMode on ChatPrompt
      let shiftTabFired = 0;
      const prompt = new ChatPrompt({
        out: { columns: 120, rows: 40, write: () => true },
        input: { isTTY: true },
        onCycleMode: () => { shiftTabFired++; }
      });
      prompt.handleKey({ name: 'tab', shift: true });
      await Promise.resolve();
      assert.equal(shiftTabFired, 1);
    } finally {
      if (prevHome === undefined) delete process.env.CAUSYNE_HOME;
      else process.env.CAUSYNE_HOME = prevHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('headless --variant parsing, recursive --json-schema validation, POSIX 124 timeout exit, and -v flag', async () => {
    assert.equal(parseVariantOption('extra-high'), 'xhigh');
    assert.equal(parseVariantOption('auto'), undefined);
    assert.throws(() => parseVariantOption('bad;rm -rf'), /Invalid --variant/);

    const prevExitCode = process.exitCode;
    try {
      // Nested schema property type mismatch must fail validation
      const schemaFail = await runHeadlessTask('emit json', {
        outputFormat: 'json',
        jsonSchema: {
          type: 'object',
          required: ['status', 'items'],
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['ok', 'fail'] },
            items: { type: 'array', items: { type: 'integer' } }
          }
        },
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        loopFactory: (sink) => ({
          config: { provider: 'openai', model: 'gpt-5.4' },
          _causyneTaskOutcome: 'completed',
          run: async () => {
            sink.send(JSON.stringify({ type: 'agent_message', content: '{"status":"ok","items":["not-int"]}' }));
          }
        })
      });
      assert.equal(schemaFail.ok, false);
      assert.match(schemaFail.error || '', /\$\.items\[0\] expected type integer/);

      // Timeout sets POSIX exit code 124
      const timeoutRes = await runHeadlessTask('hang', {
        outputFormat: 'json',
        timeoutMs: 50,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        loopFactory: () => ({
          config: { provider: 'openai', model: 'gpt-5.4' },
          _causyneTaskOutcome: 'incomplete',
          abort: () => {},
          run: async () => { await new Promise((r) => setTimeout(r, 120)); }
        })
      });
      assert.equal(timeoutRes.ok, false);
      assert.equal(process.exitCode, 124);
    } finally {
      process.exitCode = prevExitCode ?? 0;
    }

    // -v, -V, and --version all print version cleanly without network stall
    for (const flag of ['-v', '-V', '--version']) {
      const versionOut = execFileSync(process.execPath, [BIN_PATH, flag], {
        encoding: 'utf8',
        timeout: 5000
      }).trim();
      assert.match(versionOut, /^\d+\.\d+\.\d+/, `flag ${flag} must print semver`);
    }
  });

  test('/doctor reports warnings honestly when no provider is configured instead of claiming all invariants passed', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-doctor-honest-'));
    const prevHome = process.env.CAUSYNE_HOME;
    process.env.CAUSYNE_HOME = tmpHome;
    try {
      saveConfig({});
      const res = await runCommand('doctor', [], {});
      assert.equal(res.ok, true);
      assert.match(res.output || '', /warning/i);
      assert.ok(!(res.output || '').includes('All diagnostic invariants passed.'));
    } finally {
      if (prevHome === undefined) delete process.env.CAUSYNE_HOME;
      else process.env.CAUSYNE_HOME = prevHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('Web Studio GUI embeds the official 6-blade Causyne SVG, favicon, and looping aperture animations', async () => {
    const html = renderSkybridgeHtml({ cspNonce: 'nonce123', workspaceName: 'Demo', version: '1.20.122' });
    assert.match(html, /viewBox="0 0 1254 1254"/);
    assert.match(html, /causyne-blade b1/);
    assert.match(html, /causyne-blade b6/);
    assert.match(html, /causyne-aperture-orbit/);
    assert.match(html, /causyne-blade-chase/);
    assert.match(html, /turn-live-row/);
    assert.match(html, /hero-mark/);
    assert.match(html, /href="\/favicon\.svg"/);

    const fav = getCausyneFaviconSvg();
    assert.match(fav, /viewBox="0 0 1254 1254"/);
    assert.match(fav, /#ABDB5F/);
    assert.match(fav, /#383D45/);
  });
});
