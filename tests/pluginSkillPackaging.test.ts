import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PLUGIN_ROOT, createSkillPlugin, enablePlugin, getPluginSkills,
  getPluginToolDefinitions, listPlugins
} from '../src/plugins/pluginManager.js';
import { pluginManagerTool } from '../src/tools/pluginManager.js';

const MIT = [
  'MIT License',
  'Copyright (c) 2026 Example Author',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'The above copyright notice and this permission notice shall be included',
  'THE SOFTWARE IS PROVIDED "AS IS"'
].join('\n');

function argumentsFor(name) {
  return {
    name, skillId: 'verify-terminal',
    description: 'Reviewed terminal verification workflow',
    skillName: 'Verify terminal',
    skillDescription: 'Inspect a real PTY and check the result.',
    skillContent: '# Verify terminal\nDrive one user command and capture actual output.',
    licenseText: MIT
  };
}

test('MIT skill packaging is disabled, non-executable and preserves its license', () => {
  const result = createSkillPlugin(argumentsFor('imported-verification'));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.enabled, false);
  assert.deepEqual(result.tools, []);
  assert.equal(result.license, 'MIT');
  assert.equal(getPluginSkills().filter(x => x.plugin === result.name).length, 0);
  assert.equal(fs.readFileSync(path.join(result.path, 'LICENSE'), 'utf8'), MIT);
  assert.equal(listPlugins().find(x => x.name === result.name).enabled, false);
  assert.equal(enablePlugin(result.name).ok, true);
  const imported = getPluginSkills().filter(x => x.plugin === result.name);
  assert.equal(imported.length, 1);
  assert.match(imported[0].content, /Drive one user command/);
  assert.equal(getPluginToolDefinitions().some(x => x.name.includes('imported_verification')), false);
});

test('modified source or license revokes enabled third-party skill content', () => {
  const created = createSkillPlugin(argumentsFor('imported-revocation'));
  assert.equal(created.ok, true);
  assert.equal(enablePlugin(created.name).ok, true);
  fs.appendFileSync(path.join(created.path, 'LICENSE'), '\nmodified');
  assert.equal(listPlugins().find(x => x.name === created.name).modified, true);
  assert.equal(getPluginSkills().some(x => x.plugin === created.name), false);
});

test('unsafe or unknown licenses and oversized skill content are not packaged', () => {
  const bogus = createSkillPlugin({ ...argumentsFor('unknown-license'), licenseText: 'BSD' });
  assert.equal(bogus.ok, false);
  assert.match(bogus.error, /MIT or Apache/);
  const large = createSkillPlugin({
    ...argumentsFor('oversized-skill'), skillContent: 'X'.repeat(32769)
  });
  assert.equal(large.ok, false);
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, 'oversized-skill')), false);
  assert.equal(createSkillPlugin(argumentsFor('../escape')).ok, false);
});

test('plugin.manager exposes safe skill packaging without automatic enablement', async () => {
  const response = await pluginManagerTool.execute({
    action: 'create-skill-plugin', ...argumentsFor('plugin-tool-skill')
  });
  assert.equal(response.success, true, JSON.stringify(response));
  assert.equal(response.enabled, false);
  const row = listPlugins().find(x => x.name === 'plugin-tool-skill');
  assert.ok(row);
  assert.equal(row.enabled, false);
  assert.deepEqual(row.tools, []);
});
