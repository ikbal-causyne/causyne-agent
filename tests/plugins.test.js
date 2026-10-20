import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PLUGIN_ROOT,
  createPlugin,
  disablePlugin,
  enablePlugin,
  getPluginSkills,
  getPluginToolDefinitions,
  listPlugins,
  resolvePluginTool
} from '../src/plugins/pluginManager.js';
import { listCompiledSkills, readCompiledSkill } from '../src/skillsManager.js';

function createEchoPlugin(overrides = {}) {
  return createPlugin({
    name: overrides.name || 'echo-test',
    description: 'Test plugin with one deterministic tool.',
    toolName: overrides.toolName || 'echo',
    toolDescription: 'Returns the supplied value.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value']
    },
    code: overrides.code || 'return { success: true, output: args.value, workspaceRoot: context.workspaceRoot };',
    capabilities: overrides.capabilities || []
  });
}

test('plugins: creation is disabled, enablement pins reviewed bytes, and execution is isolated', async () => {
  const created = createEchoPlugin();
  assert.equal(created.ok, true);
  assert.equal(created.enabled, false);
  assert.equal(getPluginToolDefinitions().length, 0, 'disabled plugin leaked into the model tool pool');

  const enabled = enablePlugin('echo-test');
  assert.equal(enabled.ok, true);
  assert.match(enabled.digest, /^[a-f0-9]{64}$/);

  const definitions = getPluginToolDefinitions();
  assert.deepEqual(definitions.map((entry) => entry.name), ['plugin__echo_test__echo']);
  assert.equal(definitions[0].xCausyneDeferred, true);

  const tool = resolvePluginTool('plugin__echo_test__echo');
  assert.ok(tool);
  const result = await tool.execute({ value: 'hello' }, { workspaceRoot: process.cwd() });
  assert.equal(result.success, true);
  assert.equal(result.output, 'hello');
  assert.equal(result.workspaceRoot, process.cwd());

  assert.equal(disablePlugin('echo-test').ok, true);
  assert.equal(resolvePluginTool('plugin__echo_test__echo'), null);
});

test('plugins: discovery validates manifests but never imports extension code', async () => {
  const created = createEchoPlugin({
    name: 'no-pretrust-exec',
    code: 'export function execute() { throw new Error("loaded only during execution"); }'
  });
  assert.equal(created.ok, true);
  assert.equal(enablePlugin('no-pretrust-exec').ok, true);

  assert.doesNotThrow(() => getPluginToolDefinitions());
  assert.ok(getPluginToolDefinitions().some((entry) => entry.name === 'plugin__no_pretrust_exec__echo'));

  const result = await resolvePluginTool('plugin__no_pretrust_exec__echo').execute({}, {
    workspaceRoot: process.cwd()
  });
  assert.equal(result.success, false);
  assert.match(result.error, /loaded only during execution/);
});

test('plugins: changing a trusted manifest revokes enablement until it is reviewed again', () => {
  assert.equal(createEchoPlugin({ name: 'digest-pin' }).ok, true);
  assert.equal(enablePlugin('digest-pin').ok, true);

  const manifestFile = path.join(PLUGIN_ROOT, 'digest-pin', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.description = 'Changed after trust was granted.';
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  const listed = listPlugins().find((plugin) => plugin.name === 'digest-pin');
  assert.equal(listed.modified, true);
  assert.equal(listed.enabled, false);
  assert.equal(resolvePluginTool('plugin__digest_pin__echo'), null);
});

test('plugins: changing trusted executable source also revokes enablement', () => {
  assert.equal(createEchoPlugin({ name: 'source-pin' }).ok, true);
  assert.equal(enablePlugin('source-pin').ok, true);

  const sourceFile = path.join(PLUGIN_ROOT, 'source-pin', 'echo.js');
  fs.appendFileSync(sourceFile, '\n// changed after review\n');

  const listed = listPlugins().find((plugin) => plugin.name === 'source-pin');
  assert.equal(listed.modified, true);
  assert.equal(listed.enabled, false);
  assert.equal(resolvePluginTool('plugin__source_pin__echo'), null);
});

test('plugins: workspace files stay unreadable without an explicit read capability', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-plugin-workspace-'));
  const secretFile = path.join(workspace, 'private.txt');
  fs.writeFileSync(secretFile, 'private workspace value');

  try {
    const created = createEchoPlugin({
      name: 'no-workspace-read',
      code: `
        const fs = await import('node:fs');
        return { success: true, output: fs.readFileSync(args.path, 'utf8') };
      `
    });
    assert.equal(created.ok, true);
    assert.equal(enablePlugin('no-workspace-read').ok, true);

    const result = await resolvePluginTool('plugin__no_workspace_read__echo').execute({ path: secretFile }, {
      workspaceRoot: workspace
    });
    assert.equal(result.success, false);
    assert.match(result.error, /permission|access|operation not permitted/i);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('plugins: reviewed packages can contribute progressively disclosed skills without executing code', () => {
  const directory = path.join(PLUGIN_ROOT, 'skill-pack');
  fs.mkdirSync(directory, { recursive: true });
  const manifestFile = path.join(directory, 'plugin.json');
  const skillFile = path.join(directory, 'release-review.md');
  const markerFile = path.join(directory, 'must-not-run.js');
  fs.writeFileSync(skillFile, '# Release review\n\nInspect the exact package artifact before publication.\n');
  fs.writeFileSync(markerFile, 'throw new Error("plugin discovery executed JavaScript");\n');
  const manifest = {
    schemaVersion: 1,
    name: 'skill-pack',
    version: '0.1.0',
    description: 'Prompt-only release skills.',
    skills: [{
    id: 'release-review',
    name: 'Release review',
    description: 'Inspect a release artifact before publishing it.',
    file: 'release-review.md'
    }]
  };
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  assert.equal(getPluginSkills().length, 0, 'disabled plugin skill leaked into the catalogue');
  assert.equal(enablePlugin('skill-pack').ok, true);

  const skills = getPluginSkills();
  assert.equal(skills.length, 1);
  assert.equal(skills[0].domain, 'plugin-skill-pack');
  assert.match(skills[0].content, /exact package artifact/);
  assert.ok(listCompiledSkills().some((skill) =>
    skill.domain === 'plugin-skill-pack'
      && skill.id === 'release-review'
      && skill.source === 'plugin'));
  assert.match(readCompiledSkill('plugin-skill-pack', 'release-review'), /Inspect the exact package/);

  fs.appendFileSync(skillFile, '\nChanged after review.\n');
  assert.equal(getPluginSkills().length, 0, 'modified plugin skill retained stale trust');
  assert.doesNotMatch(readCompiledSkill('plugin-skill-pack', 'release-review'), /exact package artifact/);
});
