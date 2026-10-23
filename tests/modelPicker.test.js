import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModelPickerItems, runInteractiveModelPicker } from '../src/tui/modelPicker.js';
import { runCommand } from '../src/commands.js';
import { SelectLayer, InputLayer } from '../src/tui/dialogs.js';

test('buildModelPickerItems: categorizes ACP agents and BYOK models cleanly', () => {
  const config = { provider: 'antigravity', model: 'Gemini 3.8 Flash (Low)' };
  const overview = {
    activeProvider: 'antigravity',
    activeModel: 'Gemini 3.8 Flash (Low)',
    acp: [
      {
        id: 'antigravity',
        providerKey: 'antigravity',
        label: 'Google Antigravity (AGY)',
        installed: true,
        status: 'ready',
        isCurrent: true,
        command: 'agy',
        models: ['Gemini 3.8 Flash (Low)', 'Gemini 3.8 Flash (High)', 'Gemini 3.8 Pro'],
        setupInstruction: 'Install agy'
      },
      {
        id: 'codex',
        providerKey: 'acp/codex',
        label: 'Codex CLI',
        installed: false,
        status: 'not_installed',
        isCurrent: false,
        command: 'codex',
        models: ['gpt-4o'],
        setupInstruction: 'Install codex'
      }
    ],
    byok: [
      {
        id: 'anthropic',
        label: 'Anthropic',
        isConfigured: false,
        isCurrent: false,
        models: ['claude-3-7-sonnet', 'claude-3-5-sonnet'],
        defaultModel: 'claude-3-7-sonnet',
        envVar: 'ANTHROPIC_API_KEY'
      },
      {
        id: 'ollama',
        label: 'Ollama (Local Server)',
        isConfigured: true,
        isCurrent: false,
        models: ['llama3.3'],
        defaultModel: 'llama3.3'
      }
    ]
  };

  const items = buildModelPickerItems(config, overview);
  assert.ok(Array.isArray(items));
  assert.ok(items.length >= 5);

  // Check Antigravity items
  const agyHigh = items.find(i => i.label === 'Gemini 3.8 Flash (High)');
  assert.ok(agyHigh, 'Gemini 3.8 Flash (High) should be present');
  assert.equal(agyHigh.value.type, 'acp');
  assert.equal(agyHigh.value.providerId, 'antigravity');
  assert.equal(agyHigh.category, 'ACP · Google Antigravity (AGY) (ready)');

  const agyActive = items.find(i => i.label === 'Gemini 3.8 Flash (Low)');
  assert.ok(agyActive);
  assert.equal(agyActive.description, '● active');

  // Check uninstalled ACP peer
  const codex = items.find(i => i.value.providerId === 'acp/codex');
  assert.ok(codex);
  assert.equal(codex.value.installed, false);
  assert.equal(codex.description, 'not installed — setup needed');

  // Check BYOK items
  const claude = items.find(i => i.label === 'claude-3-7-sonnet');
  assert.ok(claude);
  assert.equal(claude.value.type, 'byok');
  assert.equal(claude.value.providerId, 'anthropic');
  assert.equal(claude.description, 'needs API key');

  // Check Ollama
  const ollama = items.find(i => i.label === 'llama3.3');
  assert.ok(ollama);
  assert.equal(ollama.description, 'local');
});

test('runInteractiveModelPicker: auto-selects ACP model (e.g. Gemini 3.8 Flash High) without prompting for API key', async () => {
  let storedConfig = { provider: 'antigravity', model: 'Gemini 3.8 Flash (Low)', apiKey: '' };
  const mockStore = {
    loadConfig: () => ({ ...storedConfig }),
    saveConfig: (c) => { storedConfig = { ...c }; }
  };

  let openedLayer = null;
  const mockPrompt = {
    openLayer: (layer) => {
      openedLayer = layer;
      if (layer instanceof SelectLayer) {
        // Find Gemini 3.8 Flash (High) from Antigravity and simulate pick
        const item = layer.list.all.find(i => i.label === 'Gemini 3.8 Flash (High)' && i.value.providerId === 'antigravity');
        assert.ok(item, 'Gemini 3.8 Flash (High) item must exist in picker');
        setTimeout(() => layer.onPick(item), 1);
      }
    }
  };

  const result = await runInteractiveModelPicker(mockPrompt, mockStore);
  assert.ok(result.includes('Now using Google Antigravity (AGY) / Gemini 3.8 Flash (High)'));
  assert.equal(storedConfig.provider, 'antigravity');
  assert.equal(storedConfig.model, 'Gemini 3.8 Flash (High)');
});

