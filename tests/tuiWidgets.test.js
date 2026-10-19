// The widgets the chat surface is built from: fuzzy select, the modal layers,
// the approval panel, the command palette, and the wordmark.
//
// This file used to also cover a cell grid, a flexbox layout engine, a scrollback
// transcript and a full-screen alternate-buffer shell. Those are gone: chat now
// renders in the NORMAL buffer and never takes the terminal over (UX-01), so the
// screen/transcript/layout/appShell modules were removed with it. The contracts
// that replaced them live in tests/chatSurface.test.js.
//
// What survives here are the pieces that were always buffer-agnostic — every one
// of these produces styled `string[]`, which is exactly why they port straight
// into a normal-buffer live region.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SelectList, fuzzyScore, fuzzyFilter } from '../src/tui/selectList.js';
import { OverlayStack, Layer, drawPanel } from '../src/tui/overlay.js';
import { ApprovalLayer, TextLayer, commandPalette, skillPicker } from '../src/tui/dialogs.js';
import { listCompiledSkills } from '../src/skillsManager.js';
import { wordmark } from '../src/tui/banner.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';

/**
 * A minimal surface drawPanel can paint onto.
 *
 * overlay.js never imported the cell grid — it only ever duck-typed one, which is
 * why it survived the move off the alternate buffer. This proves that: the panel
 * geometry is exercised against a stub with no grid behind it at all.
 */
function fresh(width, height) {
  const painted = [];
  return {
    screen: {
      width,
      height,
      cells: new Array(width * height).fill(null).map(() => ({ style: '' })),
      clear() { painted.length = 0; },
      fill(x, y, w, h) { painted.push({ kind: 'fill', x, y, w, h }); },
      put(x, y, text) { painted.push({ kind: 'put', x, y, text }); },
      setCursor() {}
    },
    painted
  };
}


describe('fuzzy select', () => {
  test('initials find the command', () => {
    const items = [
      { label: 'session.list' }, { label: 'model.list' },
      { label: 'checkpoint.restore' }, { label: 'session.new' }
    ];
    assert.equal(fuzzyFilter(items, 'sesl')[0].item.label, 'session.list');
    assert.equal(fuzzyFilter(items, 'ckpt')[0].item.label, 'checkpoint.restore');
    assert.equal(fuzzyFilter(items, 'zzz').length, 0);
  });

  test('a consecutive match outranks a scattered one', () => {
    const tight = fuzzyScore('list', 'list');
    const loose = fuzzyScore('list', 'l-i-s-t-extra');
    assert.ok(tight.score > loose.score);
  });

  test('an empty query keeps the declared order', () => {
    const items = [{ label: 'b' }, { label: 'a' }];
    assert.deepEqual(fuzzyFilter(items, '').map((entry) => entry.item.label), ['b', 'a']);
  });

  test('selection wraps at both ends', () => {
    const list = new SelectList([{ label: 'a' }, { label: 'b' }, { label: 'c' }]);
    list.move(-1, 5);
    assert.equal(list.current.label, 'c', 'up from the first row lands on the last');
    list.move(1, 5);
    assert.equal(list.current.label, 'a');
  });

  test('backspace on an empty filter cancels rather than doing nothing', () => {
    const list = new SelectList([{ label: 'a' }]);
    assert.equal(list.handleKey({ name: 'backspace' }, 5), 'cancel');
  });
});

