import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

import { KeyDecoder, isChar } from '../src/tui/keys.js';
import { ApprovalLayer, ConfirmLayer } from '../src/tui/dialogs.js';
import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { Sandbox } from '../src/sandbox.js';

/**
 * Decode REAL terminal bytes rather than hand-writing an event object.
 *
 * This is the whole point of the file. The shipped bug was a mismatch between
 * what the decoder produces and what the dialog expected, and every test that
 * constructed `{name:'y'}` by hand agreed with the dialog and missed it. A test
 * that invents its own input cannot catch an input bug.
 */
const press = (bytes) => new KeyDecoder().decode(Buffer.from(bytes, 'binary'))[0];

const REQUEST = { toolCallId: 't1', tool: 'sysRun', risk: 'dangerous', args: { command: 'which brew' } };

test('keys: a printable letter decodes to name "char", not to its own letter', () => {
  // The asymmetry that caused the bug, pinned so it cannot drift silently.
  assert.equal(press('y').name, 'char');
  assert.equal(press('y').text, 'y');
  // Modified letters DO carry the letter as a name — which is why
  // `key.ctrl && key.name === 'c'` was correct while `key.name === 'y'` was not.
  assert.equal(press('\x03').name, 'c');
  assert.equal(press('\x03').ctrl, true);
  assert.equal(press('\x1b').name, 'escape');
});

test('keys: isChar matches a bare letter and rejects every modified form', () => {
  assert.equal(isChar(press('y'), 'y'), true);
  assert.equal(isChar(press('n'), 'n'), true);
  assert.equal(isChar(press('n'), 'y'), false);
  assert.equal(isChar(press('\x19'), 'y'), false, 'ctrl+y must not count as y');
  assert.equal(isChar(press('\x1by'), 'y'), false, 'alt+y must not count as y');
  assert.equal(isChar(press('\x1b'), 'y'), false);
  assert.equal(isChar(null, 'y'), false);
});

test('approval dialog: y approves — the bug that made the modal unusable', () => {
  // SHIPPED BROKEN: ApprovalLayer tested `event.name === 'y'`, which is never
  // true for a bare y. Every keypress fell through to `default:` and was
  // swallowed, so the one modal gating every dangerous action could not be
  // approved at all. Escape still worked, which made it look responsive.
  let answer = null;
  const layer = new ApprovalLayer({ request: REQUEST, onAnswer: (v) => { answer = v; } });

  assert.equal(layer.key(press('y')), 'close');
  assert.equal(answer, true);
});

test('approval dialog: n denies and escape denies', () => {
  for (const bytes of ['n', '\x1b']) {
    let answer = null;
    const layer = new ApprovalLayer({ request: REQUEST, onAnswer: (v) => { answer = v; } });
    assert.equal(layer.key(press(bytes)), 'close');
    assert.equal(answer, false, `${JSON.stringify(bytes)} did not deny`);
  }
});

test('approval dialog: ctrl+y does NOT approve', () => {
  // A modifier combination must never be mistaken for consent.
  let answer = null;
  const layer = new ApprovalLayer({ request: REQUEST, onAnswer: (v) => { answer = v; } });
  layer.key(press('\x19'));
  assert.equal(answer, null, 'ctrl+y approved the action');
});

test('approval dialog: the highlight starts on Reject', () => {
  // opencode starts on its approving option, which suits a coding session where
  // the worst case is an unwanted file edit. This gate also stands in front of
  // arbitrary shell and full mouse/keyboard control, and enter is the key people
  // press without reading — so it must not be the one that says yes.
  const layer = new ApprovalLayer({ request: REQUEST });
  assert.equal(layer.options[layer.selected].id, 'reject');
});

test('approval dialog: enter alone commits the safe default', () => {
  let answer = null;
  const layer = new ApprovalLayer({ request: REQUEST, onAnswer: (v) => { answer = v; } });
  assert.equal(layer.key(press('\r')), 'close');
  assert.equal(answer, false, 'a reflex enter approved the action');
});

test('approval dialog: ←/→ move the highlight and enter commits it', () => {
  // The interaction the owner asked for, modelled on opencode's permission
  // prompt: choose with the arrows, confirm with enter.
  for (const arrow of ['\x1b[C', '\x1b[D']) {
    let answer = null;
    const layer = new ApprovalLayer({ request: REQUEST, onAnswer: (v) => { answer = v; } });
    assert.equal(layer.key(press(arrow)), 'handled', 'the arrow closed the dialog instead of moving');
    layer.key(press('\r'));
    assert.equal(answer, true, `${JSON.stringify(arrow)} then enter did not approve`);
  }
});

