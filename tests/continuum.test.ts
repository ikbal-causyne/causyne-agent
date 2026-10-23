// Causyne Continuum Test Suite
// Validates cross-agent conversation extraction, sanitization, compaction, and safe adoption.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  cleanUserText,
  cleanAssistantText,
  compactContinuumMessages,
  ContinuumScanner,
  adoptContinuumSession,
  type ContinuumSessionDetail,
  type ContinuumMessage
} from '../src/continuum/index.js';

import {
  createSession,
  getSession,
  deleteSession
} from '../src/sessionJournal.js';

import { runCommand, resolveCommand } from '../src/commands.js';

describe('Causyne Continuum: Sanitizer & Cleaner', () => {
  test('cleanUserText strips XML tags and metadata blocks', () => {
    const raw = `<USER_REQUEST>
Build a sleek dashboard with reactive charts.
</USER_REQUEST>
<ADDITIONAL_METADATA>
The user is running on macOS. Active file: index.ts
</ADDITIONAL_METADATA>`;

    const cleaned = cleanUserText(raw);
    assert.ok(cleaned.includes('Build a sleek dashboard with reactive charts.'));
    assert.ok(!cleaned.includes('<USER_REQUEST>'));
    assert.ok(!cleaned.includes('ADDITIONAL_METADATA'));
  });

  test('cleanAssistantText cleans tool call spam and keeps thought content readable', () => {
    const raw = `I am analyzing the directory.
\`\`\`tool_output
[Large binary blob data truncated...]
\`\`\`
Here is the final summary: all modules compiled cleanly.`;

    const cleaned = cleanAssistantText(raw);
    assert.ok(cleaned.includes('I am analyzing the directory.'));
    assert.ok(cleaned.includes('Here is the final summary: all modules compiled cleanly.'));
  });
});

describe('Causyne Continuum: Context Compaction', () => {
  test('compactContinuumMessages preserves root anchor intent and attaches handshake banner', () => {
    const messages: ContinuumMessage[] = [
      { role: 'user', content: 'ROOT INTENT: Create high-speed rendering engine.', timestamp: 1000 },
      { role: 'assistant', content: 'Step 1 completed.', timestamp: 2000 },
      { role: 'user', content: 'Now add WebGL shaders.', timestamp: 3000 },
      { role: 'assistant', content: 'Shaders added.', timestamp: 4000 },
      { role: 'user', content: 'Optimize memory layout.', timestamp: 5000 },
      { role: 'assistant', content: 'Memory layout optimized.', timestamp: 6000 },
      { role: 'user', content: 'Final verification request.', timestamp: 7000 }
    ];

    const detail: ContinuumSessionDetail = {
      id: 'test-session-123',
      sourcePlatform: 'opencode',
      sourceLabel: 'OpenCode',
      title: 'High-speed Rendering Engine',
      workspacePath: '/Users/test/engine',
      updatedAt: 7000,
      messageCount: 7,
      snippet: 'ROOT INTENT: Create high-speed rendering engine.',
      messages
    };

    const compacted = compactContinuumMessages(detail.messages, {
      maxTurns: 3,
      recentTurns: 2,
      platform: detail.sourcePlatform,
      sourceTitle: detail.title,
      originalWorkspace: detail.workspacePath
    });

    assert.ok(compacted.length <= 5);

    // Handshake banner is injected as a system anchor
    const handshakeMsg = compacted[0];
    assert.ok(handshakeMsg);
    assert.strictEqual(handshakeMsg.role, 'system');
    assert.ok(handshakeMsg.content.includes('[Continuum Handshake · Adopted from OPENCODE]'));
    assert.ok(handshakeMsg.content.includes('High-speed Rendering Engine'));

    // Root anchor intent preserved
    const rootMsg = compacted[1];
    assert.ok(rootMsg);
    assert.strictEqual(rootMsg.role, 'user');
    assert.ok(rootMsg.content.includes('ROOT INTENT: Create high-speed rendering engine.'));

    // Tail message preserved
    const tailMsg = compacted[compacted.length - 1];
    assert.ok(tailMsg);
    assert.strictEqual(tailMsg.role, 'user');
    assert.ok(tailMsg.content.includes('Final verification request.'));
  });
});

