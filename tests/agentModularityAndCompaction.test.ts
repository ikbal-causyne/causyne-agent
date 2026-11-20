import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { classifyAgentError, getRetryHintForError } from '../src/agent/errorClassifier.js';
import {
  isActionableTaskPrompt,
  isGenericHandoffResponse,
  isCodeAuthoringTaskPrompt,
  extractSkillIdFromPrompt,
  isProviderPlanOrQuotaRefusal,
  isMidTaskProgressText
} from '../src/agent/promptIntent.js';
import { validateAndNormalizeToolArgs } from '../src/agent/toolArgValidator.js';
import {
  findSafeCompactionSplitIndex,
  buildCodexStyleSummary,
  compactSessionMessages,
  runCompactSlashCommand
} from '../src/core/contextCompactor.js';

describe('Sector 3 — Extracted Strict-TS AgentLoop modules', () => {
  test('classifyAgentError honors structured HTTP status codes, ETIMEDOUT, partial usage, and retry hints', () => {
    assert.equal(classifyAgentError({ status: 429, message: 'busy' }), 'rate_limit');
    assert.equal(classifyAgentError({ status: 401, message: 'bad token' }), 'auth_error');
    assert.equal(classifyAgentError({ status: 403, message: 'forbidden' }), 'auth_error');
    assert.equal(classifyAgentError({ status: 400, message: 'schema mismatch' }), 'invalid_request_error');
    assert.equal(classifyAgentError({ status: 503, message: 'upstream unavailable' }), 'network_error');
    assert.equal(classifyAgentError({ code: 'ETIMEDOUT', message: 'timed out' }), 'network_error');
    assert.equal(classifyAgentError({ code: 'PROVIDER_NO_PROGRESS' }), 'fatal');
    assert.equal(classifyAgentError({ partialUsage: { promptTokens: 50, completionTokens: 10 }, message: '429' }), 'fatal');
    assert.equal(classifyAgentError(new TypeError('unexpected')), 'fatal');
    assert.match(getRetryHintForError('rate_limit'), /rate limit/i);
    assert.match(getRetryHintForError('unknown_code'), /different approach/i);
  });

  test('promptIntent helpers preserve exact classification contracts', () => {
    assert.equal(isActionableTaskPrompt('hi'), false);
    assert.equal(isActionableTaskPrompt('Fix the failing parser tests'), true);
    assert.equal(isCodeAuthoringTaskPrompt('Build a REST API service'), true);
    assert.equal(isCodeAuthoringTaskPrompt('open http://localhost:3000'), false);
    assert.equal(isGenericHandoffResponse('Let me know what you would like to do next.'), true);
    assert.equal(isGenericHandoffResponse('Completed the refactor. Let me know what you would like to do next.'), false);
    assert.equal(extractSkillIdFromPrompt('Apply skill security/crypto-usage to this repo'), 'security/crypto-usage');
    assert.equal(isProviderPlanOrQuotaRefusal('Upgrade your plan to continue.'), true);
    assert.equal(isMidTaskProgressText('Checking the remaining files now.'), true);
    assert.equal(isMidTaskProgressText('Task completed. Everything is ready.'), false);
  });

  test('validateAndNormalizeToolArgs resolves relative & tilde paths, skips URLs, and checks required args', () => {
    const ws = path.resolve('/tmp/causyne-sector3-ws');
    const args: Record<string, unknown> = { path: 'src/index.ts', content: 'export const x = 1;' };
    assert.equal(validateAndNormalizeToolArgs('fs_write', args, ws), null);
    assert.equal(args.path, path.resolve(ws, 'src/index.ts'));

    const tildeArgs: Record<string, unknown> = { path: '~/notes.md' };
    assert.equal(validateAndNormalizeToolArgs('fs_read', tildeArgs, ws), null);
    assert.equal(tildeArgs.path, path.join(os.homedir(), 'notes.md'));

    const urlArgs: Record<string, unknown> = { target: 'https://example.com' };
    assert.equal(validateAndNormalizeToolArgs('web_fetch', urlArgs, ws), null);
    assert.equal(urlArgs.target, 'https://example.com');

    assert.match(validateAndNormalizeToolArgs('sysRun', {}, ws) ?? '', /command/);
    assert.match(validateAndNormalizeToolArgs('fs_write', { path: 'a.txt' }, ws) ?? '', /content/);
    assert.match(validateAndNormalizeToolArgs('tool_search', {}, ws) ?? '', /query/);
    assert.match(validateAndNormalizeToolArgs('fs_read_skill', {}, ws) ?? '', /skill_id/);
  });
});

