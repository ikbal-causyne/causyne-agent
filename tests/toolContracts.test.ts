import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToolContracts, contractFingerprint, toolContractUpdate } from '../src/providers/toolContracts.js';

describe('toolContracts', () => {
  it('normalizes function declarations and tool objects', () => {
    const rawTools = [
      {
        name: 'tool_b',
        description: 'Tool B description',
        parameters: { type: 'object' }
      },
      {
        function: {
          name: 'tool_a',
          description: 'Tool A description',
          parameters: { type: 'object' }
        }
      }
    ];

    const normalized = normalizeToolContracts(rawTools);
    assert.equal(normalized.length, 2);
    assert.equal(normalized[0]?.name, 'tool_a');
    assert.equal(normalized[1]?.name, 'tool_b');
  });

  it('generates deterministic contract fingerprints', () => {
    const item1 = { name: 'alpha', parameters: { z: 1, a: 2 } };
    const item2 = { name: 'alpha', parameters: { a: 2, z: 1 } };
    assert.equal(contractFingerprint(item1), contractFingerprint(item2));
  });

  it('detects contract updates cleanly', () => {
    const before = [{ name: 'tool_a', description: 'v1', parameters: {} }];
    const after = [
      { name: 'tool_a', description: 'v2', parameters: {} },
      { name: 'tool_b', description: 'new', parameters: {} }
    ];

    const update = toolContractUpdate(after, before);
    assert.match(update, /Current Causyne tools/);
    assert.match(update, /tool_a/);
    assert.match(update, /tool_b/);
  });
});
