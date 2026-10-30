import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isBrowserRuntimeInstalled, resolveBrowserRuntime } from '../src/browser/browserRuntime.js';

test('availability agrees with launch discovery for an explicitly configured Chromium executable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-browser-discovery-'));
  const original = process.env.CAUSYNE_BROWSER_EXECUTABLE;
  const executable = path.join(root, process.platform === 'win32' ? 'chrome.exe' : 'chromium');
  fs.writeFileSync(executable, '', { mode: 0o755 });
  try {
    process.env.CAUSYNE_BROWSER_EXECUTABLE = executable;
    assert.equal(resolveBrowserRuntime().engine, 'chromium');
    assert.equal(isBrowserRuntimeInstalled(), true);
    process.env.CAUSYNE_BROWSER_EXECUTABLE = path.join(root, 'missing', 'chromium');
    assert.equal(isBrowserRuntimeInstalled(), false, 'an explicit missing runtime must not silently select a different browser');
    process.env.CAUSYNE_BROWSER_EXECUTABLE = root;
    assert.equal(isBrowserRuntimeInstalled(), false, 'an arbitrary directory is not a browser');
  } finally {
    if (original === undefined) delete process.env.CAUSYNE_BROWSER_EXECUTABLE;
    else process.env.CAUSYNE_BROWSER_EXECUTABLE = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
