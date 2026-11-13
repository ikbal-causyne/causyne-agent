import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('native action filenames alone cannot assert that web source was inspected', () => {
  const source = fs.readFileSync('src/agentLoop.ts', 'utf8');
  const start = source.indexOf('onNativeAction: (action: any) => {');
  const end = source.indexOf('const nativeCode = codeProgressFromAction(', start);
  assert.ok(start > 0 && end > start);
  const callback = source.slice(start, end);
  assert.match(callback, /this\.recordInspectedWebFile\(rawDetail\)/);
  assert.doesNotMatch(callback, /this\.webVerificationState\.htmlInspected\s*=\s*true/);
});