test('approval dialog: the highlight wraps all the way round', () => {
  let answer = null;
  const layer = new ApprovalLayer({ request: REQUEST, onAnswer: (v) => { answer = v; } });
  // One move per option returns to where it started, whatever the count.
  for (let i = 0; i < layer.options.length; i++) layer.key(press('\x1b[C'));
  layer.key(press('\r'));
  assert.equal(answer, false, 'the selection did not wrap back to Reject');
});

test('approval dialog: h and l move the highlight, as opencode binds them', () => {
  let answer = null;
  const layer = new ApprovalLayer({ request: REQUEST, onAnswer: (v) => { answer = v; } });
  layer.key(press('l'));
  layer.key(press('\r'));
  assert.equal(answer, true);
});

test('approval dialog: the option chips are always drawn, whatever the height', () => {
  // They are reserved rows, not the tail of a list that a long diff can push
  // off the panel — a chooser you cannot see is not a chooser.
  const layer = new ApprovalLayer({ request: REQUEST });
  for (const height of [6, 12, 22]) {
    const rows = layer.body(70, height);
    assert.match(rows[rows.length - 1], /Allow once/, `no option row at height ${height}`);
    assert.match(rows[rows.length - 1], /Reject/, `no option row at height ${height}`);
  }
});

test('confirm dialog: y and n work there too', () => {
  for (const [bytes, expected] of [['y', true], ['n', false], ['\x1b', false]]) {
    let answer = null;
    const layer = new ConfirmLayer({ message: 'Sure?', onAnswer: (v) => { answer = v; } });
    layer.key(press(bytes));
    assert.equal(answer, expected, `${JSON.stringify(bytes)} gave ${answer}`);
  }
});

test('transcript: the request is not printed twice when a dialog will ask', () => {
  // It shipped printing the full risk badge, command and diff into the
  // scrollback AND again inside the modal.
  const lines = [];
  const renderer = new ChatRenderer();
  renderer.write = (text = '') => lines.push(text);
  renderer.frame = (_key, fn) => fn();
  renderer.dialogWillAsk = true;

  renderer.onApprovalRequest(REQUEST);

  assert.equal(lines.length, 0, 'the request was printed even though a dialog will show it');
  assert.ok(renderer.pendingApprovals.has('t1'), 'the detail the dialog needs was dropped');
});

test('transcript: without a dialog the full request still prints', () => {
  // A piped or non-TTY session has no modal, so the scrollback is the only
  // place the request is ever shown. Suppressing it there would ask for
  // consent to something invisible.
  const lines = [];
  const renderer = new ChatRenderer();
  renderer.write = (text = '') => lines.push(text);
  renderer.frame = (_key, fn) => fn();

  renderer.onApprovalRequest(REQUEST);
  assert.ok(lines.length > 0, 'the non-interactive path stopped showing the request');
});

test('transcript: the decision is recorded after the answer', () => {
  const lines = [];
  const renderer = new ChatRenderer();
  renderer.write = (text = '') => lines.push(text);
  renderer.frame = (_key, fn) => fn();

  renderer.renderApprovalDecision(REQUEST, true, 'once');
  assert.match(lines.join('\n'), /allowed once/);

  lines.length = 0;
  renderer.renderApprovalDecision(REQUEST, true, 'always');
  assert.match(lines.join('\n'), /allowed always/, 'a standing grant must be visible in the transcript');

  lines.length = 0;
  renderer.renderApprovalDecision(REQUEST, false, 'reject');
  assert.match(lines.join('\n'), /rejected/);
});

test('risk: a read-only subcommand of a dangerous tool is not dangerous', () => {
  // `brew` is dangerous because `brew install` runs arbitrary scripts. Asking
  // it its version is not, and a gate that cries wolf on `--version` is one
  // people learn to approve without reading.
  const sandbox = new Sandbox({ autonomyMode: 'B' });
  const risk = (command) => sandbox.validate('sysRun', { command }).risk;

  for (const command of ['brew --version', 'brew list', 'apt list', 'systemctl status nginx', 'crontab -l', 'kill -0 123']) {
    assert.notEqual(risk(command), 'dangerous', `${command} should not require approval`);
  }
});

