import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSingleAction } from '../src/computerUse/visionGrounding.js';

test('computer-use parser only accepts an exact finished directive', () => {
  assert.equal(parseSingleAction('unfinished'), null);
  assert.equal(parseSingleAction('Task is not finished yet'), null);
  assert.equal(parseSingleAction('finished')?.action, 'finished');
  assert.equal(parseSingleAction('Action: finished')?.action, 'finished');
  assert.equal(parseSingleAction('finished()')?.action, 'finished');
});
