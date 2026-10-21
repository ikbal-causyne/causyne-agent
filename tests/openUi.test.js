import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  generateHtmlComponent,
  generatePreviewHtml,
  generateReactComponent
} from '../src/uiEngine/openUi.js';
import { openUiTool } from '../src/tools/openUi.js';
import { TOOL_DEFINITIONS, toolRegistry } from '../src/tools/registry.js';

test('openui: generates semantic accessible HTML and CSS card', () => {
  const result = generateHtmlComponent({
    type: 'card',
    title: 'Deployment Overview',
    description: 'System health and cluster metrics',
    theme: 'dark',
    actions: [{ label: 'Deploy', action: 'deploy', primary: true }]
  });

  assert.ok(result.html.includes('Deployment Overview'));
  assert.ok(result.html.includes('System health and cluster metrics'));
  assert.ok(result.html.includes('openui-btn-primary'));
  assert.ok(result.css.includes('.openui-card'));
});

test('openui: generates dashboard stats grid with items', () => {
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
  assert.ok(result.html.includes('openui-grid'));
});

test('openui: generates React + Tailwind component code', () => {
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

test('openui: generatePreviewHtml creates standalone preview document', () => {
  const preview = generatePreviewHtml('<div>Test</div>', 'body { color: red; }', 'dark');
  assert.ok(preview.includes('<!DOCTYPE html>'));
  assert.ok(preview.includes('OpenUI Component Preview'));
  assert.ok(preview.includes('<div>Test</div>'));
});

test('openui: tool execution generates code and writes preview if requested', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-openui-test-'));
  try {
    const targetFile = path.join(tempDir, 'Card.html');
    const result = await openUiTool.execute({
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

test('openui: tool schema and registry integration', () => {
  assert.ok(toolRegistry.openui_generate, 'openui_generate missing from toolRegistry');
  const def = TOOL_DEFINITIONS.find((t) => t.name === 'openui_generate');
  assert.ok(def, 'openui_generate missing from TOOL_DEFINITIONS');
  assert.equal(typeof openUiTool.execute, 'function');
});