test('risk: the mutating forms stay dangerous, and sudo is never carved out', () => {
  const sandbox = new Sandbox({ autonomyMode: 'B' });
  const risk = (command) => sandbox.validate('sysRun', { command }).risk;

  for (const command of [
    'brew install ffmpeg', 'brew uninstall thing', 'apt install curl',
    'systemctl stop nginx', 'crontab -r', 'kill -9 123', 'chmod 777 /etc'
  ]) {
    assert.equal(risk(command), 'dangerous', `${command} stopped requiring approval`);
  }

  // Privilege escalation is dangerous whatever follows it.
  assert.equal(risk('sudo brew --version'), 'dangerous', 'sudo was carved out');
});

test('risk: the reported command from the live session no longer alarms', () => {
  // Verbatim from the user's terminal. Its worst part is `mkdir -p` inside the
  // allowed workspace, and it was classified DANGEROUS because one segment
  // began with "brew ".
  const sandbox = new Sandbox({ autonomyMode: 'B' });
  const command = 'which brew && brew --version 2>&1 | head -5; ls ~/Causyne 2>&1 | head -5; mkdir -p ~/Causyne/blender_pen && echo OK_DIR';

  assert.notEqual(sandbox.validate('sysRun', { command }).risk, 'dangerous');
});

test('ctrl+c with a modal open denies it instead of orphaning the promise', async () => {
  // SHIPPED BROKEN: ctrl+c was checked before the layer, so with an approval up
  // it interrupted the turn while the modal stayed on screen and its promise
  // was never resolved. The loop then waited forever for an answer that could
  // no longer be given — which is why ctrl+c appeared to do nothing.
  const { ChatPrompt } = await import('../src/tui/prompt.js');

  const prompt = Object.create(ChatPrompt.prototype);
  prompt.layer = null;
  prompt.busy = true;
  prompt.editor = { isEmpty: true, clear() {} };
  prompt.draw = () => {};
  let interrupted = false;
  prompt.interrupt = () => { interrupted = true; };

  let answer = null;
  prompt.layer = new ApprovalLayer({ request: REQUEST, onAnswer: (v) => { answer = v; } });

  prompt.handleKey(press('\x03'));

  assert.equal(answer, false, 'the pending approval was left unresolved — the loop would hang');
  assert.equal(prompt.layer, null, 'the modal stayed on screen');
  assert.equal(interrupted, false, 'ctrl+c interrupted the turn instead of closing the dialog');
});

test('wording: the risk level is NEVER shown to the user', () => {
  // "DANGEROUS" printed at somebody installing a package does not make them
  // careful — it makes them numb, and a gate people are numb to is not a gate.
  // opencode shows a warning triangle and the tool name, and that is the whole
  // signal: being asked at all IS the warning. The tier survives only as colour
  // and in the audit trail.
  for (const risk of ['dangerous', 'extreme', 'moderate']) {
    const layer = new ApprovalLayer({ request: { ...REQUEST, risk }, verb: 'run' });
    const shown = [layer.title, layer.footer, ...layer.body(70, 12)].join('\n');

    assert.ok(!/DANGEROUS/i.test(shown), `the modal printed "dangerous" for risk=${risk}`);
    assert.ok(!/EXTREME/i.test(shown), `the modal printed "extreme" for risk=${risk}`);
  }
});

test('wording: the modal uses opencode vocabulary', () => {
  const layer = new ApprovalLayer({ request: REQUEST, verb: 'run' });
  assert.equal(layer.title, 'permission required');
  assert.deepEqual(layer.options.map((o) => o.label), ['Allow once', 'Allow always', 'Reject']);
});

test('wording: the transcript block carries no risk word either', () => {
  const lines = [];
  const renderer = new ChatRenderer();
  renderer.write = (text = '') => lines.push(text);
  renderer.frame = (_key, fn) => fn();

  renderer.onApprovalRequest({ ...REQUEST, risk: 'extreme' });
  const shown = lines.join('\n');

  assert.ok(!/EXTREME/i.test(shown), 'the non-interactive path still shouts the risk level');
  assert.match(shown, /permission required/);
});

// ---------------------------------------------------------------------------
// "Allow always" — standing approvals
// ---------------------------------------------------------------------------

