// The home screen: a menu and a chat input sharing one frame.
//
// The whole design rests on one behaviour — the menu claims the arrow keys and
// hands every printable character back to the input line. Get that wrong in
// either direction and the screen becomes unusable: swallow the letters and you
// cannot type, leak the arrows and you cannot pick. Both are pinned here.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HomeLayer, InputLayer, SelectLayer } from '../src/tui/dialogs.js';
import { PRIMARY_ACTIONS, MORE_ACTIONS, homeStatusLine, PROVIDERS } from '../src/tui/home.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

const key = (name, extra = {}) => ({ name, ...extra });
const items = () => PRIMARY_ACTIONS.map((a) => ({ id: a.id, label: a.label, hint: a.hint, action: a }));

describe('HomeLayer key ownership', () => {
  test('arrows move the selection and wrap', () => {
    const layer = new HomeLayer({ items: items() });
    assert.equal(layer.current.id, PRIMARY_ACTIONS[0].id);

    assert.equal(layer.key(key('down')), 'handled');
    assert.equal(layer.current.id, PRIMARY_ACTIONS[1].id);

    // Wrapping matters: a menu that stops dead at the ends reads as broken.
    layer.index = 0;
    layer.key(key('up'));
    assert.equal(layer.current.id, PRIMARY_ACTIONS[PRIMARY_ACTIONS.length - 1].id);
  });

  test('a printable character dismisses the menu AND is handed back', () => {
    // 'dismiss' is what lets the first letter you type both close the menu and
    // land in the input. Returning 'close' here would swallow that character.
    const layer = new HomeLayer({ items: items() });
    assert.equal(layer.key(key('char', { text: 'h' })), 'dismiss');
    assert.equal(layer.key(key('paste', { text: 'hello' })), 'dismiss');
  });

  test('unclaimed control keys pass through with the menu still up', () => {
    const layer = new HomeLayer({ items: items() });
    for (const name of ['tab', 'backspace', 'left', 'right']) {
      assert.equal(layer.key(key(name)), 'passthrough', `${name} is not the menu's`);
    }
    assert.equal(layer.key(key('p', { ctrl: true })), 'passthrough', 'ctrl+p must still open the palette');
  });

  test('enter runs the selection, escape just closes', () => {
    let picked = null;
    const layer = new HomeLayer({ items: items(), onPick: (item) => { picked = item; } });
    assert.equal(layer.key(key('enter')), 'close');
    assert.equal(picked.id, PRIMARY_ACTIONS[0].id);

    picked = null;
    const other = new HomeLayer({ items: items(), onPick: (item) => { picked = item; } });
    assert.equal(other.key(key('escape')), 'close');
    assert.equal(picked, null, 'escape must not run anything');
  });

  test('rows fit the panel at any width', () => {
    const layer = new HomeLayer({ items: items() });
    for (const width of [20, 40, 66, 120, 220]) {
      for (const row of layer.body(width)) {
        assert.ok(stripAnsi(row).length <= width, `row overflowed a ${width}-column panel`);
      }
    }
  });
});

describe('the menu is wired to real commands', () => {
  test('every action declares a kind the dispatcher handles', () => {
    // runHomeAction() is a switch. An action carrying a kind it does not know
    // falls to `default`, which is 'takeover' — it would stop the prompt and
    // call action.run(), and an action without run() would throw into a dead
    // terminal. So the kinds must be a closed set, checked against the source.
    const source = fs.readFileSync(path.join(SRC, 'cliMode.js'), 'utf8');
    const dispatcher = source.slice(source.indexOf('async function runHomeAction'));
    const handled = new Set([...dispatcher.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]));

    for (const action of [...PRIMARY_ACTIONS, ...MORE_ACTIONS]) {
      assert.ok(action.kind, `${action.id} has no kind`);
      assert.ok(handled.has(action.kind), `runHomeAction has no case for kind '${action.kind}' (${action.id})`);
    }
  });

  test('an action either runs something or names a command', () => {
    for (const action of [...PRIMARY_ACTIONS, ...MORE_ACTIONS]) {
      const inert = ['chat', 'more', 'config', 'mcp'].includes(action.kind);
      assert.ok(
        inert || typeof action.run === 'function' || typeof action.command === 'string',
        `${action.id} would do nothing when selected`
      );
    }
  });

  test('the menu contains no held remote-control actions', () => {
    const ids = [...PRIMARY_ACTIONS, ...MORE_ACTIONS].map((a) => a.id);
    for (const held of ['start', 'stop', 'restart', 'pair', 'unpair']) {
      assert.ok(!ids.includes(held), `${held} must stay out of the local menu`);
    }
  });
});

