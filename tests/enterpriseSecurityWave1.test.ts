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
import { redactTextSecrets, redactProviderSecrets } from '../src/providers/byokHttp.js';
import { looksSensitive } from '../src/tui/history.js';
import { formatAuditExport } from '../src/auditLog.js';
import { loadProjectInstructions } from '../src/projectInstructions.js';

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

  test('redactTextSecrets preserves >2KB payloads while redacting cloud, VCS, Slack, DB, PEM, and JSON secrets', () => {
    const longPrefix = 'A'.repeat(4000);
    const sample = [
      longPrefix,
      'aws=AKIA1234567890ABCDEF',
      'gh=ghp_1234567890abcdefghij123456',
      'slack=xoxb-123456789012-abcdefghijkl',
      'db=postgres://admin:superSecretPass9@db.example.com:5432/prod',
      '{"api_key": "my_json_secret_value_123"}',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
    ].join('\n');

    const uncapped = redactTextSecrets(sample);
    assert.ok(uncapped.length > 4000, 'redactTextSecrets must not silently truncate at 2048 chars');
    assert.equal(uncapped.includes('AKIA1234567890ABCDEF'), false);
    assert.equal(uncapped.includes('ghp_1234567890abcdefghij123456'), false);
    assert.equal(uncapped.includes('xoxb-123456789012-abcdefghijkl'), false);
    assert.equal(uncapped.includes('superSecretPass9'), false);
    assert.equal(uncapped.includes('my_json_secret_value_123'), false);
    assert.equal(uncapped.includes('MIIEowIBAAKCAQEA'), false);

    // Provider error helper still caps short error messages cleanly
    assert.ok(redactProviderSecrets(sample).length <= 2049);
  });

  test('non-error callers no longer corrupt or truncate >2KB payloads', () => {
    const longPrompt = 'Explain\tarchitecture:\n' + 'x'.repeat(3000);
    assert.equal(looksSensitive(longPrompt), false, 'long tabbed prompt must not be rejected as secret');
    assert.equal(looksSensitive('token=sk-1234567890abcdef123456'), true);

    const bigEntry = { ts: '2026-11-23T00:00:00Z', event: 'test', detail: 'y'.repeat(3500) };
    const jsonl = formatAuditExport([bigEntry], 'jsonl').trim();
    const parsed = JSON.parse(jsonl);
    assert.equal(parsed.detail.length, 3500);

    const ws = path.join(TMP, 'ws-long-rules');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'CAUSYNE.md'), '# Rules\n' + 'rule line '.repeat(400), 'utf8');
    const loaded = loadProjectInstructions(ws);
    assert.ok(loaded.totalChars > 3500, 'projectInstructions must not truncate at 2048 chars');
  });
});
