import test from 'node:test';
import assert from 'node:assert/strict';
import { coldObserver } from '../src/observer/coldObserver.js';
import {
  buildObserverPickerItems,
  runInteractiveObserverPicker,
  type ObserverPickerItem
} from '../src/tui/observerPicker.js';
import { runCommand } from '../src/commands.js';

test('buildObserverPickerItems reflects live Cold Observer configuration', () => {
  const config = {
    enabled: true,
    mode: 'deterministic' as const,
    endpoint: 'http://localhost:11434/v1',
    model: 'tiny',
    timeoutMs: 800,
    strictness: 'standard' as const
  };

  const items = buildObserverPickerItems(config, 10, 2);
  assert.equal(items.length, 8);

  const toggleItem = items.find(i => i.id === 'toggle');
  assert.ok(toggleItem);
  assert.match(toggleItem.label, /Active/);
  assert.match(toggleItem.label, /Turn OFF/);

  const modeItem = items.find(i => i.id === 'mode');
  assert.ok(modeItem);
  assert.match(modeItem.label, /DETERMINISTIC/);

  const strictnessItem = items.find(i => i.id === 'strictness');
  assert.ok(strictnessItem);
  assert.match(strictnessItem.label, /STANDARD/);

  const endpointItem = items.find(i => i.id === 'endpoint');
  assert.ok(endpointItem);
  assert.match(endpointItem.label, /http:\/\/localhost:11434\/v1/);

  const modelItem = items.find(i => i.id === 'model');
  assert.ok(modelItem);
  assert.match(modelItem.label, /tiny/);

  const auditItem = items.find(i => i.id === 'audit');
  assert.ok(auditItem);
  assert.match(auditItem.label, /10 events recorded, 2 vetoes/);
});

test('buildObserverPickerItems reflects disabled observer status', () => {
  const config = {
    enabled: false,
    mode: 'advisory' as const,
    endpoint: '',
    model: '',
    timeoutMs: 800,
    strictness: 'strict' as const
  };

  const items = buildObserverPickerItems(config, 0, 0);
  const toggleItem = items.find(i => i.id === 'toggle');
  assert.ok(toggleItem);
  assert.match(toggleItem.label, /Disabled/);
  assert.match(toggleItem.label, /Turn ON/);

  const modeItem = items.find(i => i.id === 'mode');
  assert.ok(modeItem);
  assert.match(modeItem.label, /ADVISORY/);

  const strictnessItem = items.find(i => i.id === 'strictness');
  assert.ok(strictnessItem);
  assert.match(strictnessItem.label, /STRICT/);
});

test('runInteractiveObserverPicker toggles protection in place and resolves on exit', async () => {
  // Ensure starting state
  coldObserver.updateConfig({ enabled: true, mode: 'deterministic', strictness: 'standard' });

  let openedLayer: any = null;
  const mockPrompt = {
    notice: '',
    openLayer(layer: any) {
      openedLayer = layer;
      return layer;
    },
    closeLayer() {
      openedLayer = null;
    },
    draw() {}
  };

  const promise = runInteractiveObserverPicker(mockPrompt);
  assert.ok(openedLayer, 'SelectLayer was opened on prompt');
  assert.match(openedLayer.title, /ACTIVE/);

  // Pick toggle item
  const toggleItem = openedLayer.list.all.find((i: ObserverPickerItem) => i.id === 'toggle');
  assert.ok(toggleItem);

  const keepResult = await openedLayer.onPick(toggleItem);
  assert.equal(keepResult, 'keep', 'Toggle action keeps the menu open');
  assert.equal(coldObserver.getConfig().enabled, false, 'Observer enabled state was flipped to false');
  assert.match(openedLayer.title, /DISABLED/, 'Title was updated to reflect DISABLED status');
  assert.match(mockPrompt.notice, /DISABLED/);

  // Pick mode item
  const modeItem = openedLayer.list.all.find((i: ObserverPickerItem) => i.id === 'mode');
  assert.ok(modeItem);
  await openedLayer.onPick(modeItem);
  assert.equal(coldObserver.getConfig().mode, 'advisory', 'Observer mode was flipped to advisory');
  assert.match(openedLayer.title, /ADVISORY/);

  // Close menu (user pressed Esc / cancel)
  await openedLayer.onPick(null);
  const summary = await promise;
  assert.match(summary, /DISABLED/);
  assert.match(summary, /advisory/);

  // Restore defaults
  coldObserver.updateConfig({ enabled: true, mode: 'deterministic', strictness: 'standard' });
});

test('/observer command routes to interactive picker when argv is empty and prompt is present', async () => {
  let opened = false;
  const mockPrompt = {
    openLayer(layer: any) {
      opened = true;
      // Close immediately
      setTimeout(() => {
        if (layer && typeof layer.onPick === 'function') layer.onPick(null);
      }, 5);
      return layer;
    },
    closeLayer() {},
    draw() {}
  };

  const result = await runCommand('observer', [], { prompt: mockPrompt });
  assert.equal(result.ok, true);
  assert.equal(opened, true, 'Interactive picker was launched');
  assert.equal(result.effect, 'silent');
});

