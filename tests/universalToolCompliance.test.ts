import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_DEFINITIONS } from '../src/tools/registry.js';
import {
  scanAndAdaptToolsForProvider,
  type ToolDefinition,
  isEmptyObjectSchema
} from '../src/tools/toolScanner.js';
import { canonicalizeToolName } from '../src/tools/toolSelfRepair.js';

test('universalToolCompliance: all native tools are registered and have non-empty schemas', () => {
  assert.ok(Array.isArray(TOOL_DEFINITIONS), 'TOOL_DEFINITIONS must be an array');
  assert.ok(TOOL_DEFINITIONS.length >= 30, `Expected at least 30 native tools, got ${TOOL_DEFINITIONS.length}`);

  for (const def of TOOL_DEFINITIONS) {
    assert.ok(typeof def.name === 'string' && def.name.length > 0, `Tool must have a name`);
    assert.ok(typeof def.description === 'string' && def.description.length > 0, `Tool '${def.name}' must have a description`);
    const params = def.parameters || def.input_schema || {};
    assert.ok(typeof params === 'object', `Tool '${def.name}' parameters must be an object`);
  }
});

test('universalToolCompliance: pre-flight toolScanner adapts all tools for Gemini without OpenAPI violations', () => {
  const toolDefs: ToolDefinition[] = TOOL_DEFINITIONS.map((t: any) => (t.schema ? t.schema : t));
  const report = scanAndAdaptToolsForProvider(toolDefs, 'gemini');

  assert.ok(report.issues.length > 0, 'toolScanner must detect raw schema incompatibilities (e.g. additionalProperties, empty objects)');
  assert.equal(report.adaptedTools.length, toolDefs.length, 'Must adapt all tools for Gemini');

  // Verify that no adapted tool contains forbidden keywords for Gemini
  function verifyNoGeminiViolations(node: any, path: string): void {
    if (!node || typeof node !== 'object') return;
    assert.ok(!('additionalProperties' in node), `Gemini forbid additionalProperties at ${path}`);
    if (Array.isArray(node.type)) {
      assert.fail(`Gemini forbids union type array [${node.type.join(', ')}] at ${path}`);
    }
    if (node.type === 'object') {
      assert.ok(node.properties && typeof node.properties === 'object', `Gemini forbids empty object schema at ${path}`);
    }
    if (node.properties && typeof node.properties === 'object') {
      for (const [key, val] of Object.entries(node.properties)) {
        verifyNoGeminiViolations(val, `${path}.${key}`);
      }
    }
    if (node.items) {
      verifyNoGeminiViolations(node.items, `${path}[]`);
    }
  }

  for (const adapted of report.adaptedTools as any[]) {
    assert.ok(typeof adapted.name === 'string', 'Adapted tool must have name');
    assert.ok(typeof adapted.description === 'string', 'Adapted tool must have description');
    if (adapted.parameters) {
      verifyNoGeminiViolations(adapted.parameters, adapted.name);
    }
  }
});

test('universalToolCompliance: pre-flight toolScanner adapts all tools for Anthropic (input_schema)', () => {
  const toolDefs: ToolDefinition[] = TOOL_DEFINITIONS.map((t: any) => (t.schema ? t.schema : t));
  const report = scanAndAdaptToolsForProvider(toolDefs, 'anthropic');

  assert.equal(report.incompatibleCount, 0);
  assert.equal(report.adaptedTools.length, toolDefs.length);

  for (const adapted of report.adaptedTools as any[]) {
    assert.ok(typeof adapted.name === 'string');
    assert.ok(typeof adapted.description === 'string');
    assert.ok(adapted.input_schema && typeof adapted.input_schema === 'object', `Anthropic tool '${adapted.name}' must have input_schema`);
    assert.equal(adapted.input_schema.type, 'object', `input_schema.type must be 'object'`);
  }
});

test('universalToolCompliance: pre-flight toolScanner adapts all tools for OpenAI / BYOK providers', () => {
  const toolDefs: ToolDefinition[] = TOOL_DEFINITIONS.map((t: any) => (t.schema ? t.schema : t));
  const report = scanAndAdaptToolsForProvider(toolDefs, 'openai');

  assert.equal(report.incompatibleCount, 0);
  assert.equal(report.adaptedTools.length, toolDefs.length);

  for (const adapted of report.adaptedTools as any[]) {
    assert.equal(adapted.type, 'function');
    assert.ok(adapted.function);
    assert.ok(typeof adapted.function.name === 'string');
    assert.ok(typeof adapted.function.description === 'string');
    assert.ok(adapted.function.parameters && typeof adapted.function.parameters === 'object');
    assert.equal(adapted.function.parameters.type, 'object');
  }
});

test('universalToolCompliance: pre-flight toolScanner adapts all tools for Antigravity and ACP', () => {
  const toolDefs: ToolDefinition[] = TOOL_DEFINITIONS.map((t: any) => (t.schema ? t.schema : t));

  const agyReport = scanAndAdaptToolsForProvider(toolDefs, 'antigravity');
  assert.equal(agyReport.incompatibleCount, 0);
  assert.equal(agyReport.adaptedTools.length, toolDefs.length);
  for (const tool of agyReport.adaptedTools as any[]) {
    assert.ok(tool.name);
    assert.ok(tool.snippet && tool.snippet.includes('<tool_call>'));
  }

  const acpReport = scanAndAdaptToolsForProvider(toolDefs, 'acp/codex');
  assert.equal(acpReport.incompatibleCount, 0);
  assert.equal(acpReport.adaptedTools.length, toolDefs.length);
  for (const tool of acpReport.adaptedTools as any[]) {
    assert.ok(tool.name);
    assert.ok(tool.inputSchema && typeof tool.inputSchema === 'object');
  }
});

test('universalToolCompliance: toolSelfRepair resolves 3D/Blender, image and shell aliases to canonical names', () => {
  // Blender aliases
  assert.equal(canonicalizeToolName('blender'), 'blender_act');
  assert.equal(canonicalizeToolName('blender_act'), 'blender_act');
  assert.equal(canonicalizeToolName('blenderAutomator'), 'blender_act');
  assert.equal(canonicalizeToolName('blender_batch'), 'blender_act');
  assert.equal(canonicalizeToolName('blender_render'), 'blender_act');
  assert.equal(canonicalizeToolName('render_3d'), 'blender_act');

  // Image viewer aliases
  assert.equal(canonicalizeToolName('viewImage'), 'view_image');
  assert.equal(canonicalizeToolName('view_image'), 'view_image');
  assert.equal(canonicalizeToolName('show_image'), 'view_image');
  assert.equal(canonicalizeToolName('inspect_image'), 'view_image');

  // Core filesystem & execution aliases
  assert.equal(canonicalizeToolName('read_file'), 'fs_read');
  assert.equal(canonicalizeToolName('cat'), 'fs_read');
  assert.equal(canonicalizeToolName('write_file'), 'fs_write');
  assert.equal(canonicalizeToolName('run_command'), 'sysRun');
  assert.equal(canonicalizeToolName('bash'), 'sysRun');
});
