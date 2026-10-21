import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  generateHtmlComponent,
  generatePreviewHtml,
  generateReactComponent
} from '../src/uiEngine/uiForge.js';
import { uiForge } from '../src/tools/uiForge.js';
import { TOOL_DEFINITIONS, toolRegistry } from '../src/tools/registry.js';

test('ui forge: generates semantic accessible HTML and CSS card', () => {
  const result = generateHtmlComponent({
    type: 'card',
    title: 'Deployment Overview',
    description: 'System health and cluster metrics',
    theme: 'dark',
    actions: [{ label: 'Deploy', action: 'deploy', primary: true }]
  });

  assert.ok(result.html.includes('Deployment Overview'));
  assert.ok(result.html.includes('System health and cluster metrics'));
  assert.ok(result.html.includes('causyne-ui-btn-primary'));
  assert.ok(result.css.includes('.causyne-ui-card'));
});

test('ui forge: generates dashboard stats grid with items', () => {
  const result = generateHtmlComponent({
    type: 'dashboard-stats',
    title: 'Cluster Resources',
    items: [
      { label: 'CPU Usage', value: '42%' },
      { label: 'Memory', value: '18.4 GB' }
    ]
  });

  assert.ok(result.html.includes('CPU Usage'));
  assert.ok(result.html.includes('42%'));
  assert.ok(result.html.includes('18.4 GB'));
  assert.ok(result.html.includes('causyne-ui-grid'));
});

test('ui forge: generates React + Tailwind component code', () => {
  const reactCode = generateReactComponent({
    name: 'ServerMetricsCard',
    type: 'dashboard-stats',
    title: 'Server Metrics',
    items: [{ label: 'Requests/sec', value: 1250 }]
  });

  assert.ok(reactCode.includes('export const ServerMetricsCard: React.FC'));
  assert.ok(reactCode.includes('Requests/sec'));
  assert.ok(reactCode.includes('1250'));
});

test('ui forge: generatePreviewHtml creates standalone preview document', () => {
  const preview = generatePreviewHtml('<div>Test</div>', 'body { color: red; }', 'dark');
  assert.ok(preview.includes('<!DOCTYPE html>'));
  assert.ok(preview.includes('Causyne UI Forge Preview'));
  assert.ok(preview.includes('<div>Test</div>'));
});

test('ui forge: tool execution generates code and writes preview if requested', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-uiforge-test-'));
  try {
    const targetFile = path.join(tempDir, 'Card.html');
    const result = await uiForge.execute({
      spec: {
        type: 'card',
        title: 'Workspace Status',
        description: 'All nodes healthy'
      },
      outputPath: targetFile
    });

    assert.ok(result.success);
    assert.ok(fs.existsSync(targetFile));
    assert.ok(fs.existsSync(result.previewPath));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('ui forge: tool schema and registry integration', () => {
  assert.ok(toolRegistry.ui_forge, 'ui_forge missing from toolRegistry');
  const def = TOOL_DEFINITIONS.find((t) => t.name === 'ui_forge');
  assert.ok(def, 'ui_forge missing from TOOL_DEFINITIONS');
  assert.equal(typeof uiForge.execute, 'function');
});
