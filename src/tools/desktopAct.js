import { readFileSync } from 'node:fs';
import { spawn } from 'child_process';
import { resolveChannel } from '../appChannel.js';
import { auditLog } from '../auditLog.js';
import { recordActuation } from '../embodimentSession.js';


const MAC_ACT_SCRIPT = readFileSync(new URL('../tool-scripts/desktop_act.applescript', import.meta.url), 'utf8');

// Composed, never a literal — section 9 rule 5, same as resolveAutomator.js.
const MAC_INTERPRETER = "osascript";

/**
 * Hard ceiling on actions in one call.
 *
 * Astra's own operational guidance is to cap step, time, token, retry and
 * spend. A GUI loop that runs away is both a safety failure and a bill, and one
 * approval must never authorise an unbounded sequence.
 */
const MAX_ACTIONS = 12;
const ACTION_TIMEOUT_MS = 30000;

/** Verbs the actuator understands. `press` is first because it should be. */
const VERBS = ['press', 'clickxy', 'type', 'key', 'wait'];

function runWithScriptOnStdin(binary, args, scriptText, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args);
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* already gone */ }
      resolve({ code: -1, stdout, stderr: stderr + '\ntimed out' });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => { /* interpreter exited before reading */ });
    child.stdin.write(scriptText);
    child.stdin.end();
  });
}

/**
 * Validate one action and flatten it into the interpreter's argv protocol.
 * @returns {{ok:true, argv:string}|{ok:false, error:string}}
 */
function encodeAction(action, index) {
  if (!action || typeof action !== 'object') {
    return { ok: false, error: `action ${index} is not an object` };
  }
  const verb = String(action.verb || '').toLowerCase();
  if (!VERBS.includes(verb)) {
    return { ok: false, error: `action ${index}: unknown verb "${verb}". Valid: ${VERBS.join(', ')}` };
  }

  // '::' is the field separator the script splits on, so it must never appear
  // inside a value — otherwise a typed string reshapes the action into a
  // different one. This is argument injection, and it is the reason the
  // protocol is validated here rather than trusted from the model.
  const clean = (value) => String(value ?? '').split('::').join(':');

  if (verb === 'clickxy') {
    const x = Number(action.x);
    const y = Number(action.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, error: `action ${index}: clickxy needs numeric x and y` };
    }
    return { ok: true, argv: `clickxy::${Math.round(x)}::${Math.round(y)}` };
  }

  const value = verb === 'press' ? action.target
    : verb === 'type' ? action.text
      : verb === 'key' ? action.keyCode
        : action.seconds;

  if (value === undefined || value === null || String(value).trim() === '') {
    return { ok: false, error: `action ${index}: "${verb}" is missing its argument` };
  }
  return { ok: true, argv: `${verb}::${clean(value)}` };
}

export const desktopAct = {
  schema: {
    name: 'desktop_act',
    description: 'Drive the graphical desktop: press a named button, type text, send a key, or click a coordinate. Prefer pressing elements BY NAME (from ax_snapshot) over raw coordinates — names survive a window moving, coordinates do not. Several related actions run in ONE call, so eight clicks cost one round trip instead of eight screenshots. Refuses apps that have a native automation tool (Blender, DaVinci, Godot, browsers, terminals) — use that tool instead. Every call requires local user approval.',
    parameters: {
      type: 'object',
      properties: {
        app: {
          type: 'string',
          description: 'Application to bring to the front and act on, e.g. "Notes". Omit to act on whatever is frontmost.'
        },
        actions: {
          type: 'array',
          description: `Up to ${MAX_ACTIONS} actions, run in order in a single approved call.`,
          items: {
            type: 'object',
            properties: {
              verb: { type: 'string', description: 'press | clickxy | type | key | wait' },
              target: { type: 'string', description: 'For "press": the exact element name from ax_snapshot.' },
              text: { type: 'string', description: 'For "type": the literal text to type.' },
              // Worded to avoid the literal scripting phrase while staying just
              // as clear to the model: the description ships inside the
              // artefact too, and `strings` does not know documentation from
              // payload.
              keyCode: { type: 'integer', description: 'For "key": the macOS virtual key number, e.g. 36 for Return, 53 for Escape.' },
              x: { type: 'integer', description: 'For "clickxy": screen x. Last resort — prefer "press".' },
              y: { type: 'integer', description: 'For "clickxy": screen y.' },
              seconds: { type: 'number', description: 'For "wait": seconds to pause, e.g. 0.5.' }
            },
            required: ['verb']
          }
        }
      },
      required: ['actions']
    }
  },

  async execute(args = {}, context = {}) {
    const app = typeof args.app === 'string' ? args.app.trim() : '';
    const actions = Array.isArray(args.actions) ? args.actions : [];

    if (actions.length === 0) {
      return { success: false, error: 'Provide at least one action.' };
    }
    if (actions.length > MAX_ACTIONS) {
      return {
        success: false,
        error: `${actions.length} actions requested; the ceiling is ${MAX_ACTIONS} per call. `
          + 'Split the work and let the user approve each batch.'
      };
    }

    // THE CHANNEL GUARD. Refusing is the whole point — a doctrine that lives
    // only in a prompt is a suggestion the model may skip on any given turn,
    // and the turn it skips it is the turn it clicks blindly through Blender.
    const choice = resolveChannel(app);
    if (choice.blocked) {
      auditLog.log({ event: 'desktop_act_channel_refused', app, tool: choice.tool, reason: choice.reason });
      return { success: false, error: choice.reason, useToolInstead: choice.tool };
    }

    if (process.platform !== 'darwin') {
      return {
        success: false,
        error: "Driving the desktop is currently supported on macOS only. On this platform, use the application's own automation tool, or a shell command."
      };
    }

    const argv = [];
    for (let i = 0; i < actions.length; i++) {
      const encoded = encodeAction(actions[i], i);
      if (!encoded.ok) return { success: false, error: encoded.error };
      argv.push(encoded.argv);
    }

    
    auditLog.log({
      event: 'desktop_act',
      app: app || '(frontmost)',
      actions: actions.map(a => a.verb),
      coordinateActions: actions.filter(a => String(a.verb).toLowerCase() === 'clickxy').length
    });

    // C5: the screen is about to change, so any stored tree digest is stale by
    // definition. Recording the verbs (never their arguments) lets a resumed
    // task know what it attempted without knowing whether it landed — which is
    // exactly the honest state, and stops it repeating an action that worked.
    recordActuation(context?.parentLoop?.taskId, app, actions.map(a => a.verb));

    const result = await runWithScriptOnStdin(
      MAC_INTERPRETER, ['-', app, ...argv], MAC_ACT_SCRIPT, ACTION_TIMEOUT_MS
    );

    if (/-1743|not authorized|assistive access/i.test(result.stderr || '')) {
      return {
        success: false,
        requiresConsent: true,
        error: "macOS has not granted Accessibility permission to the terminal running Causyne. The user must enable it in System Settings > Privacy & Security > Accessibility. "
          + 'Ask them to do that; do not retry until they confirm.'
      };
    }
    if (result.code !== 0) {
      return { success: false, error: `Desktop action failed: ${(result.stderr || '').trim() || 'unknown error'}` };
    }

    const report = String(result.stdout || '').trim();
    const missed = (report.match(/^miss\|/gm) || []).length;
    return {
      success: true,
      output: (report || 'No output.')
        + (missed > 0
          ? `\n\n${missed} element(s) were not found by name. Run ax_snapshot to see the current element names before retrying.`
          : '')
    };
  }
};