test('always: the modal offers three options with Reject still the default', () => {
  const layer = new ApprovalLayer({ request: REQUEST });
  assert.deepEqual(layer.options.map((o) => o.label), ['Allow once', 'Allow always', 'Reject']);
  assert.equal(layer.options[layer.selected].id, 'reject');
});

test('always: the dialog reports WHICH option was chosen, not just yes/no', () => {
  // A bare boolean would silently downgrade "always" to "once" and the standing
  // grant would never be recorded.
  const cases = [
    [['\r'], { approved: false, scope: 'reject' }],
    [['\x1b[C', '\r'], { approved: true, scope: 'once' }],
    [['\x1b[C', '\x1b[C', '\r'], { approved: true, scope: 'always' }],
    [['y'], { approved: true, scope: 'once' }],
    [['a'], { approved: true, scope: 'always' }],
    [['n'], { approved: false, scope: 'reject' }]
  ];

  for (const [keys, expected] of cases) {
    let got = null;
    const layer = new ApprovalLayer({
      request: REQUEST,
      onAnswer: (approved, scope) => { got = { approved, scope }; }
    });
    for (const bytes of keys) layer.key(press(bytes));
    assert.deepEqual(got, expected, `${JSON.stringify(keys)} produced ${JSON.stringify(got)}`);
  }
});

test('always: a torn-down dialog still rejects, and never grants', () => {
  // closeLayer() calls answer() with no arguments when a modal is dismissed
  // from outside. The defaults must read as a rejection.
  let got = null;
  const layer = new ApprovalLayer({
    request: REQUEST,
    onAnswer: (approved, scope) => { got = { approved, scope }; }
  });
  layer.answer();
  assert.deepEqual(got, { approved: false, scope: 'reject' });
});

test('always: a grant lifts the gate, and is revocable', async () => {
  const grants = await import('../src/approvalGrants.js');
  grants.revokeAllAlways();

  assert.equal(grants.isAlwaysAllowed('sysRun'), false);
  grants.grantAlways('sysRun');
  assert.equal(grants.isAlwaysAllowed('sysRun'), true);
  assert.deepEqual(grants.listAlwaysAllowed(), ['sysRun']);

  // Only the tool that was granted — a standing approval is not a blanket one.
  assert.equal(grants.isAlwaysAllowed('desktop_act'), false);

  assert.equal(grants.revokeAllAlways(), 1);
  assert.equal(grants.isAlwaysAllowed('sysRun'), false, 'a grant survived revocation');
});

test('always: grants are NEVER persisted to disk', async () => {
  // The whole safety model is that these die with the process. If they were
  // written to config, a permission granted in a hurry weeks ago would silently
  // apply to a session the user has forgotten configuring.
  const source = fs.readFileSync(path.join(HERE, '..', 'src', 'approvalGrants.js'), 'utf8');
  assert.ok(!/writeFileSync|saveConfig|JSON\.stringify/.test(source), 'standing approvals are being persisted');
});

test('always: the agent loop checks the grant BEFORE it asks', async () => {
  // Checked in agentLoop rather than inside the approval handler, so the phone
  // is never pinged at all. Asking and then auto-answering still interrupts the
  // user, which is the entire thing they were trying to stop.
  const loop = fs.readFileSync(path.join(HERE, '..', 'src', 'agentLoop.js'), 'utf8');
  const gate = loop.indexOf('const standingApproval = isAlwaysAllowed(functionName)');
  const ask = loop.indexOf("type: 'approval_request'", gate);

  assert.ok(gate > 0, 'the standing-approval check is gone');
  assert.ok(ask > gate, 'the grant is checked after the request is already sent');
  assert.match(loop.slice(gate, ask), /!standingApproval &&/, 'the gate no longer honours the grant');
});

test('always: /approvals lists and clears them', async () => {
  const grants = await import('../src/approvalGrants.js');
  const { listCommands } = await import('../src/commands.js');
  const command = listCommands().find((entry) => entry.name === 'approvals');
  assert.ok(command, '/approvals is not registered — a grant with no way out is a trap');

  grants.revokeAllAlways();
  const empty = await command.run([]);
  assert.match(String(empty.output), /No standing approvals/);

  grants.grantAlways('sysRun');
  const listed = await command.run([]);
  assert.match(String(listed.output), /sysRun/);

  const cleared = await command.run(['clear']);
  assert.match(String(cleared.output), /Revoked 1/);
  assert.equal(grants.isAlwaysAllowed('sysRun'), false);
});