describe('Causyne Continuum: Scanner & Discovery', () => {
  test('ContinuumScanner discovers all 5 sovereign adapters', () => {
    const scanner = new ContinuumScanner();
    const adapters = scanner.getAllAdapters();
    const platforms = adapters.map(a => a.platform);

    assert.ok(platforms.includes('antigravity'));
    assert.ok(platforms.includes('opencode'));
    assert.ok(platforms.includes('codex'));
    assert.ok(platforms.includes('claude_code'));
    assert.ok(platforms.includes('causyne'));
  });

  test('ContinuumScanner query filtering filters sessions gracefully', async () => {
    const scanner = new ContinuumScanner();
    const results = await scanner.scanAll({ query: 'nonexistent-session-token-xyz-123456789' });
    assert.ok(Array.isArray(results));
    assert.strictEqual(results.length, 0);
  });
});

describe('Causyne Continuum: Safe Session Adoption & Checkpointing', () => {
  const createdSessions: string[] = [];
  const testWorkspace = path.join(os.tmpdir(), `causyne-continuum-test-${process.pid}`);

  after(() => {
    for (const id of createdSessions) {
      try { deleteSession(id); } catch { /* ignore */ }
    }
    try { fs.rmSync(testWorkspace, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('adoptContinuumSession saves active conversation before adopting new session', async () => {
    // 1. Create an active conversation with unsaved changes
    const active = createSession(testWorkspace, 'Active Working Session', true);
    createdSessions.push(active.id);
    const activeMessages = [
      { role: 'user', content: 'active task before adoption' },
      { role: 'assistant', content: 'active response' }
    ];

    // 2. Prepare external session detail to adopt
    const externalDetail: ContinuumSessionDetail = {
      id: 'ext-agy-999',
      sourcePlatform: 'antigravity',
      sourceLabel: 'Antigravity',
      title: 'Antigravity Deep Optimization Session',
      workspacePath: testWorkspace,
      updatedAt: Date.now(),
      messageCount: 2,
      snippet: 'Root intent from external session',
      messages: [
        { role: 'user', content: 'Optimize data pipeline throughput', timestamp: Date.now() - 3600000 },
        { role: 'assistant', content: 'Added streaming batch processing', timestamp: Date.now() - 1800000 }
      ]
    };

    // 3. Adopt external session
    const adoption = await adoptContinuumSession(externalDetail, {
      workspace: testWorkspace,
      currentLoopMessages: activeMessages
    });

    assert.strictEqual(adoption.ok, true);
    assert.strictEqual(adoption.sourcePlatform, 'antigravity');
    assert.ok(adoption.sessionId);
    assert.notStrictEqual(adoption.sessionId, active.id);
    assert.ok(adoption.title.includes('Antigravity Deep Optimization Session'));
    createdSessions.push(adoption.sessionId);

    // 4. Verify the adopted session can be resolved and has the messages
    const adopted = getSession(adoption.sessionId);
    assert.ok(adopted);
    assert.strictEqual(adopted.id, adoption.sessionId);
    assert.ok(adopted.messages.length >= 3);
    assert.ok(String(adopted.messages[0]?.content).includes('Continuum Handshake'));
    assert.ok(String(adopted.messages[1]?.content).includes('Optimize data pipeline throughput'));
  });
});

describe('Causyne Continuum: Slash Commands (/continuum & /resume)', () => {
  test('/resume alias resolves to continuum command', () => {
    const cmd = resolveCommand('resume');
    assert.ok(cmd);
    assert.strictEqual(cmd.name, 'continuum');
  });

  test('/continuum list outputs structured summary', async () => {
    const result = await runCommand('continuum', ['list'], { surface: 'terminal' });
    assert.strictEqual(result.ok, true);
    assert.ok(typeof result.output === 'string');
    assert.ok(result.output.length > 0);
  });

  test('/continuum read with invalid ID returns clean error hint', async () => {
    const result = await runCommand('continuum', ['read', 'non-existent-session-id-999999'], { surface: 'terminal' });
    assert.strictEqual(result.ok, false);
    assert.ok(typeof result.output === 'string');
    assert.match(result.output, /No peer session found/i);
  });
});

describe('Causyne Continuum: Defensive Security & Hardening', () => {
  test('rejects path traversal and directory escape attempts in session IDs', async () => {
    const scanner = new ContinuumScanner();

    // Antigravity traversal attempt
    const agyEscape = await scanner.fetchSession('antigravity:../../../../etc/passwd');
    assert.strictEqual(agyEscape, null);

    // Claude Code traversal attempt
    const claudeEscape = await scanner.fetchSession('claude:../../../../etc/shadow');
    assert.strictEqual(claudeEscape, null);

    // Codex traversal attempt
    const codexEscape = await scanner.fetchSession('codex:../../../../etc/hosts');
    assert.strictEqual(codexEscape, null);

    // Causyne traversal attempt
    const causyneEscape = await scanner.fetchSession('causyne:../../../../etc/resolv.conf');
    assert.strictEqual(causyneEscape, null);
  });

  test('compactor does not duplicate root message when root is within recent turns', () => {
    const messages: ContinuumMessage[] = [
      { role: 'user', content: 'Recent turn 1', timestamp: 1000 },
      { role: 'assistant', content: 'Recent response 1', timestamp: 2000 },
      { role: 'user', content: 'Recent turn 2', timestamp: 3000 }
    ];

    const compacted = compactContinuumMessages(messages, { maxTurns: 2, recentTurns: 3 });
    // Handshake banner (1) + messages (3) = 4
    assert.strictEqual(compacted.length, 4);
    assert.strictEqual(compacted[0]?.role, 'system');
    assert.strictEqual(compacted[1]?.content, 'Recent turn 1');
    assert.strictEqual(compacted[2]?.content, 'Recent response 1');
    assert.strictEqual(compacted[3]?.content, 'Recent turn 2');
  });

  test('adopting session synchronizes in-flight loop.messages', async () => {
    const mockDetail: ContinuumSessionDetail = {
      id: 'ext-test-101',
      sourcePlatform: 'antigravity',
      sourceLabel: 'Antigravity',
      title: 'Adopted Test Sync',
      workspacePath: os.tmpdir(),
      updatedAt: Date.now(),
      messageCount: 1,
      snippet: 'Testing sync',
      messages: [{ role: 'user', content: 'Need full-stack audit' }]
    };

    const mockLoop = {
      messages: [{ role: 'user', content: 'old in-flight prompt' }],
      memoryManager: {
        sessionId: 'old-session',
        useSession(id: string) {
          this.sessionId = id;
          return { id, messages: [{ role: 'user', content: 'Need full-stack audit' }] };
        },
        loadHistory() {
          return [{ role: 'system', content: 'Handshake' }, { role: 'user', content: 'Need full-stack audit' }];
        }
      }
    };

    const mockScanner = {
      async fetchSession(id: string) {
        if (id === 'ext-test-101') return mockDetail;
        return null;
      }
    };

    const res = await runCommand('continuum', ['adopt', 'ext-test-101'], {
      surface: 'terminal',
      loop: mockLoop,
      scanner: mockScanner
    });

    assert.strictEqual(res.ok, true);
    // In-flight messages must now reflect the adopted session
    assert.ok(mockLoop.messages.length >= 2);
    assert.strictEqual(mockLoop.messages[0]?.content, 'Handshake');
    assert.strictEqual(mockLoop.messages[1]?.content, 'Need full-stack audit');
  });
});

