import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SidechainSubagentHarness, type SubagentTaskSpec, type SubagentExecutionSummary } from '../src/subagent/sidechainHarness.js';

test('SidechainSubagentHarness: logs steps to isolated JSONL and does not pollute parent context', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-sidechain-test-'));
  try {
    const spec: SubagentTaskSpec = {
      subagentId: 'sub_research_42',
      parentSessionId: 'parent_turn_1',
      goal: 'Investigate Blender Python API dependencies',
      allowedTools: ['fs_read', 'code_search_ripgrep'],
      maxSteps: 10,
      tokenBudget: 30_000
    };

    const harness = new SidechainSubagentHarness(spec, tmpDir);

    // Record step 1
    harness.recordStep({
      step: 1,
      action: 'fs_read',
      target: 'package.json',
      observation: 'Found blender-api version 3.6'
    });

    // Record step 2
    harness.recordStep({
      step: 2,
      action: 'code_search_ripgrep',
      pattern: 'bpy',
      observation: '12 occurrences in src/'
    });

    assert.ok(fs.existsSync(harness.sidechainLogPath), 'Sidechain log file must exist');

    const transcript = harness.readTranscript();
    assert.equal(transcript.length, 2);
    assert.equal(transcript[0].step, 1);
    assert.equal(transcript[0].subagentId, 'sub_research_42');
    assert.equal(transcript[1].step, 2);

    // Format summary for parent
    const summary: SubagentExecutionSummary = {
      subagentId: 'sub_research_42',
      status: 'COMPLETED',
      totalSteps: 2,
      tokensConsumed: 4500,
      modifiedFiles: [],
      verifiedObservations: ['Blender 3.6 API active', '12 bpy occurrences located'],
      outputArtifacts: ['research_notes.md']
    };

    const parentReport = harness.formatSummaryForParent(summary);
    assert.match(parentReport, /### Subagent \[sub_research_42\] Execution Report/);
    assert.match(parentReport, /- \*\*Status:\*\* COMPLETED/);
    assert.match(parentReport, /- \*\*Total Steps:\*\* 2/);
    assert.match(parentReport, /- \*\*Tokens Consumed:\*\* 4,500/);
    assert.match(parentReport, /research_notes\.md/);
    assert.match(parentReport, /Blender 3\.6 API active/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SidechainSubagentHarness: sanitizes hostile subagent IDs with path traversal', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-sidechain-sec-'));
  try {
    const spec: SubagentTaskSpec = {
      subagentId: '../../../etc/passwd',
      parentSessionId: 'parent_1',
      goal: 'Hostile ID test',
      allowedTools: []
    };

    const harness = new SidechainSubagentHarness(spec, tmpDir);
    assert.ok(!harness.sidechainLogPath.includes('..'), 'Log path must not contain parent directory traversal');
    assert.ok(harness.sidechainLogPath.startsWith(tmpDir), 'Log path must remain inside storage directory');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