describe('the modal stack', () => {
  test('escape pops exactly one layer', () => {
    const stack = new OverlayStack();
    stack.push(new TextLayer({ lines: ['one'] }));
    stack.push(new TextLayer({ lines: ['two'] }));
    assert.equal(stack.depth, 2);
    stack.handleKey({ name: 'escape' });
    assert.equal(stack.depth, 1, 'one escape must not unwind the whole stack');
    stack.handleKey({ name: 'escape' });
    assert.equal(stack.depth, 0);
  });

  test('a key never reaches a layer below the top', () => {
    const seen = [];
    class Spy extends Layer {
      constructor(name) { super({}); this.name = name; }
      key() { seen.push(this.name); return 'handled'; }
    }
    const stack = new OverlayStack();
    stack.push(new Spy('bottom'));
    stack.push(new Spy('top'));
    stack.handleKey({ name: 'a', sequence: 'a' });
    assert.deepEqual(seen, ['top'], 'the layer underneath was reached');
  });

  test('handleKey reports consumption so the prompt beneath stays untouched', () => {
    const stack = new OverlayStack();
    assert.equal(stack.handleKey({ name: 'a' }), false, 'nothing open means nothing consumed');
    stack.push(new TextLayer({ lines: ['x'] }));
    assert.equal(stack.handleKey({ name: 'a' }), true, 'an open modal consumes every key');
  });

  test('a panel fits inside its rect and returns a smaller inner rect', () => {
    const { screen } = fresh(40, 12);
    screen.clear();
    const inner = drawPanel(screen, { x: 2, y: 1, width: 30, height: 8 }, { title: 'x', footer: 'y' });
    assert.ok(inner.width < 30 && inner.height < 8);
    assert.ok(inner.x >= 2 && inner.y >= 1);
  });
});

describe('approval as a modal', () => {
  const request = {
    tool: 'fs_edit',
    risk: 'DANGEROUS',
    args: { path: '/tmp/x.js', edits: [{ searchContent: 'a', replaceContent: 'b' }] }
  };

  test('y approves and n denies', () => {
    let answer = null;
    const layer = new ApprovalLayer({ request, onAnswer: (value) => { answer = value; } });
    layer.key({ name: 'y' });
    assert.equal(answer, true);

    answer = null;
    const second = new ApprovalLayer({ request, onAnswer: (value) => { answer = value; } });
    second.key({ name: 'n' });
    assert.equal(answer, false);
  });

  test('enter is NOT bound to approve', () => {
    // A dialog where the dangerous answer is the one everybody presses without
    // reading is not an approval gate.
    //
    // Enter now COMMITS THE HIGHLIGHTED OPTION rather than doing nothing — the
    // ←/→ + enter model this dialog took from opencode. The guarantee is
    // unchanged and is what this asserts: the highlight starts on Deny, so a
    // reflex enter still refuses. Only the mechanism moved.
    let answer = null;
    const layer = new ApprovalLayer({ request, onAnswer: (value) => { answer = value; } });
    layer.key({ name: 'return' });
    assert.notEqual(answer, true, 'enter must never approve');
    assert.equal(answer, false, 'enter should commit the safe default');
  });

  test('escape denies, and dismissal denies', () => {
    let answer = null;
    const layer = new ApprovalLayer({ request, onAnswer: (value) => { answer = value; } });
    layer.key({ name: 'escape' });
    assert.equal(answer, false);
  });

  test('an answer is delivered once, however many keys arrive', () => {
    const answers = [];
    const layer = new ApprovalLayer({ request, onAnswer: (value) => answers.push(value) });
    layer.key({ name: 'y' });
    layer.key({ name: 'n' });
    assert.deepEqual(answers, [true], 'a second key must not re-answer a closed question');
  });

  test('the diff is rendered inside the dialog', () => {
    const layer = new ApprovalLayer({ request, detail: 'x.js' });
    const rows = layer.body(70, 14).map(stripAnsi).join('\n');
    // The risk WORD is deliberately not shown any more — it made people numb
    // to a gate that only matters if they read it. The tool name and the diff
    // are the content; colour carries the tier. See tests/approvalKeys.test.js.
    assert.match(rows, /fs_edit/);
    assert.match(rows, /- ?a/);
    assert.match(rows, /\+ ?b/);
  });

  test('a tool with no diff still shows its arguments', () => {
    const layer = new ApprovalLayer({ request: { tool: 'sysRun', risk: 'EXTREME', args: { command: 'rm -rf /tmp/x' } } });
    const rows = layer.body(70, 12).map(stripAnsi).join('\n');
    assert.match(rows, /rm -rf/, 'approving a shell command with the command hidden is not consent');
  });
});