describe('Sector 3 — Turn-boundary-safe, plan-preserving context compaction', () => {
  test('findSafeCompactionSplitIndex and compactSessionMessages never orphan role=tool messages', () => {
    const messages: any[] = [
      { role: 'user', content: 'Refactor the billing module cleanly' },
      { role: 'assistant', content: 'Inspecting files', tool_calls: [{ id: 'c1', function: { name: 'fs_list', arguments: '{"path":"src"}' } }] },
      { role: 'tool', name: 'fs_list', tool_call_id: 'c1', content: 'src/billing.ts '.repeat(120) },
      { role: 'assistant', content: 'Reading billing.ts', tool_calls: [{ id: 'c2', function: { name: 'MultiEdit', arguments: '{"file_path":"src/billing.ts"}' } }] },
      { role: 'tool', name: 'MultiEdit', tool_call_id: 'c2', content: JSON.stringify({ success: true }) },
      // Multi-tool turn straddling keepRecentTurns=4 boundary:
      {
        role: 'assistant',
        content: 'Running 3 checks in parallel',
        tool_calls: [
          { id: 'c3a', function: { name: 'fs_read', arguments: '{"path":"a.ts"}' } },
          { id: 'c3b', function: { name: 'fs_read', arguments: '{"path":"b.ts"}' } },
          { id: 'c3c', function: { name: 'fs_read', arguments: '{"path":"c.ts"}' } }
        ]
      },
      { role: 'tool', name: 'fs_read', tool_call_id: 'c3a', content: 'content a' },
      { role: 'tool', name: 'fs_read', tool_call_id: 'c3b', content: 'content b' },
      { role: 'tool', name: 'fs_read', tool_call_id: 'c3c', content: 'content c' },
      { role: 'assistant', content: 'All checks reviewed.' }
    ];

    // Naive splitIndex = 10 - 4 - 1 = 5 (right on the assistant tool_calls, so index 6 is role='tool'!)
    const safeSplit = findSafeCompactionSplitIndex(messages, 5);
    assert.notEqual(messages[safeSplit + 1]?.role, 'tool', 'retained suffix must never begin with an orphaned tool message');

    const result = compactSessionMessages(messages, {
      keepRecentTurns: 4,
      activePlan: [
        { step: 'Extract error classifier', status: 'completed' },
        { step: 'Add compaction turn-boundary guard', status: 'in_progress' }
      ]
    });

    assert.equal(result.compacted, true);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].role, 'user');
    assert.notEqual(messages[2]?.role, 'tool', 'compacted transcript must never have an orphaned tool result after summary');
    assert.ok(messages[1].content.includes('[Modified] src/billing.ts'), 'MultiEdit file modification must be preserved');
    assert.ok(messages[1].content.includes('Active Implementation Plan:'));
    assert.ok(messages[1].content.includes('[in_progress] Add compaction turn-boundary guard'));
  });

  test('buildCodexStyleSummary and runCompactSlashCommand keep Causyne identity and plan anchors', async () => {
    const summary = buildCodexStyleSummary(
      [{
        role: 'assistant',
        tool_calls: [{ id: 'm1', function: { name: 'MultiEdit', arguments: JSON.stringify({ file_path: 'src/core.ts' }) } }]
      }] as any,
      'Harden core loop',
      { activePlan: [{ step: 'Run full test suite', status: 'pending' }] }
    );
    assert.ok(summary.includes('[Modified] src/core.ts'));
    assert.ok(summary.includes('[pending] Run full test suite'));

    const mockLoop = {
      taskId: 'sec3-compact',
      userPrompt: 'Harden core loop',
      _implementationPlan: [{ step: 'Verify CI', status: 'in_progress' }],
      messages: [
        { role: 'user', content: 'Harden core loop' },
        { role: 'assistant', content: 'Step 1' },
        { role: 'user', content: 'Proceed' },
        { role: 'assistant', content: 'Step 2' },
        { role: 'user', content: 'Check' },
        { role: 'assistant', content: 'Step 3' },
        { role: 'assistant', content: 'Step 4' },
        { role: 'assistant', content: 'Step 5' }
      ],
      memoryManager: { saveHistory: () => {} }
    };
    const res = await runCompactSlashCommand([], { loop: mockLoop });
    assert.equal(res.ok, true);
    assert.match(res.output, /Causyne structured state model/);
    assert.doesNotMatch(res.output, /OpenAI Codex/i);
  });
});
