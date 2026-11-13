import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSingleAction, visionGroundingToDesktopAct } from '../src/computerUse/visionGrounding.js';

test('quoted computer-use typing retains apostrophes and embedded quotes', () => {
  const doubleQuoted = parseSingleAction('type(content="It\'s a test, yes")');
  assert.equal(doubleQuoted?.text, "It's a test, yes");
  const singleQuoted = parseSingleAction(`type(content='He said "hello"')`);
  assert.equal(singleQuoted?.text, 'He said "hello"');
  const typed = visionGroundingToDesktopAct([doubleQuoted!, singleQuoted!]);
  assert.deepEqual(typed.map(a => a.text), ["It's a test, yes", 'He said "hello"']);
});

test('escaped string delimiters are unescaped before typing', () => {
  const action = parseSingleAction(String.raw`type(content='it\'s fine')`);
  assert.equal(action?.text, "it's fine");
});
