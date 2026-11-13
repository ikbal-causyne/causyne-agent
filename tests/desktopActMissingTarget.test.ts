import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('a missing named desktop target aborts remaining actions and cannot report success', () => {
  const source = fs.readFileSync(path.resolve('src/tools/desktopAct.js'), 'utf8');
  const script = fs.readFileSync(path.resolve('src/tool-scripts/desktop_act.applescript'), 'utf8');
  assert.match(script, /set report to report & "miss\|press\|" & elemName & linefeed\s+exit repeat/);
  assert.match(source, /success: missed === 0/);
  assert.match(source, /remaining actions were not executed/);
});
