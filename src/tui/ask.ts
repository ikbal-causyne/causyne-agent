// One question, asked properly, outside the chat surface.
//
// `causyne config` and `causyne pair` run with no chat session behind them, so
// there is no live region for a dialog to draw into.
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
import { SelectLayer, InputLayer, ConfirmLayer, DecisionLayer } from './dialogs.js';
import { safeDisplay } from './text.js';

export interface FallbackQuestionOptions {
  mask?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export interface AskSelectItem {
  id?: string;
  label?: string;
  description?: string;
  [key: string]: any;
}

export interface AskSelectOptions {
  title?: string;
  items?: AskSelectItem[];
}

export interface AskTextOptions {
  title?: string;
  lines?: string[];
  value?: string;
  placeholder?: string;
  mask?: boolean;
  validate?: ((value: string) => string | null | undefined) | null;
}

export interface AskDecisionRequest {
  id?: string;
  header?: string;
  question?: string;
  reason?: string;
  allowCustom?: boolean;
  options?: AskSelectItem[];
  [key: string]: any;
}

/**
 * Run one layer on a temporary prompt host.
 *
 * `build(resolve)` returns the Layer to show and calls `resolve` with the
 * answer. The host is torn down before this settles, so whatever the caller
 * prints next lands in a clean terminal.
 */
function hostOneLayer<T>(build: (resolve: (value: T | null) => void) => unknown): Promise<T | null | undefined> {
  return new Promise((resolve) => {
    let prompt: ChatPrompt | undefined;
    let settled = false;

    const finish = (value: T | null): void => {
      if (settled) return;
      settled = true;
      try { if (prompt) prompt.stop(); } catch { /* already stopped */ }
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
    } catch {
      resolve(undefined); // signals "no TTY host" — caller falls back
      return;
    }

    prompt.openLayer(build(finish));
  });
}

/** True when a panel-based question can be asked at all. */
export function canAskInPanel(): boolean {
  return isInteractive();
}

/** Plain readline, for pipes, CI and any terminal that refuses raw mode. */
export function fallbackQuestion(
  question: string,
  { mask = false, input = process.stdin, output = process.stdout }: FallbackQuestionOptions = {}
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const rl = readline.createInterface({ input, output }) as readline.Interface & {
      _writeToOutput?: (text: string) => void;
      output?: NodeJS.WritableStream;
    };
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    rl.once('close', () => done(null));
    const safeQuestion = safeDisplay(String(question ?? ''));
    rl.question(`${safeQuestion} `, (answer) => {
      rl.close();
      done(answer);
    });
    if (mask) {
      // Suppress the echo of what is typed. `_writeToOutput` is readline's own
      // hook for exactly this; the prompt itself still has to be drawn or the
      // user sees nothing at all.
      rl._writeToOutput = function (text: string): void {
        if (text.includes(safeQuestion) && rl.output) rl.output.write(text);
      };
    }
  });
}

/**
 * Pick one of a list.
 */
export async function askSelect(options: AskSelectOptions = {}): Promise<AskSelectItem | null> {
  const { title = '', items = [] } = options && typeof options === 'object' ? options : {};
  if (!Array.isArray(items) || items.length === 0) return null;

  if (canAskInPanel()) {
    const answer = await hostOneLayer<AskSelectItem>((resolve) => new SelectLayer({
      title,
      items: items.map((item) => ({ ...item, value: item })),
      onPick: (picked) => resolve(picked ? picked.value : null)
    }));
    if (answer !== undefined) return answer;
  }

  // Numbered list is the honest fallback: it needs no cursor control at all.
  console.log(`\n${safeDisplay(title)}`);
  items.forEach((item, index) => {
    const label = safeDisplay(item?.label || '');
    const desc = item?.description ? safeDisplay(item.description) : '';
    console.log(`  ${String(index + 1).padStart(2)}. ${label}${desc ? `  — ${desc}` : ''}`);
  });
  const raw = await fallbackQuestion(`Choose 1-${items.length}:`);
  if (raw === null) return null;
  const choice = Number(String(raw).trim());
  return Number.isInteger(choice) && choice >= 1 && choice <= items.length ? (items[choice - 1] ?? null) : null;
}

/**
 * Ask for a line of text.
 */
export async function askText(options: AskTextOptions = {}): Promise<string | null> {
  let { title = '', lines = [], value = '', placeholder = '', mask = false, validate = null } =
    options && typeof options === 'object' ? options : {};
  lines = Array.isArray(lines) ? lines : [];
  while (true) {
    let answer: string | null | undefined;

    if (canAskInPanel()) {
      answer = await hostOneLayer<string>((resolve) => new InputLayer({
        title, lines, value, placeholder, mask,
        onSubmit: (text) => resolve(text),
        onCancel: () => resolve(null)
      }));
      if (answer === undefined) answer = await fallbackQuestion(`${title}:`, { mask });
    } else {
      if (lines.length) console.log('\n' + lines.map(l => safeDisplay(String(l ?? ''))).join('\n'));
      answer = await fallbackQuestion(`${title}:`, { mask });
    }

    if (answer === null) return null;

    const problem = validate ? validate(answer) : null;
    if (!problem) return answer;
    console.log(`  ${safeDisplay(String(problem))}`);
    value = answer;
  }
}

/** A yes/no, defaulting to no on dismissal. */
export async function askConfirm(message: string): Promise<boolean> {
  if (canAskInPanel()) {
    const answer = await hostOneLayer<boolean>((resolve) => new ConfirmLayer({
      message,
      onAnswer: (yes) => resolve(Boolean(yes))
    }));
    if (answer !== undefined) return Boolean(answer);
  }
  const raw = await fallbackQuestion(`${message} [y/N]`);
  if (raw === null) return false;
  return /^y(es)?$/i.test(String(raw).trim());
}

/**
 * Ask for a durable product or architecture choice.
 *
 * This remains separate from permissions: choosing an implementation direction
 * never grants a tool the right to mutate files or execute a command.
 */
export async function askDecision(request: AskDecisionRequest = {}): Promise<{
  requestId: string | undefined;
  optionId: string | null | undefined;
  label: string;
  custom: boolean;
} | null> {
  const safeRequest = request && typeof request === 'object' ? request : {};
  const options = Array.isArray(safeRequest.options) ? safeRequest.options : [];
  if (options.length === 0 && safeRequest.allowCustom === false) return null;

  if (canAskInPanel()) {
    const answer = await hostOneLayer<any>((resolve) => new DecisionLayer({
      request: safeRequest,
      onAnswer: resolve
    }));
    if (answer !== undefined) return answer;
  }

  const custom: AskSelectItem = { id: '__custom__', label: 'Type your own answer', description: '' };
  const items = safeRequest.allowCustom === false ? options : [...options, custom];
  if (items.length === 0 || (options.length === 0 && !safeRequest.id && !safeRequest.question)) return null;
  const selected = await askSelect({
    title: safeRequest.header || 'Decision required',
    items
  });
  if (!selected) return null;
  if (selected.id === custom.id) {
    const label = await askText({
      title: safeRequest.question || 'Describe the direction you want',
      lines: safeRequest.reason ? [safeRequest.reason] : [],
      validate: (value) => String(value).trim() ? null : 'An answer is required.'
    });
    if (!label) return null;
    return { requestId: safeRequest.id, optionId: null, label: String(label).trim(), custom: true };
  }
  return {
    requestId: safeRequest.id,
    optionId: selected.id,
    label: String(selected.label || ''),
    custom: false
  };
}
