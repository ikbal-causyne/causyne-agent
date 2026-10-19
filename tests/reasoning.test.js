// Two frames that were being thrown away, and one block that never closed.
//
// `agent_reasoning` was emitted by the loop (agentLoop.js:1113) and handled by
// NOBODY — not this renderer, not the Android app. The chain of comedy is worth
// recording: openai-compatible.js was fixed to stop discarding
// `reasoning_content` because "the reasoning the user paid for never reached
// them", and it was then discarded one layer further down. Nothing failed, no
// test caught it, and the frame simply fell through `handle()`'s switch to
// `default: return false`.
//
// The fence half is smaller but the same shape: `inFence` toggles, so an
// unbalanced ``` swallowed every remaining line into code styling and ended
// with no closing rule — the block read as still open, forever, with nothing
// saying so. Models do emit these: a reply cut short by a token limit ends
// mid-fence.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { Transcript } from '../src/tui/transcript.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';

function renderer({ columns = 90, transcript = null } = {}) {
  const written = [];
  const out = { columns, write: (text) => { written.push(text); return true; } };
  return {
    renderer: new ChatRenderer({ out, transcript }),
    text: () => stripAnsi(written.join('')),
    written
  };
}

// ---------------------------------------------------------------------------

describe('the reasoning the user paid for reaches them', () => {
  test('an agent_reasoning frame is handled at all', () => {
    const host = renderer();
    assert.equal(host.renderer.handle({ type: 'agent_reasoning', content: 'because X, then Y' }), true,
      'handle() returned false, which is how this was lost in the first place');
    assert.match(host.text(), /because X, then Y/);
    assert.match(host.text(), /thinking/, 'and it is labelled, not mistaken for the answer');
  });

  test('it is capped, and says how much it is not showing', () => {
    const host = renderer();
    const content = Array.from({ length: 40 }, (_, i) => `thought ${i}`).join('\n');
    host.renderer.handle({ type: 'agent_reasoning', content });

    const text = host.text();
    assert.match(text, /thought 0/);
    assert.ok(!text.includes('thought 39'), 'a reasoning model would bury the answer under its own notes');
    assert.match(text, /more lines of reasoning/, 'and the user is told the cap happened');
  });

  test('nothing is printed for empty reasoning', () => {
    const host = renderer();
    host.renderer.handle({ type: 'agent_reasoning', content: '   \n  ' });
    assert.equal(host.text(), '');
  });

  test('reasoning is untrusted text and is sanitised like everything else', () => {
    // It comes straight from a model. A screen clear embedded in it would be
    // the same UX-01 violation as one in tool output.
    const host = renderer();
    host.renderer.handle({ type: 'agent_reasoning', content: 'before\x1b[2Jafter\x1b]0;title\x07' });
    const raw = host.written.join('');
    assert.ok(!raw.includes('\x1b[2J'), 'a model may not clear the screen through its own reasoning');
    assert.ok(!raw.includes('\x1b]0;'), 'nor set the window title');
  });

  test('it is its own frame kind, so the rail can tell it from an answer', () => {
    const transcript = new Transcript();
    const host = renderer({ transcript });
    host.renderer.handle({ type: 'agent_reasoning', content: 'first I considered' });
    host.renderer.handle({ type: 'agent_message', content: 'the answer is 42' });

    assert.deepEqual(transcript.markers(90).map((m) => m.kind), ['reasoning', 'assistant']);
  });

  test('it reflows, and the cap survives the reflow', () => {
    const transcript = new Transcript();
    const host = renderer({ transcript });
    const content = Array.from({ length: 40 }, () => 'ratatouille '.repeat(8)).join('\n');
    host.renderer.handle({ type: 'agent_reasoning', content });

    for (const width of [50, 80, 120]) {
      const rows = transcript.rows(width);
      for (const row of rows) {
        assert.ok(visibleWidth(row) <= width, `a ${visibleWidth(row)}-column row at width ${width}`);
      }
      assert.match(stripAnsi(rows.join('\n')), /more lines of reasoning/,
        'the cap is applied at whatever width it is re-rendered');
    }
  });

  test('reasoning arrives before the answer and stays there', () => {
    const transcript = new Transcript();
    const host = renderer({ transcript });
    host.renderer.handle({ type: 'agent_reasoning', content: 'weighing options' });
    host.renderer.handle({ type: 'agent_message', content: 'do it this way' });

    const joined = stripAnsi(transcript.rows(90).join('\n'));
    assert.ok(joined.indexOf('weighing options') < joined.indexOf('do it this way'));
  });
});

// ---------------------------------------------------------------------------

describe('a code fence that never closes', () => {
  test('is marked rather than left silently open', () => {
    const host = renderer();
    host.renderer.handle({ type: 'agent_message', content: 'here:\n```js\nconst a = 1;' });
    const text = host.text();
    assert.match(text, /const a = 1;/, 'the content is still shown');
    assert.match(text, /unclosed code block/, 'and the reader is told why it ends like that');
  });

  test('a properly closed fence is not marked', () => {
    const host = renderer();
    host.renderer.handle({ type: 'agent_message', content: 'here:\n```js\nconst a = 1;\n```\ndone' });
    const text = host.text();
    assert.ok(!text.includes('unclosed code block'));
    assert.match(text, /done/, 'and text after the fence is prose again, not code');
  });

  test('two closed fences stay balanced', () => {
    const host = renderer();
    host.renderer.handle({
      type: 'agent_message',
      content: 'one:\n```\na\n```\ntwo:\n```\nb\n```\nend'
    });
    assert.ok(!host.text().includes('unclosed code block'));
  });

  test('an odd number of fences is unbalanced however many there are', () => {
    const host = renderer();
    host.renderer.handle({
      type: 'agent_message',
      content: 'one:\n```\na\n```\ntwo:\n```\nb'
    });
    assert.match(host.text(), /unclosed code block/);
  });

  test('the marker fits the terminal at every width', () => {
    for (const columns of [40, 60, 80, 102, 120, 200]) {
      const transcript = new Transcript();
      const host = renderer({ columns, transcript });
      host.renderer.handle({ type: 'agent_message', content: 'x:\n```python\nprint(1)' });
      for (const row of transcript.rows(columns)) {
        assert.ok(visibleWidth(row) <= columns,
          `a ${visibleWidth(row)}-column row at width ${columns} would wrap`);
      }
    }
  });
});