describe('the palette', () => {
  test('it runs the command that was picked, then closes', () => {
    let ran = null;
    const layer = commandPalette(
      [{ name: 'usage', description: 'cost' }, { name: 'undo', description: 'roll back' }],
      (command) => { ran = command.name; }
    );
    layer.key({ name: 'u', sequence: 'u' });
    layer.key({ name: 'n', sequence: 'n' });
    assert.equal(layer.key({ name: 'return' }), 'close');
    assert.equal(ran, 'undo');
  });

  test('it sizes to its contents instead of padding to a fixed box', () => {
    const small = commandPalette([{ name: 'a' }], () => {});
    const large = commandPalette(Array.from({ length: 30 }, (_, i) => ({ name: `c${i}` })), () => {});
    assert.ok(small.preferredHeight() < large.preferredHeight());
    assert.ok(small.rect({ x: 0, y: 0, width: 80, height: 40 }).height < 10);
  });
});


describe('the wordmark', () => {
  test('the block art is back', () => {
    const rows = wordmark(100, { unicode: true }).map(stripAnsi);
    assert.ok(rows.some((row) => row.includes('█')), 'the CAUSYNE block art must be shown');
    assert.ok(rows.some((row) => row.includes('Causyne AI Agent')));
  });

  test('a narrow terminal gets the name instead of mojibake', () => {
    const rows = wordmark(30, { unicode: true }).map(stripAnsi);
    assert.ok(!rows.some((row) => row.includes('█')), 'the art must not overflow a narrow terminal');
    assert.ok(rows.some((row) => row.includes('C A U S Y N E')));
  });

  test('a terminal without box drawing gets the name, not question marks', () => {
    const rows = wordmark(100, { unicode: false }).map(stripAnsi);
    assert.ok(!rows.some((row) => row.includes('█')));
    assert.ok(rows.some((row) => row.includes('C A U S Y N E')));
  });

  test('it carries no hardcoded escapes of its own', () => {
    // The old LOGO was a raw \x1b[1m\x1b[36m string, so it ignored NO_COLOR.
    for (const row of wordmark(100, { unicode: true })) {
      const escapes = row.match(/\x1b\[[0-9;]*m/g) || [];
      for (const escape of escapes) {
        assert.ok(!/\x1b\[36m|\x1b\[1;36m/.test(escape),
          'the wordmark must be painted through the theme, not with a hardcoded colour');
      }
    }
  });
});

describe('a picker you can actually operate', () => {
  // Two reported bugs, both in this widget, both independent.
  //
  //  1. Nothing could be selected. keys.js emits `name: 'enter'` for CR and LF
  //     (makeKey('enter', …)); handleKey listened for 'return', a name the
  //     decoder never produces. Enter fell through to the printable-character
  //     branch, was rejected there for being a control byte, and returned null.
  //     A dead key — in the skill picker AND in the ctrl+p command palette.
  //
  //  2. Scrolling down lost the selection marker, and pressing up brought it
  //     back. render() emits a category header whenever the group changes, so a
  //     window of N items does not occupy N rows — but ensureVisible() counted
  //     items. The selected item sat inside the item-counted window while the
  //     render loop ran out of ROWS on the headers before reaching it.

  const skillItems = () => listCompiledSkills().map((skill) => ({
    label: `${skill.domain}/${skill.id}`,
    description: skill.description,
    category: skill.domain,
    value: skill
  }));

  // The height a 22-row layer's body actually gets from panelRows():
  // min(preferredHeight, maxHeight) - 2, with drawLayer capping maxHeight at 20.
  const BODY = 18;

  /** Is the selection marker among the rows that were actually drawn? */
  function markerVisible(rows) {
    // Skip the filter row and its rule — the filter row also opens with the
    // arrow glyph, and matching it is a false positive that hides the bug.
    return rows.slice(2).some((row) => /^[▸>]\s/.test(stripAnsi(row)));
  }

  test('enter selects — the name the decoder actually emits', () => {
    let picked = null;
    const layer = skillPicker(listCompiledSkills(), (skill) => { picked = skill; });
    layer.body(74, BODY);

    const result = layer.key({ name: 'enter', sequence: '\r' });
    assert.ok(picked, 'enter must select; it was a dead key in the picker and the palette');
    assert.equal(result, 'close', 'selecting closes the picker');
  });

  test("'return' still selects, for a decoder that emits it", () => {
    let picked = null;
    const layer = skillPicker(listCompiledSkills(), (skill) => { picked = skill; });
    layer.body(74, BODY);
    layer.key({ name: 'return', sequence: '\r' });
    assert.ok(picked, 'the older key name must keep working');
  });

  test('the command palette can be operated too — same widget, same bug', () => {
    let ran = null;
    const layer = commandPalette(
      [{ name: 'skills', description: 'browse' }, { name: 'help', description: 'help' }],
      (command) => { ran = command; }
    );
    layer.body(60, 10);
    layer.key({ name: 'enter', sequence: '\r' });
    assert.ok(ran, 'ctrl+p was equally unable to run anything');
  });

  test('the marker survives every navigation pattern through 100 skills', () => {
    const patterns = {
      'down past every item': Array(150).fill({ name: 'down' }),
      'up, wrapping backwards': Array(150).fill({ name: 'up' }),
      'pagedown': Array(40).fill({ name: 'pagedown' }),
      'pageup': Array(40).fill({ name: 'pageup' }),
      'end then down': [{ name: 'end' }, ...Array(20).fill({ name: 'down' })],
      'home then up': [{ name: 'home' }, ...Array(20).fill({ name: 'up' })],
      'down then back up': [...Array(60).fill({ name: 'down' }), ...Array(60).fill({ name: 'up' })]
    };

    for (const [name, keys] of Object.entries(patterns)) {
      const list = new SelectList(skillItems());
      for (let step = 0; step < keys.length; step++) {
        const { rows } = list.render(74, BODY);
        assert.ok(markerVisible(rows),
          `${name}: the selection marker was not drawn at step ${step} `
          + `(selected=${list.selected}, offset=${list.offset}) — it scrolled out of the rendered window`);
        list.handleKey(keys[step], list.lastItemRows);
      }
    }
  });

  test('a filtered list scrolls correctly too', () => {
    const list = new SelectList(skillItems());
    for (const character of 'security') list.handleKey({ name: 'char', sequence: character }, 15);
    assert.ok(list.filtered.length > 1, 'the filter must leave something to scroll');
    for (let step = 0; step < 30; step++) {
      const { rows } = list.render(74, BODY);
      assert.ok(markerVisible(rows), `filtered list lost the marker at step ${step}`);
      list.handleKey({ name: 'down' }, list.lastItemRows);
    }
  });

  test('the position counter never overwrites the selected row', () => {
    // The counter is written with `rows[height - 1] = line`, which REPLACES
    // whatever is there. Letting the item loop fill that row meant it could
    // clobber the marker — a second, independent way to lose the selection.
    const list = new SelectList(skillItems());
    for (let step = 0; step < 40; step++) {
      const { rows } = list.render(74, BODY);
      assert.ok(rows.length <= BODY, `the body overflowed its ${BODY} rows`);
      assert.ok(markerVisible(rows), `the counter clobbered the marker at step ${step}`);
      list.handleKey({ name: 'down' }, list.lastItemRows);
    }
  });

  test('paging moves by one screenful, so no item can be skipped over', () => {
    // The layer derived its scroll distance from its CONFIGURED height (22 - 5
    // = 17) while the panel only ever gives the body enough room to draw 13-15
    // items. PageDown therefore advanced further than a screenful, and the items
    // in the gap could not be reached by paging at all.
    //
    // This does not lose the marker — render() re-runs ensureVisible and pulls
    // the offset back — so it is a navigation bug, not a drawing one.
    const layer = skillPicker(listCompiledSkills(), () => {});
    layer.body(74, BODY);

    const before = layer.list.selected;
    const drawn = layer.list.renderableCount(layer.list.offset, layer.list.lastItemRows);
    layer.key({ name: 'pagedown' });
    const advanced = layer.list.selected - before;

    assert.ok(advanced <= drawn,
      `pagedown advanced ${advanced} items while only ${drawn} were on screen — `
      + 'the items in between cannot be reached by paging');
  });

  test('the layer scrolls by the budget the renderer used, not its own guess', () => {
    const layer = skillPicker(listCompiledSkills(), () => {});
    layer.body(74, BODY);
    assert.ok(layer.list.lastItemRows > 0, 'the list must publish what it budgeted');
    assert.notEqual(layer.list.lastItemRows, layer.height - 5,
      'this test is only meaningful while the two figures genuinely differ');

    for (let step = 0; step < 60; step++) {
      layer.key({ name: 'down' });
      assert.ok(markerVisible(layer.body(74, BODY)),
        `the layer scrolled off its own rendered window at step ${step}`);
    }
  });

  test('renderableCount agrees with what render actually draws', () => {
    // The scroll math and the render loop must be the same function of the data,
    // or they will drift apart again the next time either is touched.
    const list = new SelectList(skillItems());
    for (const offset of [0, 7, 23, 61, 88]) {
      list.offset = offset;
      list.selected = offset;
      const { rows } = list.render(74, BODY);
      // Item rows and category headers are both two-space prefixed, so the
      // prefix cannot tell them apart. Every skill label is `domain/id`; a
      // header is the bare domain. The slash is the discriminator.
      const drawn = rows.slice(2).filter((row) => stripAnsi(row).includes('/')).length;
      const predicted = list.renderableCount(offset, list.lastItemRows);
      assert.ok(Math.abs(drawn - predicted) <= 1,
        `at offset ${offset} the scroll math predicted ${predicted} items and the renderer drew ${drawn}`);
    }
  });
});

describe('the skills behind the names are real', () => {
  // The question the picker bug made impossible to answer: is there anything
  // behind these entries, or only labels?
  test('every compiled skill carries a substantive body', () => {
    const skills = listCompiledSkills();
    assert.ok(skills.length >= 100, `expected the full library, found ${skills.length}`);
  });

  test('selecting a skill returns its content through the real command path', async () => {
    const { handleInput } = await import('../src/commands.js');
    const layer = skillPicker(listCompiledSkills(), () => {});
    layer.body(74, 18);

    let chosen = null;
    const picker = skillPicker(listCompiledSkills(), (skill) => { chosen = skill; });
    picker.body(74, 18);
    for (let i = 0; i < 12; i++) picker.key({ name: 'down' });
    picker.key({ name: 'enter', sequence: '\r' });
    assert.ok(chosen, 'the pick must reach the callback cliMode wires up');

    const result = await handleInput(`/skills ${chosen.domain}/${chosen.id}`, { surface: 'terminal' });
    assert.equal(result.ok, true);
    assert.equal(result.effect, 'invoke-skill', 'picking a skill must produce something runnable');

    const body = result.skill.content;
    assert.ok(body.length > 800,
      `${chosen.domain}/${chosen.id} returned ${body.length} characters — that is a stub, not a skill`);
    assert.match(body, /Done when:/, 'a skill body must carry checkable criteria');
    assert.match(body, /##\s+Verification/i, 'a skill body must close with verification');
  });
});
