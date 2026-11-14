import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compactSuccessfulToolResult } from '../src/tui/toolActivityPolicy.js';

describe('compactSuccessfulToolResult diagnostics preservation', () => {
  const tail = { kind: 'step', meta: { step: 8, tool: 'sysRun' } };

  it('never compacts results carrying nonzero exit codes or HTTP error statuses', () => {
    assert.equal(compactSuccessfulToolResult(8, { success: true, exitCode: 1 }, tail, 'sysRun'), false);
    assert.equal(compactSuccessfulToolResult(8, { success: true, exit_code: 2 }, tail, 'sysRun'), false);
    assert.equal(compactSuccessfulToolResult(8, { success: true, statusCode: 500 }, tail, 'sysRun'), false);
    assert.equal(compactSuccessfulToolResult(8, { success: true, exitCode: 0, statusCode: 200 }, tail, 'sysRun'), true);
  });
});
