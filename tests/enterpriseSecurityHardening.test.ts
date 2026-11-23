import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  quoteWindowsCmdArg,
  reconcileWindowsPathEnv,
  resolveWindowsSpawnTarget,
  unwrapNodeCmdShim
} from '../src/utils/winSpawn.js';
import {
  normalizePathForCompare,
  stripWindowsExtendedPrefix
} from '../src/agent/workspaceBoundary.js';
import {
  atomicRename,
  atomicRenameSync,
  atomicWriteFileSync
} from '../src/infra/atomicWriter.js';
import { tokenizeCommandArgs } from '../src/commands.js';
import { KeyDecoder } from '../src/tui/keys.js';
import { LineEditor } from '../src/tui/lineEditor.js';
import { InputLayer } from '../src/tui/dialogs.js';
import { ChatPrompt } from '../src/tui/prompt.js';
import { isWslEnvironment } from '../src/tui/clipboardSync.js';
import {
  detectImageMimeType,
  sanitizeAttachmentFilename
} from '../src/tui/clipboardImage.js';
import {
  drainSuppressedStageDiagnostics,
  registerStageConsoleGuard
} from '../src/tui/consoleGuard.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

describe('Wave 5 — Cross-Platform Reliability, TUI Polish & 100% Pure TypeScript Invariants', () => {
  test('winSpawn unwraps npm .cmd shims to direct Node scripts, quotes cmd args in linear time, and reconciles Path/PATH', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-winspawn-'));
    try {
      const cliDir = path.join(tmpDir, 'node_modules', 'demo-lsp', 'bin');
      fs.mkdirSync(cliDir, { recursive: true });
      const cliEntry = path.join(cliDir, 'server.js');
      fs.writeFileSync(cliEntry, 'console.log("ok");\n', 'utf8');

      const shimPath = path.join(tmpDir, 'demo-lsp.cmd');
      fs.writeFileSync(
        shimPath,
        '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\demo-lsp\\bin\\server.js" %*\r\n',
        'utf8'
      );

      assert.equal(unwrapNodeCmdShim(shimPath), cliEntry);

      const resolved = resolveWindowsSpawnTarget(shimPath, ['--stdio'], {
        platform: 'win32',
        execPath: '/fake/node.exe'
      });
      assert.equal(resolved.resolvedFromShim, true);
      assert.equal(resolved.command, '/fake/node.exe');
      assert.deepEqual(resolved.args, [cliEntry, '--stdio']);

      // Arbitrary non-Node .bat falls back to cmd.exe /d /s /c with safe escaping
      const batPath = path.join(tmpDir, 'tool.bat');
      fs.writeFileSync(batPath, '@echo hi\r\n', 'utf8');
      const batResolved = resolveWindowsSpawnTarget(batPath, ['hello world', 'a&b'], {
        platform: 'win32',
        env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
      });
      assert.equal(batResolved.command, 'C:\\Windows\\System32\\cmd.exe');
      assert.deepEqual(batResolved.args.slice(0, 3), ['/d', '/s', '/c']);

      // Linear-time adversarial backslash test (zero ReDoS) + newline/NUL rejection
      const t0 = performance.now();
      const huge = '\\'.repeat(50_000) + 'x';
      const quoted = quoteWindowsCmdArg(huge);
      assert.ok(quoted.length >= 50_000);
      assert.ok(performance.now() - t0 < 200, 'quoteWindowsCmdArg must run in linear O(n) time');
      assert.throws(() => quoteWindowsCmdArg('bad\narg'), /NUL or newline/);
      assert.throws(() => quoteWindowsCmdArg('bad\0arg'), /NUL or newline/);

      // Reconcile Windows Path vs PATH case-insensitively
      const env = reconcileWindowsPathEnv(
        { Path: 'C:\\Windows\\System32', PATH: '', OTHER: '1' },
        ['C:\\nodejs'],
        'win32'
      );
      assert.equal(env.PATH, 'C:\\nodejs;C:\\Windows\\System32');
      assert.equal(Object.hasOwn(env, 'Path'), false);
      assert.equal(env.OTHER, '1');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('workspaceBoundary strips Windows extended-length prefixes and normalizes case on win32', () => {
    assert.equal(stripWindowsExtendedPrefix('\\\\?\\C:\\Users\\Dev\\repo'), 'C:\\Users\\Dev\\repo');
    assert.equal(stripWindowsExtendedPrefix('\\\\?\\UNC\\server\\share\\file.txt'), '\\\\server\\share\\file.txt');
    assert.equal(
      normalizePathForCompare('\\\\?\\C:\\Users\\Dev\\Repo', 'win32'),
      'c:\\users\\dev\\repo'
    );
    assert.equal(
      normalizePathForCompare('/Users/Dev/Repo', 'darwin'),
      '/Users/Dev/Repo'
    );
  });

  test('atomicWriter performs durable atomic writes and sync/async renames cleanly', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-atomic-w5-'));
    try {
      const target = path.join(tmpDir, 'state.json');
      atomicWriteFileSync(target, '{"v":1}\n', { mode: 0o600 });
      assert.equal(fs.readFileSync(target, 'utf8'), '{"v":1}\n');

      const src1 = path.join(tmpDir, 'src1.tmp');
      fs.writeFileSync(src1, '{"v":2}\n', 'utf8');
      atomicRenameSync(src1, target);
      assert.equal(fs.readFileSync(target, 'utf8'), '{"v":2}\n');

      const src2 = path.join(tmpDir, 'src2.tmp');
      fs.writeFileSync(src2, '{"v":3}\n', 'utf8');
      await atomicRename(src2, target);
      assert.equal(fs.readFileSync(target, 'utf8'), '{"v":3}\n');
      assert.deepEqual(fs.readdirSync(tmpDir), ['state.json']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('tokenizeCommandArgs supports single/double quotes, escaped spaces, and literal Windows backslashes', () => {
    assert.deepEqual(
      tokenizeCommandArgs('mcp add myserver "C:\\Program Files\\node.exe" "--flag=a b"'),
      ['mcp', 'add', 'myserver', 'C:\\Program Files\\node.exe', '--flag=a b']
    );
    assert.deepEqual(
      tokenizeCommandArgs("image '/Users/dev/My Screenshot.png'"),
      ['image', '/Users/dev/My Screenshot.png']
    );
    assert.deepEqual(
      tokenizeCommandArgs('image /Users/dev/My\\ Photo.png'),
      ['image', '/Users/dev/My Photo.png']
    );
    assert.deepEqual(
      tokenizeCommandArgs('cd C:\\Users\\dev\\project'),
      ['cd', 'C:\\Users\\dev\\project']
    );
  });

  test('KeyDecoder deduplicates CRLF Enter and parses Kitty shifted sub-params while filtering key-release (:3)', () => {
    const decoder = new KeyDecoder();
    const crlf = decoder.decode('\r\n');
    assert.equal(crlf.length, 1);
    assert.equal(crlf[0]?.name, 'enter');

    const kittyShifted = decoder.decode('\x1b[97:65;2u');
    assert.equal(kittyShifted.length, 1);
    assert.equal(kittyShifted[0]?.name, 'char');
    assert.equal(kittyShifted[0]?.text, 'A');
    assert.equal(kittyShifted[0]?.shift, true);

    const kittyRelease = decoder.decode('\x1b[97;1:3u');
    assert.equal(kittyRelease.length, 0, 'Kitty key-release event type 3 must not emit duplicate press');

    const kittyEnterRelease = decoder.decode('\x1b[13;1:3u');
    assert.equal(kittyEnterRelease.length, 0);
  });

  test('LineEditor neutralizes raw tabs/controls on render and InputLayer computes code-point cursor with emoji', () => {
    const editor = new LineEditor('a\tb\x1b[31mc');
    const layout = editor.render(40);
    assert.equal(layout.rows[0]?.includes('\t'), false);
    assert.equal(layout.rows[0]?.includes('\x1b'), false);
    assert.equal(editor.getText(), 'a\tb\x1b[31mc', 'underlying buffer stays lossless');

    const layer = new InputLayer({ value: '😀a', mask: true });
    layer.editor.moveLeft(); // cursor between 😀 (col 0) and a (col 1) -> col = 1
    assert.equal(layer.editor.col, 1);
    layer.body(40);
    // Arrow prefix is 2 cols ("› "), 1 masked bullet for 😀 -> cursor.x === 3 (never 4 from UTF-16 length 2)
    assert.equal(layer.cursor?.x, 3);
  });

  test('ChatPrompt.stop settles pending read() waiter with null and submit() sanitizes queued command notices', async () => {
    const fakeIn = {
      isTTY: false,
      on() {},
      off() {},
      resume() {},
      pause() {},
      setRawMode() {}
    };
    const fakeOut = {
      isTTY: false,
      columns: 80,
      rows: 24,
      write() { return true; },
      on() {},
      removeListener() {}
    };
    const prompt = new ChatPrompt({
      input: fakeIn,
      out: fakeOut,
      isCommand: (t: string) => t.trim().startsWith('/')
    });

    prompt.busy = true;
    prompt.editor.setText('/status \x1b[31mred\nline2');
    prompt.submit();
    assert.equal(prompt.notice.includes('\x1b'), false);
    assert.equal(prompt.notice.includes('\n'), false);

    prompt.queue = [];
    prompt.busy = false;
    const pendingRead = prompt.read();
    prompt.stop();
    const resolved = await pendingRead;
    assert.equal(resolved, null, 'stop() must settle pending read() with null instead of hanging');
  });

  test('clipboard helpers detect WSL1/WSL2, recognize BMP/TIFF magic bytes, and sanitize Windows reserved filenames', () => {
    assert.equal(isWslEnvironment('linux', '5.15.146.1-microsoft-standard-WSL2', {}), true);
    assert.equal(isWslEnvironment('linux', '4.4.0-19041-Microsoft', {}), true);
    assert.equal(isWslEnvironment('linux', '6.8.0-generic', { WSL_DISTRO_NAME: 'Ubuntu' }), true);
    assert.equal(isWslEnvironment('linux', '6.8.0-generic', {}), false);

    assert.equal(detectImageMimeType(Buffer.from([0x42, 0x4d, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00])), 'image/bmp');
    assert.equal(detectImageMimeType(Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00])), 'image/tiff');
    assert.equal(detectImageMimeType(Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08])), 'image/tiff');

    assert.equal(sanitizeAttachmentFilename('CON.png', 'fallback.png'), 'fallback.png');
    assert.equal(sanitizeAttachmentFilename('NUL', 'fallback.png'), 'fallback.png');
    assert.equal(sanitizeAttachmentFilename('sub/', 'fallback.png'), 'fallback.png');
    assert.equal(sanitizeAttachmentFilename('bad:name*?.png...', 'fallback.png'), 'bad_name__.png');
  });

  test('consoleGuard captures suppressed Stage diagnostics in bounded ring buffer', () => {
    drainSuppressedStageDiagnostics();
    const unregister = registerStageConsoleGuard({
      out: process.stdout,
      stage: { reserved: true }
    });
    try {
      console.error('stage_diag_marker_xyz');
      const captured = drainSuppressedStageDiagnostics();
      assert.ok(captured.some((line) => line.includes('stage_diag_marker_xyz')));
      assert.deepEqual(drainSuppressedStageDiagnostics(), []);
    } finally {
      unregister();
    }
  });

  test('100% pure strict TypeScript invariant: every .js file in src/ is backed by a .ts source', () => {
    const unbacked: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
          const tsSibling = `${full.slice(0, -3)}.ts`;
          if (!fs.existsSync(tsSibling)) {
            unbacked.push(path.relative(REPO_ROOT, full));
          }
        }
      }
    };
    walk(path.join(REPO_ROOT, 'src'));
    assert.deepEqual(unbacked, [], `Found raw JS files in src/ without .ts source: ${unbacked.join(', ')}`);
  });
});
