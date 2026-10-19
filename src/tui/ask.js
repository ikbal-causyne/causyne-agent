// One question, asked properly, outside the chat surface.
//
// `causyne config` and `causyne pair` run with no chat session behind them, so
// there is no live region for a dialog to draw into. That is why they were the
// last two surfaces still on inquirer — and inquirer is a different design
// system: its own colours, its own glyphs, no NO_COLOR handling, and a list
// widget that looks nothing like the picker the same user sees inside `causyne`.
//
// The fix is NOT a second app shell. That was tried once: screen.js, layout.js,
// transcript.js and appShell.js existed, took over the terminal, and were
// deleted under UX-01 when it turned out there is no way to detect a terminal
// that ignores the alternate buffer. Rebuilding a host would walk straight back
// into that.
//
// Instead this borrows the host that already works. ChatPrompt owns raw mode,
// key decoding, the bounded live region and the layer stack, and `attach()` —
// the part that wires it to a chat renderer — is optional. So a standalone
// question is just a ChatPrompt started for the lifetime of one dialog and
// stopped again: same keys, same panel, same width clamping, same normal-buffer
// discipline, no second implementation to drift.
//
// Every helper degrades. If stdin is not a terminal, or raw mode cannot be
// taken, they fall back to a plain readline question — a better editor must
// never be the reason a command refuses to run.

import readline from 'readline';
import { ChatPrompt, isInteractive } from './prompt.js';
import { SelectLayer, InputLayer, ConfirmLayer } from './dialogs.js';

/**
 * Run one layer on a temporary prompt host.
 *
 * `build(resolve)` returns the Layer to show and calls `resolve` with the
 * answer. The host is torn down before this settles, so whatever the caller
 * prints next lands in a clean terminal.
 */
function hostOneLayer(build) {
  return new Promise((resolve) => {
    let prompt;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { if (prompt) prompt.stop(); } catch (e) { /* already stopped */ }
      // Let the terminal settle before the caller writes over the same rows.
      setImmediate(() => resolve(value));
    };

    try {
      prompt = new ChatPrompt({
        commands: [],
        // ctrl+c during a question is a cancel, not an exit: the caller decides
        // what "no answer" means for it. An exit here would kill the process
        // mid-configuration and leave a half-written config.json.
        onInterrupt: () => finish(null),
        onExit: () => finish(null)
      });
      prompt.start();
    } catch (e) {
      resolve(undefined); // signals "no TTY host" — caller falls back
      return;
    }

    prompt.openLayer(build(finish));
  });
}

/** True when a panel-based question can be asked at all. */
export function canAskInPanel() {
  return isInteractive();
}

/** Plain readline, for pipes, CI and any terminal that refuses raw mode. */
function fallbackQuestion(question, { mask = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} `, (answer) => { rl.close(); resolve(answer); });
    if (mask) {
      // Suppress the echo of what is typed. `_writeToOutput` is readline's own
      // hook for exactly this; the prompt itself still has to be drawn or the
      // user sees nothing at all.
      rl._writeToOutput = function (text) {
        if (text.includes(question)) rl.output.write(text);
      };
    }
  });
}

/**
 * Pick one of a list.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {Array}  options.items  `{ id, label, description }`
 * @returns {Promise<object|null>} the chosen item, or null if dismissed
 */
export async function askSelect({ title = '', items = [] } = {}) {
  if (items.length === 0) return null;

  if (canAskInPanel()) {
    const answer = await hostOneLayer((resolve) => new SelectLayer({
      title,
      items: items.map((item) => ({ ...item, value: item })),
      onPick: (picked) => resolve(picked ? picked.value : null)
    }));
    if (answer !== undefined) return answer;
  }

  // Numbered list is the honest fallback: it needs no cursor control at all.
  console.log(`\n${title}`);
  items.forEach((item, index) => {
    console.log(`  ${String(index + 1).padStart(2)}. ${item.label}${item.description ? `  — ${item.description}` : ''}`);
  });
  const raw = await fallbackQuestion(`Choose 1-${items.length}:`);
  const choice = Number(String(raw).trim());
  return Number.isInteger(choice) && choice >= 1 && choice <= items.length ? items[choice - 1] : null;
}

/**
 * Ask for a line of text.
 *
 * @returns {Promise<string|null>} the answer, or null if dismissed
 */
export async function askText({ title = '', lines = [], value = '', placeholder = '', mask = false, validate = null } = {}) {
  while (true) {
    let answer;

    if (canAskInPanel()) {
      answer = await hostOneLayer((resolve) => new InputLayer({
        title, lines, value, placeholder, mask,
        onSubmit: (text) => resolve(text),
        onCancel: () => resolve(null)
      }));
      if (answer === undefined) answer = await fallbackQuestion(`${title}:`, { mask });
    } else {
      if (lines.length) console.log('\n' + lines.join('\n'));
      answer = await fallbackQuestion(`${title}:`, { mask });
    }

    if (answer === null) return null;

    // Re-ask rather than accept something the caller has said is wrong. This is
    
    
    const problem = validate ? validate(answer) : null;
    if (!problem) return answer;
    console.log(`  ${problem}`);
    value = answer;
  }
}

/** A yes/no, defaulting to no on dismissal. */
export async function askConfirm(message) {
  if (canAskInPanel()) {
    const answer = await hostOneLayer((resolve) => new ConfirmLayer({
      message,
      onAnswer: (yes) => resolve(Boolean(yes))
    }));
    if (answer !== undefined) return Boolean(answer);
  }
  const raw = await fallbackQuestion(`${message} [y/N]`);
  return /^y(es)?$/i.test(String(raw).trim());
}