test('runInteractiveModelPicker: auto-selects configured BYOK model immediately without prompting for key', async () => {
  let storedConfig = {
    provider: 'antigravity',
    model: 'Gemini 3.8 Flash (Low)',
    apiKey: '',
    providerKeys: { anthropic: 'test-anthropic-key-123' }
  };
  const mockStore = {
    loadConfig: () => ({ ...storedConfig }),
    saveConfig: (c) => { storedConfig = { ...c }; }
  };

  const mockPrompt = {
    openLayer: (layer) => {
      if (layer instanceof SelectLayer) {
        const item = layer.list.all.find(i => i.label === 'claude-3-7-sonnet' && i.value.providerId === 'anthropic');
        assert.ok(item, 'claude-3-7-sonnet must exist');
        setTimeout(() => layer.onPick(item), 1);
      } else if (layer instanceof InputLayer) {
        assert.fail('Should not prompt for API key when providerKey is already configured');
      }
    }
  };

  const result = await runInteractiveModelPicker(mockPrompt, mockStore);
  assert.ok(result.includes('Now using Anthropic / claude-3-7-sonnet'));
  assert.equal(storedConfig.provider, 'anthropic');
  assert.equal(storedConfig.model, 'claude-3-7-sonnet');
  assert.equal(storedConfig.apiKey, 'test-anthropic-key-123');
});

test('runInteractiveModelPicker: prompts with InputLayer for unconfigured BYOK model, saves key and activates', async () => {
  let storedConfig = {
    provider: 'antigravity',
    model: 'Gemini 3.8 Flash (Low)',
    apiKey: '',
    providerKeys: {}
  };
  const mockStore = {
    loadConfig: () => ({ ...storedConfig }),
    saveConfig: (c) => { storedConfig = { ...c }; }
  };

  let promptedKeyInput = false;
  const mockPrompt = {
    openLayer: (layer) => {
      if (layer instanceof SelectLayer) {
        const item = layer.list.all.find(i => i.label === 'gpt-4o' && i.value.providerId === 'openai');
        assert.ok(item, 'gpt-4o must exist');
        setTimeout(() => layer.onPick(item), 1);
      } else if (layer instanceof InputLayer) {
        promptedKeyInput = true;
        assert.ok(layer.title.includes('OpenAI'));
        assert.equal(layer.mask, true);
        setTimeout(() => layer.onSubmit('causyne-mock-key-openai-999'), 1);
      }
    }
  };

  const result = await runInteractiveModelPicker(mockPrompt, mockStore);
  assert.ok(promptedKeyInput, 'Must have opened InputLayer for entering API key');
  assert.ok(result.includes('Saved API key. Now using OpenAI / gpt-4o'));
  assert.equal(storedConfig.provider, 'openai');
  assert.equal(storedConfig.model, 'gpt-4o');
  assert.equal(storedConfig.apiKey, 'causyne-mock-key-openai-999');
  assert.equal(storedConfig.providerKeys.openai, 'causyne-mock-key-openai-999');
});

