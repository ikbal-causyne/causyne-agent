import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveModelContextTokens,
  resolveCharPool,
  MODEL_CONTEXT_TOKENS
} from '../src/contextManager.js';
import { buildContextReport } from '../src/reporting.js';
import { runCommand } from '../src/commands.js';

describe('Model-Aware Context Pool & BYOK Capacity Resolution', () => {
  test('Gemini and Antigravity peer agents resolve to 1,000,000 token context window', () => {
    const agyTokens = resolveModelContextTokens({ provider: 'antigravity', model: 'Gemini 3.8 Flash (High)' });
    assert.equal(agyTokens, MODEL_CONTEXT_TOKENS.gemini_1m);
    assert.equal(agyTokens, 1000000);

    const agyCharPool = resolveCharPool('premium', undefined, { provider: 'antigravity', model: 'Gemini 3.8 Flash' });
    assert.equal(agyCharPool, 4000000);
  });

  test('Gemini 1.5 Pro and 2.0 Pro resolve to 2,000,000 tokens', () => {
    const proTokens = resolveModelContextTokens({ provider: 'gemini', model: 'gemini-1.5-pro' });
    assert.equal(proTokens, MODEL_CONTEXT_TOKENS.gemini_2m);
    assert.equal(proTokens, 2000000);
  });

  test('Anthropic Claude models resolve to 200,000 token window', () => {
    const claudeTokens = resolveModelContextTokens({ provider: 'anthropic', model: 'claude-3-7-sonnet-20250219' });
    assert.equal(claudeTokens, MODEL_CONTEXT_TOKENS.claude_200k);
    assert.equal(claudeTokens, 200000);
  });

  test('OpenAI GPT-4o and o1 models resolve accurately', () => {
    const gpt4oTokens = resolveModelContextTokens({ provider: 'openai', model: 'gpt-4o' });
    assert.equal(gpt4oTokens, MODEL_CONTEXT_TOKENS.openai_128k);
    assert.equal(gpt4oTokens, 128000);

    const o1Tokens = resolveModelContextTokens({ provider: 'openai', model: 'o1-preview' });
    assert.equal(o1Tokens, MODEL_CONTEXT_TOKENS.openai_200k);
    assert.equal(o1Tokens, 200000);
  });

  test('Astra IDE model resolves to 258,000 tokens as in IDE environment', () => {
    const astraTokens = resolveModelContextTokens({ provider: 'default', model: 'GPT-6 Astra Medium' });
    assert.equal(astraTokens, MODEL_CONTEXT_TOKENS.astra_258k);
    assert.equal(astraTokens, 258000);
  });

  test('User explicit overrideTokens is respected over default model specs', () => {
    const customTokens = resolveModelContextTokens({ provider: 'anthropic', model: 'claude-3-5-sonnet', overrideTokens: 500000 });
    assert.equal(customTokens, 500000);
  });

  test('Legacy tier fallback applies when no provider or model is set', () => {
    const defaultTokens = resolveModelContextTokens({ provider: 'default', model: 'default' });
    assert.equal(defaultTokens, 0);

    const tierPool = resolveCharPool('premium', undefined, { provider: 'default', model: 'default' });
    assert.equal(tierPool, 180000);
  });

  test('buildContextReport includes resolved approxTokenPool matching model', () => {
    const report = buildContextReport();
    assert.ok(report.approxTokenPool > 0);
    assert.ok(report.charPool > 0);
  });
});

describe('Cold Observer Interactive Modal & Non-Duplicated Title', () => {
  test('/observer and /observer status in interactive prompt triggers interactive picker', async () => {
    let pickerOpened = false;
    const fakePrompt = {
      openLayer(layer: any) {
        pickerOpened = true;
        // Simulate immediate dismissal so promise resolves
        if (typeof layer?.onPick === 'function') {
          setTimeout(() => layer.onPick(null), 5);
        }
        return {};
      },
      closeLayer() {},
      draw() {},
      notice: ''
    };

    const res = await runCommand('observer', [], { surface: 'terminal', prompt: fakePrompt });
    assert.equal(res.effect, 'silent');
    assert.ok(pickerOpened);

    pickerOpened = false;
    const resStatus = await runCommand('observer', ['status'], { surface: 'terminal', prompt: fakePrompt });
    assert.equal(resStatus.effect, 'silent');
    assert.ok(pickerOpened);
  });

  test('/observer status reports Cold Observer and showText strips redundant dialog title', async () => {
    const res = await runCommand('observer', ['status'], { surface: 'terminal' });
    assert.ok(res.ok);
    assert.equal(res.title, 'Cold Observer');
    assert.match(res.output, /Cold Observer/);

    // Verify showText strips duplicate title from layer lines
    let openedLayer: any = null;
    const fakePrompt = {
      width: () => 100,
      openLayer(layer: any) { openedLayer = layer; return layer; },
      showText: undefined as any
    };
    fakePrompt.showText = (title: string, text: string) => {
      let lines = text.split('\n');
      if (lines.length > 0 && lines[0]!.trim().toLowerCase() === String(title || '').trim().toLowerCase()) {
        lines = lines.slice(1);
        if (lines.length > 0 && /^[-─═_]+$/.test(lines[0]!.trim())) {
          lines = lines.slice(1);
        }
      }
      return { title, lines };
    };

    const dialog = fakePrompt.showText(res.title, res.output);
    assert.equal(dialog.title, 'Cold Observer');
    assert.ok(dialog.lines[0].startsWith('Status:'), `First interior dialog line should start with Status, got: "${dialog.lines[0]}"`);
  });
});
