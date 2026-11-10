import test from 'node:test';
import assert from 'node:assert/strict';
import { detectInlineSlashTrigger, removeInlineSlashToken, isInlineSkillInvocation } from '../src/tui/inlineSlash.js';

test('detects slash after nonempty draft', () => {
  const s = 'Please continue /mo';
  const r = detectInlineSlashTrigger(s, s.length);
  assert.equal(r?.kind, 'command');
  assert.equal(r?.inline, true);
  assert.equal(r?.query, 'mo');
  assert.equal(r?.tokenStart, s.indexOf('/mo'));
});

test('retains leading slash behavior', () => {
  const r = detectInlineSlashTrigger('  /mode', 7);
  assert.equal(r?.kind, 'command');
  assert.equal(r?.inline, false);
});

test('recognizes argument completion after prose', () => {
  const s = 'Create a game /skills dev';
  const r = detectInlineSlashTrigger(s, s.length);
  assert.equal(r?.kind, 'command-argument');
  assert.equal(r?.command, 'skills');
  assert.equal(r?.query, 'dev');
});

test('never treats URL, relative filepath, or absolute filepath as command', () => {
  for (const s of ['https://foo.example/path', 'run src/main.ts', 'read /usr/local/bin', 'foo/bar', 'x /Users/foo']) {
    assert.equal(detectInlineSlashTrigger(s, s.length), null, s);
  }
});

test('preserves surrounding content and caret', () => {
  const s = 'Before /model After';
  const pos = s.indexOf('/model') + 3;
  const r = detectInlineSlashTrigger(s, pos);
  const removed = removeInlineSlashToken(s, pos, r);
  assert.deepEqual(removed, { text: 'Before  After', cursor: 7 });
});

test('respects UTF-16 and line boundaries', () => {
  const s = '🧪 Build\nnext /model';
  const r = detectInlineSlashTrigger(s, s.length);
  assert.equal(removeInlineSlashToken(s, s.length, r).text, '🧪 Build\nnext ');
});

test('detects valid skill invocation without treating management as skill execution', () => {
  assert.equal(isInlineSkillInvocation('/skills devops/docker-multi-stage-builds'), true);
  assert.equal(isInlineSkillInvocation('/skills devops'), false);
  assert.equal(isInlineSkillInvocation('/skill rm a/b'), false);
  assert.equal(isInlineSkillInvocation('/model'), false);
});

test('refuses stale token coordinates rather than modifying draft', () => {
  const s = 'A /help';
  const r = detectInlineSlashTrigger(s, s.length);
  assert.throws(() => removeInlineSlashToken('A changed', s.length, r), /Stale/);
});