test('/observer status continues to return non-interactive text status when argv is provided', async () => {
  const result = await runCommand('observer', ['status']);
  assert.equal(result.ok, true);
  assert.match(result.output, /Cold Observer/);
  assert.match(result.output, /Status:/);
  assert.match(result.output, /Subcommands:/);
});

test('runInteractiveObserverPicker audit view omits non-finite riskScore values', async () => {
  const originalGetAuditHistory = coldObserver.getAuditHistory.bind(coldObserver);
  let detailLayer: any = null;
  let openedLayer: any = null;
  const mockPrompt = {
    notice: '',
    openLayer(layer: any) {
      if (openedLayer && layer?.lines) {
        detailLayer = layer;
      } else {
        openedLayer = layer;
      }
      return layer;
    },
    closeLayer() {},
    draw() {}
  };

  coldObserver.getAuditHistory = () => [
    {
      timestamp: Number.NaN,
      type: 'mutation',
      tool: 'bash',
      riskScore: Number.NaN,
      veto: false,
      details: 'nan risk'
    },
    {
      timestamp: Date.now(),
      type: 'verification',
      riskScore: Number.POSITIVE_INFINITY,
      veto: false,
      details: 'inf risk'
    }
  ] as any;

  try {
    const promise = runInteractiveObserverPicker(mockPrompt);
    const auditItem = openedLayer.list.all.find((i: ObserverPickerItem) => i.id === 'audit');
    assert.ok(auditItem);
    await openedLayer.onPick(auditItem);
    assert.ok(detailLayer);
    const rendered = detailLayer.lines.join('\n');
    assert.doesNotMatch(rendered, /\bNaN\b|Infinity|Invalid Date/);
    await openedLayer.onPick(null);
    await promise;
  } finally {
    coldObserver.getAuditHistory = originalGetAuditHistory;
  }
});

test('observerPicker sanitizes multiline/CSI metadata, clamps counts, and handles rejected healthCheck', async () => {
  const items = buildObserverPickerItems({
    enabled: true,
    mode: 'advisory',
    endpoint: 'http://localhost:11434\ninjected\x1b[2J',
    model: 'qwen\nline\x1b[2J',
    timeoutMs: 800,
    strictness: 'standard'
  }, -3.4, Number.NaN);

  const ep = items.find(i => i.id === 'endpoint')!;
  const md = items.find(i => i.id === 'model')!;
  const au = items.find(i => i.id === 'audit')!;
  assert.ok(!ep.label.includes('\n') && !ep.label.includes('\x1b[2J'));
  assert.ok(!md.label.includes('\n') && !md.label.includes('\x1b[2J'));
  assert.match(au.label, /0 events recorded, 0 vetoes/);

  const originalHealthCheck = coldObserver.healthCheck.bind(coldObserver);
  const originalGetAuditHistory = coldObserver.getAuditHistory.bind(coldObserver);
  let detailLayer: any = null;
  let openedLayer: any = null;
  const mockPrompt = {
    notice: '',
    openLayer(layer: any) {
      if (layer?.lines) detailLayer = layer;
      else openedLayer = layer;
      return layer;
    },
    closeLayer() {},
    draw() {}
  };

  coldObserver.healthCheck = async () => {
    throw new Error('ECONNREFUSED\n127.0.0.1\x1b[2J');
  };
  coldObserver.getAuditHistory = () => [{
    timestamp: Date.now(),
    type: 'mutation',
    tool: 'edit\nfile\x1b[2J',
    riskScore: 0.5,
    veto: false,
    details: 'ok\nnext line\x1b[2J'
  }] as any;

  try {
    const promise = runInteractiveObserverPicker(mockPrompt);
    const auditItem = openedLayer.list.all.find((i: ObserverPickerItem) => i.id === 'audit');
    await openedLayer.onPick(auditItem);
    const auditLines = detailLayer.lines.join('|');
    assert.ok(!auditLines.includes('\n') && !auditLines.includes('\x1b[2J'), 'audit detail lines must sanitize newlines and CSI');
    detailLayer.answer();

    detailLayer = null;
    const testItem = openedLayer.list.all.find((i: ObserverPickerItem) => i.id === 'test');
    await openedLayer.onPick(testItem);
    await new Promise(r => setTimeout(r, 15));
    assert.ok(detailLayer, 'rejected healthCheck must still open DetailTextLayer instead of hanging');
    const healthText = detailLayer.lines.join('|');
    assert.ok(!healthText.includes('\n') && !healthText.includes('\x1b[2J'), 'error detail must sanitize newlines and CSI');

    await openedLayer.onPick(null);
    await promise;
  } finally {
    coldObserver.healthCheck = originalHealthCheck;
    coldObserver.getAuditHistory = originalGetAuditHistory;
  }
});
