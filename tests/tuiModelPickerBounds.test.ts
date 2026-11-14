import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildModelPickerItems, type ProviderOverview } from '../src/tui/modelPicker.js';

const sampleOverview: ProviderOverview = {
  acp: [
    {
      id: 'codex',
      providerKey: 'acp/codex',
      label: 'Codex CLI',
      installed: true,
      models: ['m1', 'm2', 'm3'],
      setupInstruction: 'Install codex'
    }
  ],
  byok: []
};

describe('modelPicker finite bounds', () => {
  it('buildModelPickerItems handles NaN, negative, and fractional maxAcpPerPeer safely', () => {
    const nanItems = buildModelPickerItems({}, sampleOverview, {
      tab: 'acp',
      maxAcpPerPeer: Number.NaN
    });
    const nanModelIds = nanItems.filter((item) => item.value.type === 'acp').map((item) => item.value.modelId);
    assert.deepEqual(nanModelIds, ['m1', 'm2', 'm3']);

    const negItems = buildModelPickerItems({}, sampleOverview, {
      tab: 'acp',
      maxAcpPerPeer: -2
    });
    const negToggle = negItems.find((item) => item.value.type === 'toggle');
    assert.equal(negItems.filter((item) => item.value.type === 'acp').length, 1);
    assert.equal(negToggle?.label, '▶ Load more (2 more models)...');

    const fracItems = buildModelPickerItems({}, sampleOverview, {
      tab: 'acp',
      maxAcpPerPeer: 1.5
    });
    const fracToggle = fracItems.find((item) => item.value.type === 'toggle');
    assert.equal(fracToggle?.label, '▶ Load more (2 more models)...');
  });
});
