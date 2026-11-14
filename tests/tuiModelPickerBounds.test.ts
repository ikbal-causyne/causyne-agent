import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ModelPickerLayer,
  buildModelPickerItems,
  type ProviderOverview
} from '../src/tui/modelPicker.js';

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

  it('ModelPickerLayer.body clamps non-finite width and height without RangeError', () => {
    const layer = new ModelPickerLayer({
      config: { provider: 'acp/codex' },
      overview: sampleOverview,
      onPick() {}
    });
    assert.doesNotThrow(() => {
      const infRows = layer.body(Number.POSITIVE_INFINITY, Number.NaN);
      assert.ok(infRows.length >= 3);
    });
  });

  it('ModelPickerLayer clamps negative/non-finite list.selected in refilter and non-finite height in key()', () => {
    const layer = new ModelPickerLayer({
      config: { provider: 'acp/codex' },
      overview: sampleOverview,
      onPick() {}
    });
    layer.list.selected = -3;
    layer.list.refilter();
    assert.equal(layer.list.selected, 0);

    layer.height = Number.POSITIVE_INFINITY;
    layer.key({ name: 'pagedown' });
    assert.ok(Number.isFinite(layer.list.selected));
    assert.ok(Number.isFinite(layer.list.offset));
    assert.ok(layer.list.offset >= 0);
  });
});
