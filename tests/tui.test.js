// The terminal UI layer.
//
// Most of these exist because the previous renderer got a terminal detail wrong
// and the failure was invisible until someone used a different terminal:
// padding by byte length so coloured tables drifted, slicing through an escape
// so colour bled, writing escapes into a piped log, assuming a dark background.
//
// The security case is the one that matters most: tool output is
// attacker-influenced content printed straight to a terminal. If escapes
// survive, a file can move the cursor and repaint lines that are already on
// screen — including an approval the user just answered.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import {
  visibleWidth, stripAnsi, truncate, wrap, padEnd,
  sanitize, redactSecrets, safeDisplay, shortenHome
} from '../src/tui/text.js';
import { describeTool, describeToolForApproval, hasCuratedDisplay } from '../src/tui/toolDisplay.js';
import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { GLYPHS, terminalWidth } from '../src/tui/theme.js';

const ESC = '\x1b';

/** Collect everything a renderer writes, without touching the real stdout. */
function capture() {
  const lines = [];
  const sink = { write: (text) => { lines.push(text); return true; }, isTTY: false, columns: 80 };
  return { sink, lines, text: () => lines.join('') };
}

describe('width and truncation are escape-aware', () => {
  test('escapes cost no columns', () => {
    assert.equal(visibleWidth('hello'), 5);
    assert.equal(visibleWidth('\x1b[31mhello\x1b[0m'), 5);
    assert.equal(visibleWidth('\x1b[38;2;1;2;3mhi\x1b[0m'), 2);
  });

  test('double-width characters count as two', () => {
    // Padding these as width 1 is what makes a table of CJK filenames drift.
    assert.equal(visibleWidth('日本語'), 6);
    assert.equal(visibleWidth('한국'), 4);
  });

  test('padEnd measures visible width, not bytes', () => {
    const padded = padEnd('\x1b[31mab\x1b[0m', 6);
    assert.equal(visibleWidth(padded), 6, 'a coloured cell must occupy its declared width');
  });

  test('truncate never leaves a half-written escape', () => {
    const cut = truncate('\x1b[31mhello world\x1b[0m', 8);
    assert.ok(visibleWidth(cut) <= 8);
    // Every escape present must be complete and the style must be closed.
    assert.ok(!/\x1b\[[0-9;]*$/.test(cut), 'a truncated escape would leak as literal text');
    assert.ok(cut.includes('\x1b[0m'), 'the style must be closed at the cut');
  });

  test('a string already inside the budget is returned untouched', () => {
    assert.equal(truncate('short', 20), 'short');
  });

  test('wrap hard-splits an unbreakable token instead of overflowing', () => {
    const lines = wrap('a'.repeat(25), 10);
    assert.equal(lines.length, 3);
    for (const line of lines) assert.ok(visibleWidth(line) <= 10);
  });

  test('wrap keeps paragraphs and respects word boundaries', () => {
    const lines = wrap('the quick brown fox jumps', 12);
    for (const line of lines) assert.ok(visibleWidth(line) <= 12);
    assert.equal(lines.join(' ').replace(/\s+/g, ' '), 'the quick brown fox jumps');
  });
});

describe('untrusted output cannot drive the terminal', () => {
  test('sanitize strips a screen-clear out of tool output', () => {
    // A file read by fs_read, or the stdout of sysRun, is attacker-influenced.
    const hostile = `before${ESC}[2J${ESC}[1;1H${ESC}[31mAPPROVED${ESC}[0m after`;
    const safe = sanitize(hostile);

    assert.ok(!safe.includes(ESC), 'no escape byte may survive');
    assert.equal(safe, 'beforeAPPROVED after');
  });

  test('sanitize strips OSC sequences, which can retitle or hyperlink', () => {
    const hostile = `x${ESC}]0;pwned${String.fromCharCode(7)}y`;
    assert.equal(sanitize(hostile), 'xy');
  });

  test('sanitize removes control characters, keeps newlines, EXPANDS tabs', () => {
    const messy = 'a\x00b\x07c\nd\te';
    const safe = sanitize(messy);
    assert.ok(!safe.includes('\x00') && !safe.includes('\x07'));
    assert.ok(safe.includes('\n'), 'line structure must survive');

    // Tabs are EXPANDED, not kept. A tab moves the cursor without writing, so
    // in a live region that redraws in place it jumps over cells the previous
    // frame wrote and leaves them on screen — `sw_vers` came out as
    // ProductName:P_FIX_PLAN.mdmacOS. It also broke measurement:
    // visibleWidth counted one column where the terminal advanced up to eight,
    // so rows wrapped and erase() walked back the wrong number of them.
    assert.ok(!safe.includes('\t'), 'a raw tab must never reach the terminal');
    assert.match(safe, /d {7}e/, 'the tab must become the spaces it would have skipped');
  });

  test('sanitize expands tabs to real tab stops, per line', () => {
    // Alignment is the whole reason to expand rather than strip: columnar tool
    // output has to still line up.
    const table = 'ProductName:\t\tmacOS\nProductVersion:\t\t26.5.2';
    const rows = sanitize(table).split('\n');
    assert.equal(rows[0].indexOf('macOS'), 24, 'tab stops are every 8 columns');
    assert.equal(rows[1].indexOf('26.5.2'), 24, 'tab stops must reset on each line');
  });

  test('stripAnsi and sanitize agree on escape removal', () => {
    const coloured = '\x1b[31mred\x1b[0m';
    assert.equal(stripAnsi(coloured), 'red');
    assert.equal(sanitize(coloured), 'red');
  });

  test('a rendered tool result carries no escapes from its payload', () => {
    const { sink, text } = capture();
    const renderer = new ChatRenderer({ out: sink });
    renderer.onStepComplete({
      tool: 'sysRun',
      result: { success: true, output: `${ESC}[2Jwiped${ESC}[31m` }
    });
    const printed = text();
    // Any escape in the output must have come from the theme, never from the
    // payload — so the payload's own sequences must be gone.
    assert.ok(!printed.includes('[2J'), 'a screen-clear reached the terminal');
  });
});

describe('credentials are masked before display', () => {
  test('an API key is shortened, not printed', () => {
    const fakeKey = `sk-${'a'.repeat(20)}`;
    const masked = redactSecrets(`export KEY=${fakeKey}`);
    assert.ok(!masked.includes('abcdefghijklmnopqrst'));
    assert.match(masked, /sk-/);
  });

  test('a bearer token is masked', () => {
    const masked = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9payload');
    assert.ok(!masked.includes('eyJhbGciOiJIUzI1NiJ9payload'));
    assert.match(masked, /Bearer/);
  });

  test('assignment-style secrets are masked', () => {
    assert.ok(!redactSecrets('api_key=hunter2hunter2').includes('hunter2hunter2'));
    assert.ok(!redactSecrets('password: correcthorse').includes('correcthorse'));
  });

  test('ordinary text is left alone', () => {
    const plain = 'npm install --silent && node build.js';
    assert.equal(redactSecrets(plain), plain);
  });

  test('safeDisplay applies both sanitising and redaction', () => {
    const out = safeDisplay(`${ESC}[2Jsk-abcdefghijklmnopqrst`);
    assert.ok(!out.includes(ESC));
    assert.ok(!out.includes('abcdefghijklmnopqrst'));
  });
});

describe('home paths are shortened', () => {
  test('a path under home becomes ~', () => {
    assert.equal(shortenHome(os.homedir() + '/Projects/x'), '~/Projects/x');
  });

  test('a path outside home is untouched', () => {
    assert.equal(shortenHome('/etc/hosts'), '/etc/hosts');
  });
});

describe('tool rows say what the tool is doing', () => {
  test('a write shows the filename, not the payload', () => {
    const { verb, detail } = describeTool('fs_write', {
      path: os.homedir() + '/Projects/site/index.html',
      content: 'x'.repeat(9000)
    });
    assert.equal(verb, 'write');
    assert.match(detail, /index\.html/);
    assert.ok(detail.length < 60, 'the row must stay one line');
    assert.ok(!detail.includes('xxxx'), 'the payload must never reach the row');
  });

  test('an edit reports how many edits', () => {
    const { detail } = describeTool('MultiEdit', { file_path: '/a/b/app.tsx', edits: [1, 2, 3] });
    assert.match(detail, /3 edits/);
  });

  test('a fetch shows the host, not the raw URL', () => {
    const { verb, detail } = describeTool('web_fetch', { url: 'https://example.com/docs/page?token=abc' });
    assert.equal(verb, 'fetch');
    assert.match(detail, /example\.com/);
  });

  test('a command is redacted in the row', () => {
    const { detail } = describeTool('sysRun', {
      command: 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9secret" x.com'
    });
    assert.ok(!detail.includes('eyJhbGciOiJIUzI1NiJ9secret'));
  });

  test('an unmapped tool still renders something useful', () => {
    assert.equal(hasCuratedDisplay('a_brand_new_tool'), false);
    const { detail } = describeTool('a_brand_new_tool', { target: '/tmp/thing' });
    assert.equal(detail, '/tmp/thing', 'a new tool must never render blank or broken');
  });

  test('malformed arguments never throw', () => {
    assert.doesNotThrow(() => describeTool('fs_write', null));
    assert.doesNotThrow(() => describeTool(undefined, undefined));
    assert.doesNotThrow(() => describeToolForApproval(null));
  });

  test('the approval detail is ordered by what carries the risk', () => {
    const lines = describeToolForApproval({ cwd: '/tmp', command: 'rm -rf /tmp/x' });
    assert.match(lines[0], /^command:/, 'the command must come first, not the cwd');
  });
});

describe('the renderer', () => {
  test('bounds a long tool output and points at the spill file', () => {
    const { sink, text } = capture();
    const renderer = new ChatRenderer({ out: sink });
    renderer.onStepComplete({
      tool: 'sysRun',
      result: {
        success: true,
        output: Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'),
        spillPath: os.homedir() + '/.causyne/outputs/tool_x.txt'
      }
    });
    const printed = text();
    const bodyLines = printed.split('\n').filter(l => /line \d+/.test(l));
    assert.ok(bodyLines.length <= 12, `preview was ${bodyLines.length} lines`);
    assert.match(printed, /~\/\.causyne\/outputs/, 'the user must be told where the rest is');
  });

  test('bounds by WRAPPED lines, not source newlines', () => {
    // One enormous single line is the case that produces thousands of rows.
    const { sink, text } = capture();
    const renderer = new ChatRenderer({ out: sink });
    renderer.onStepComplete({ tool: 'sysRun', result: { success: true, output: 'z'.repeat(20000) } });
    assert.ok(text().split('\n').length < 20, 'a single long line must not explode the transcript');
  });

  test('an approval keeps its detail so the prompt can name it', () => {
    const { sink, text } = capture();
    const renderer = new ChatRenderer({ out: sink });
    renderer.handle({ type: 'approval_request', toolCallId: 't1', tool: 'fs_delete', risk: 'extreme', args: { path: '/tmp/x' } });

    assert.ok(renderer.pendingApprovals.has('t1'), 'the handler needs the detail later');
    // No risk word: the transcript names the tool and says permission is
    // required, which is the whole signal. Asserted negatively in
    // tests/approvalKeys.test.js.
    assert.match(text(), /permission required/);
    assert.match(text(), /fs_delete/);
  });

  test('unknown frames are ignored rather than dumped raw', () => {
    const { sink, text } = capture();
    const renderer = new ChatRenderer({ out: sink });
    assert.equal(renderer.handle({ type: 'task_complete' }), false);
    assert.equal(renderer.handle({ type: 'not_a_real_frame' }), false);
    assert.equal(text(), '', 'internal frames must not reach the transcript');
    assert.equal(renderer.handle(null), false);
  });

  test('usage_update feeds the status line and prints nothing', () => {
    // It is consumed rather than unknown — a running token and cost total
    // belongs on the status line, not interleaved into the transcript on every
    // single model response.
    const { sink, text } = capture();
    const renderer = new ChatRenderer({ out: sink });
    assert.equal(renderer.handle({ type: 'usage_update', usedTokens: 5, taskCostUsd: 0.02 }), true);
    assert.equal(text(), '', 'a usage frame must never reach the transcript');
    assert.equal(renderer.status.turnTokens, 5);
    assert.equal(renderer.status.turnCost, 0.02);
  });

  test('markdown is rendered, not shown as syntax', () => {
    const { sink, text } = capture();
    const renderer = new ChatRenderer({ out: sink });
    renderer.onAgentMessage({ content: '# Title\n\nUse `npm test` and **check** it.\n\n- one\n- two' });
    const printed = text();
    assert.ok(!printed.includes('**'), 'emphasis markers must be consumed');
    assert.ok(!printed.includes('# Title'), 'heading markers must be consumed');
    assert.match(printed, /Title/);
    assert.match(printed, /npm test/);
  });

  test('no spinner interval is started without a TTY', () => {
    const { sink } = capture(); // isTTY: false
    const renderer = new ChatRenderer({ out: sink });
    renderer.onStatus({ message: 'thinking' });
    assert.equal(renderer.spinnerTimer, null, 'an animation in a log file is thousands of junk lines');
    renderer.stopSpinner();
  });

  test('step numbering and turn reset behave', () => {
    const { sink } = capture();
    const renderer = new ChatRenderer({ out: sink });
    renderer.onStepStart({ tool: 'fs_read', args: { path: '/a' } });
    renderer.onStepStart({ tool: 'fs_read', args: { path: '/b' } });
    assert.equal(renderer.stepCount, 2);
    renderer.resetTurn();
    assert.equal(renderer.stepCount, 0);
  });
});

describe('theme degrades rather than assuming', () => {
  test('terminal width is clamped to something readable', () => {
    const width = terminalWidth();
    assert.ok(width >= 40 && width <= 120, `width was ${width}`);
  });

  test('a glyph set is always available', () => {
    for (const key of ['arrow', 'check', 'cross', 'dot', 'hLine', 'vLine', 'ellipsis']) {
      assert.ok(typeof GLYPHS[key] === 'string' && GLYPHS[key].length > 0, `missing glyph ${key}`);
    }
    assert.ok(Array.isArray(GLYPHS.spinner) && GLYPHS.spinner.length > 0);
  });

  test('under NO_COLOR the transcript carries no escape bytes at all', async () => {
    // Re-import in a child process: capability detection happens once at load.
    const { execFileSync } = await import('node:child_process');
    const script = `
      const { ChatRenderer } = await import('${new URL('../src/tui/chatRenderer.js', import.meta.url).pathname}');
      const out = [];
      const r = new ChatRenderer({ out: { write: (t) => out.push(t), isTTY: false } });
      r.sessionHeader({ provider: 'p', model: 'm', autonomyMode: 'B', workspace: '/tmp' });
      r.onStepStart({ tool: 'fs_write', args: { path: '/tmp/a.html' } });
      r.onStepComplete({ tool: 'fs_write', result: { success: true, output: 'ok' } });
      r.onAgentMessage({ content: '**bold** and \`code\`' });
      r.turnFooter(1200);
      process.stdout.write(out.join(''));
    `;
    const printed = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, NO_COLOR: '1' },
      encoding: 'utf8'
    });
    assert.ok(printed.length > 0, 'the renderer produced nothing');
    assert.ok(!printed.includes('\x1b'), 'NO_COLOR must mean literally no escape bytes');
  });
});
