// validateToolArgs — the first unit test to reach into agentLoop.js.
//
// These branches were dead code: canonicalToolName normalises '.'→'_' before
// validation runs, so the old 'fs.write'/'codebase.search'/'web.search' literals
// could never match and the model's missing-argument mistakes reached the tool as
// runtime exceptions. The method uses no `this`, so it is exercised via the
// prototype without the heavy AgentLoop constructor.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../src/agentLoop.js';

const validate = (name, args) => AgentLoop.prototype.validateToolArgs.call({}, name, args);

describe('validateToolArgs catches missing arguments on the CANONICAL names', () => {
  test('fs_write requires path and content', () => {
    assert.match(validate('fs_write', { content: 'x' }), /path/);
    assert.match(validate('fs_write', { path: '/a' }), /content/);
    assert.equal(validate('fs_write', { path: '/a', content: 'x' }), null);
    assert.equal(validate('fs_write', { path: '/a', content: '' }), null); // empty content is valid
  });

  test('codebase_search and web_search require a query', () => {
    assert.match(validate('codebase_search', {}), /query/);
    assert.match(validate('web_search', {}), /query/);
    assert.equal(validate('web_search', { query: 'x' }), null);
  });

  test('sysRun and sysRunBg require a command', () => {
    assert.match(validate('sysRun', {}), /command/);
    assert.match(validate('sysRunBg', {}), /command/);
    assert.equal(validate('sysRun', { command: 'ls' }), null);
  });

  test('the old dotted names are no longer matched (they never reach here)', () => {
    // canonicalToolName guarantees these never appear; validating them would be a
    // bug of its own. Confirm they are treated as unknown (no false positive).
    assert.equal(validate('fs.write', {}), null);
    assert.equal(validate('codebase.search', {}), null);
  });

  test('relative paths are rewritten to absolute in place', () => {
    const args = { path: 'rel/file.txt' };
    validate('fs_write', { ...args, content: 'x' }); // does not touch our copy
    const live = { path: 'rel/file.txt', content: 'x' };
    validate('fs_write', live);
    assert.ok(live.path.startsWith('/'), 'a relative path must be made absolute');
  });
});