describe('the status row', () => {
  test('reports local model status without throwing on empty input', () => {
    const line = homeStatusLine({
      config: { provider: 'deepseek', model: 'deepseek-v4-pro', apiKey: 'k' }
    });
    assert.match(stripAnsi(line), /local/);
    assert.match(stripAnsi(line), /deepseek\/deepseek-v4-pro/);

    assert.doesNotThrow(() => homeStatusLine());
    assert.match(stripAnsi(homeStatusLine()), /local/);
  });

  test('a missing API key is a warning, not a blocker', () => {
    const line = stripAnsi(homeStatusLine({ config: { provider: 'gemini', model: 'g' } }));
    assert.match(line, /no key/);
  });
});

describe('InputLayer — the primitive the dialogs were missing', () => {
  test('types, edits and submits', () => {
    let got = null;
    const layer = new InputLayer({ onSubmit: (v) => { got = v; } });
    for (const ch of 'gpt-4o') layer.key(key('char', { text: ch }));
    layer.key(key('backspace'));
    layer.key(key('enter'));
    assert.equal(got, 'gpt-4');
  });

  test('masking hides the value on screen but not from the buffer', () => {
    const layer = new InputLayer({ mask: true, onSubmit: () => {} });
    for (const ch of 'sk-secret') layer.key(key('char', { text: ch }));
    const rendered = layer.body(60).join('\n');
    assert.ok(!rendered.includes('sk-secret'), 'the key must never be drawn');
    assert.equal(layer.editor.getText(), 'sk-secret', 'the buffer keeps the real value');
  });

  test('dismissal answers cancel, so a caller can never hang', () => {
    let cancelled = false;
    const layer = new InputLayer({ onCancel: () => { cancelled = true; } });
    layer.answer();
    assert.equal(cancelled, true);
  });

  test('it stays modal for keys it does not use', () => {
    const layer = new InputLayer({});
    assert.equal(layer.key(key('f5')), 'handled', 'a stray key must not reach the input line behind it');
  });
});

describe('there is one provider list', () => {
  test('the standalone wizard and the in-chat flow read the same constant', () => {
    // These were two hand-maintained lists — an inquirer `choices` array in
    // cliMode.js and PROVIDERS here — which is how a provider ends up offered on
    // one surface and missing on the other. The wizard now imports PROVIDERS,
    // so the drift is structurally impossible; this pins that it still does.
    const wizard = fs.readFileSync(path.join(SRC, 'cliMode.js'), 'utf8');
    assert.match(wizard, /PROVIDERS/, 'interactiveConfig must read the shared list');
    assert.ok(!/type:\s*'list'/.test(wizard),
      'a second hardcoded provider list must not reappear');
  });

  test('every provider resolves to a real adapter', async () => {
    // A provider offered in the picker that cannot be built is a dead menu
    // entry: the user selects it, saves a key, and the first turn fails with an
    // error about credentials.
    //
    // This used to grep agentLoop.js for the provider id. The switch now lives
    // in providers/factory.js (the daemon needs it too, to answer the phone's
    // audio-capability question), so the check actually constructs each adapter
    // instead of matching a string — which is what the test meant all along.
    const { createProvider } = await import('../src/providers/factory.js');
    for (const provider of PROVIDERS) {
      const built = createProvider({ provider: provider.id, model: provider.model, apiKey: 'test' });
      assert.ok(built, `no adapter for provider '${provider.id}'`);
      assert.equal(typeof built.chat, 'function', `${provider.id} adapter cannot chat()`);
    }
  });

  test('each entry carries what both surfaces render', () => {
    for (const provider of PROVIDERS) {
      assert.ok(provider.id && provider.label, 'id and label are required');
      assert.equal(typeof provider.model, 'string', `${provider.id} needs a suggested model`);
    }
    const ids = PROVIDERS.map((p) => p.id);
    assert.equal(ids.length, new Set(ids).size, 'no provider may be listed twice');
  });
});

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;[^\x07\x1b]*(\x07|\x1b\\)/g, '');
}
