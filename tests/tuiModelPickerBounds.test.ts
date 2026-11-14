import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ModelPickerLayer,
  buildModelPickerItems,
  runInteractiveModelPicker,
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

  it('runInteractiveModelPicker preserves selected OpenRouter modelId when saving a new API key', async () => {
    const prevEnvKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      let storedConfig: Record<string, any> = { provider: 'antigravity', model: 'Gemini 3.8 Flash (Low)' };
      const mockStore = {
        loadConfig: () => ({ ...storedConfig }),
        saveConfig: (c: Record<string, any>) => {
          storedConfig = { ...c };
        }
      };
      const mockLoop: any = { config: { ...storedConfig } };
      const mockPrompt = {
        openLayer(layer: any) {
          if (layer instanceof ModelPickerLayer) {
            layer.onPick({
              id: 'free-r1',
              label: 'deepseek/deepseek-r1:free',
              category: 'FREE',
              description: '',
              value: {
                type: 'free',
                providerId: 'openrouter',
                modelId: 'deepseek/deepseek-r1:free',
                providerLabel: 'OpenRouter Free',
                installed: true,
                isCurrent: false,
                isConfigured: false
              }
            });
          } else if (typeof layer.onSubmit === 'function') {
            layer.onSubmit('test-openrouter-placeholder-token');
          }
        }
      };

      const msg = await runInteractiveModelPicker(mockPrompt, mockStore, {
        loop: mockLoop
      });
      assert.match(msg, /deepseek\/deepseek-r1:free/);
      assert.equal(storedConfig.provider, 'openrouter');
      assert.equal(storedConfig.model, 'deepseek/deepseek-r1:free');
      assert.equal(mockLoop.config.model, 'deepseek/deepseek-r1:free');
    } finally {
      if (prevEnvKey !== undefined) process.env.OPENROUTER_API_KEY = prevEnvKey;
    }
  });
});
