import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findContainingRoot,
  assertSafeWorkspaceOutput,
  assertSafeWorkspaceInput
} from '../src/tools/toolPathSafety.js';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-sec-w1-')));

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe('Wave 1 Security Hardening — Path Boundary & Symlink Integrity', () => {
  test('findContainingRoot returns matching root for nested targets and rejects outside paths', () => {
    const ws = path.join(TMP, 'ws-root');
    const nested = path.join(ws, 'sub', 'file.txt');
    const outside = path.join(TMP, 'outside', 'secret.txt');
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(nested, 'ok', 'utf8');
    fs.writeFileSync(outside, 'secret', 'utf8');

    assert.equal(findContainingRoot(nested, [ws]), ws);
    assert.equal(findContainingRoot(ws, [ws]), ws);
    assert.equal(findContainingRoot(outside, [ws]), null);
  });

  test('assertSafeWorkspaceOutput and assertSafeWorkspaceInput enforce symlink checks via findContainingRoot', { skip: process.platform === 'win32' }, async () => {
    const ws = path.join(TMP, 'ws-symlink');
    const outsideDir = path.join(TMP, 'outside-dir');
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'top-secret', 'utf8');
    const linkDir = path.join(ws, 'escape-dir');
    const linkFile = path.join(ws, 'escape-file.txt');
    fs.symlinkSync(outsideDir, linkDir);
    fs.symlinkSync(outsideFile, linkFile);

    await assert.rejects(
      () => assertSafeWorkspaceOutput(path.join(linkDir, 'pwn.txt'), { workspaceRoot: ws }),
      /outside|symlink/i
    );
    await assert.rejects(
      () => assertSafeWorkspaceInput(linkFile, { workspaceRoot: ws }),
      /outside|symlink/i
    );
  });
});