test('runInteractiveModelPicker: cancelling API key input leaves config unchanged', async () => {
  let storedConfig = {
    provider: 'antigravity',
    model: 'Gemini 3.8 Flash (Low)',
    apiKey: '',
    providerKeys: {}
  };
  const mockStore = {
    loadConfig: () => ({ ...storedConfig }),
    saveConfig: (c) => { storedConfig = { ...c }; }
  };

  const mockPrompt = {
    openLayer: (layer) => {
      if (layer instanceof SelectLayer) {
        const item = layer.list.all.find(i => i.label === 'deepseek-chat' && i.value.providerId === 'deepseek');
        setTimeout(() => layer.onPick(item), 1);
      } else if (layer instanceof InputLayer) {
        // Cancel input
        setTimeout(() => layer.onCancel(), 1);
      }
    }
  };

  const result = await runInteractiveModelPicker(mockPrompt, mockStore);
  assert.ok(result.includes('Cancelled. An API key is required'));
  assert.equal(storedConfig.provider, 'antigravity');
  assert.equal(storedConfig.model, 'Gemini 3.8 Flash (Low)');
});

test('runCommand: /model with ctx.prompt invokes interactive picker', async () => {
  let openedPicker = false;
  const mockPrompt = {
    openLayer: (layer) => {
      if (layer instanceof SelectLayer) {
        openedPicker = true;
        // Cancel picker
        setTimeout(() => layer.onPick(null), 1);
      }
    }
  };

  const result = await runCommand('model', [], { surface: 'terminal', prompt: mockPrompt });
  assert.ok(result.ok);
  assert.ok(openedPicker, 'Interactive picker layer must be opened');
  assert.equal(result.output, 'Cancelled. Model was not changed.');
});

test('runCommand: /model without ctx.prompt outputs text overview', async () => {
  const result = await runCommand('model', [], { surface: 'terminal' });
  assert.ok(result.ok);
  assert.ok(result.output.includes('BYOK PROVIDERS'));
  assert.ok(result.output.includes('ACP PEER AGENTS'));
});

test('InputLayer: accepts paste events and sanitizes surrounding whitespace/newlines', () => {
  let submitted = null;
  const layer = new InputLayer({
    title: 'Set API Key',
    placeholder: 'paste API key',
    mask: true,
    onSubmit: (val) => { submitted = val; }
  });

  // Simulate bracketed paste with trailing newlines
  const action = layer.key({ name: 'paste', text: '  causyne-mock-anthropic-key-999\r\n  ' });
  assert.equal(action, 'handled');
  assert.equal(layer.editor.getText(), 'causyne-mock-anthropic-key-999');

  // Submit
  const closeAction = layer.key({ name: 'enter' });
  assert.equal(closeAction, 'close');
  assert.equal(submitted, 'causyne-mock-anthropic-key-999');
});

test('runInteractiveModelPicker: accepts pasted API key for BYOK provider and persists to store', async () => {
  let storedConfig = { provider: 'antigravity', model: 'Gemini 3.8 Flash (Low)', apiKey: '' };
  const mockStore = {
    loadConfig: () => ({ ...storedConfig }),
    saveConfig: (c) => { storedConfig = { ...c }; }
  };

  const mockPrompt = {
    openLayer: (layer) => {
      if (layer instanceof SelectLayer) {
        // Pick Anthropic claude-3-7-sonnet
        const item = layer.list.all.find(i => i.label === 'claude-3-7-sonnet' && i.value.providerId === 'anthropic');
        setTimeout(() => layer.onPick(item), 1);
      } else if (layer instanceof InputLayer) {
        // Simulate paste of API key then press enter
        setTimeout(() => {
          layer.key({ name: 'paste', text: 'causyne-mock-anthropic-key-abc\n' });
          layer.key({ name: 'enter' });
        }, 1);
      }
    }
  };

  const result = await runInteractiveModelPicker(mockPrompt, mockStore);
  assert.ok(result.includes('Now using Anthropic / claude-3-7-sonnet'));
  assert.equal(storedConfig.provider, 'anthropic');
  assert.equal(storedConfig.model, 'claude-3-7-sonnet');
  assert.equal(storedConfig.apiKey, 'causyne-mock-anthropic-key-abc');
  assert.equal(storedConfig.providerKeys?.anthropic, 'causyne-mock-anthropic-key-abc');
});

