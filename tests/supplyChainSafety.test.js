import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isExactPyPiPin,
  manageLocalDependencies
} from '../src/tools/manageLocalAiDependencies.js';
import { palmierAutomator } from '../src/tools/palmierAutomator.js';

test('optional Python installation accepts only exact registry pins', () => {
  assert.equal(isExactPyPiPin('pillow==11.3.0'), true);
  assert.equal(isExactPyPiPin('package_name[image]==2.0.1'), true);

  for (const unsafe of [
    'pillow',
    'pillow>=11',
    '--index-url=https://example.test/simple',
    'git+https://example.test/repo.git',
    'https://example.test/package.whl',
    '../../local-package',
    'pillow==11.3.0; touch /tmp/injected'
  ]) {
    assert.equal(isExactPyPiPin(unsafe), false, `${unsafe} must be rejected`);
  }
});

test('dependency manager exposes no arbitrary binary download action', () => {
  const actions = manageLocalDependencies.schema.parameters.properties.action.enum;
  assert.equal(actions.includes('fetchBin'), false);
  assert.equal(actions.includes('fetchMod'), false);
});

test('missing engine check does not write a fake installation', async () => {
  const original = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-engine-check-'));
  try {
    process.chdir(temp);
    const result = await manageLocalDependencies.execute({
      action: 'check_and_setupEng',
      engine: 'godot',
      simulateMissing: true
    });
    assert.equal(result.success, false);
    assert.equal(result.status, 'not_installed');
    assert.equal(fs.existsSync(path.join(temp, '.ai_tools')), false);
  } finally {
    process.chdir(original);
  }
});

test('Palmier adapter cannot install third-party applications', () => {
  const actions = palmierAutomator.schema.parameters.properties.action.enum;
  assert.equal(actions.includes('install'), false);
});
