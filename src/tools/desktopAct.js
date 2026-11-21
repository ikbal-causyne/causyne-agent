import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolveChannel } from '../appChannel.js';
import { auditLog } from '../auditLog.js';
import { recordActuation } from '../embodimentSession.js';
import { sanitizeSubprocessEnv } from './subprocessEnv.js';
import { getErrorMessage, sanitizeToolText } from './toolPathSafety.js';
const MAX_ACT_OUTPUT_CHARS = 64 * 1024;
const MAC_ACT_SCRIPT = readFileSync(new URL('../tool-scripts/desktop_act.applescript', import.meta.url), 'utf8');
const MAC_INTERPRETER = 'osascript';
const MAX_ACTIONS = 12;
const ACTION_TIMEOUT_MS = 30000;
const VERBS = ['press', 'clickxy', 'type', 'key', 'wait'];
function runWithScriptOnStdin(binary, args, scriptText, timeoutMs) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(binary, args, { env: sanitizeSubprocessEnv(process.env), windowsHide: true });
        }
        catch (e) {
            resolve({ code: -1, stdout: '', stderr: getErrorMessage(e) });
            return;
        }
        let stdout = '';
        let stderr = '';
        let settled = false;
        const done = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => {
            try {
                child.kill('SIGTERM');
            }
            catch { /* already gone */ }
            setTimeout(() => { try {
                child.kill('SIGKILL');
            }
            catch { /* already gone */ } }, 1000).unref();
            done({ code: -1, stdout, stderr: stderr + '\ntimed out' });
        }, timeoutMs);
        child.stdout.on('data', (d) => {
            if (stdout.length < MAX_ACT_OUTPUT_CHARS)
                stdout += d.toString('utf8').slice(0, MAX_ACT_OUTPUT_CHARS - stdout.length);
        });
        child.stderr.on('data', (d) => {
            if (stderr.length < MAX_ACT_OUTPUT_CHARS)
                stderr += d.toString('utf8').slice(0, MAX_ACT_OUTPUT_CHARS - stderr.length);
        });
        child.on('error', (e) => { done({ code: -1, stdout, stderr: e.message }); });
        child.on('close', (code) => { done({ code: code ?? -1, stdout, stderr }); });
        child.stdin.on('error', () => { });
        child.stdin.write(scriptText);
        child.stdin.end();
    });
}
function encodeAction(action, index) {
    if (!action || typeof action !== 'object') {
        return { ok: false, error: `action ${index} is not an object` };
    }
    const act = action;
    const verb = String(act.verb || '').toLowerCase();
    if (!VERBS.includes(verb)) {
        return { ok: false, error: `action ${index}: unknown verb "${verb}". Valid: ${VERBS.join(', ')}` };
    }
    const clean = (value) => {
        let out = String(value ?? '');
        while (out.includes('::')) {
            out = out.split('::').join(':');
        }
        return out;
    };
    if (verb === 'clickxy') {
        const x = Number(act.x);
        const y = Number(act.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return { ok: false, error: `action ${index}: clickxy needs numeric x and y` };
        }
        return { ok: true, argv: `clickxy::${Math.round(x)}::${Math.round(y)}` };
    }
    if (verb === 'key') {
        if ((Array.isArray(act.modifiers) && act.modifiers.length > 0) || act.chord) {
            return { ok: false, error: `action ${index}: modifier key chords are not supported by this actuator; do not send an unmodified keystroke` };
        }
        const code = Number(act.keyCode);
        if (!Number.isInteger(code) || code < 0 || code > 127) {
            return { ok: false, error: `action ${index}: key requires a valid macOS virtual key code (0-127)` };
        }
    }
    const value = verb === 'press' ? act.target
        : verb === 'type' ? act.text
            : verb === 'key' ? act.keyCode
                : act.seconds;
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
        const app = typeof args?.app === 'string' ? args.app.trim() : '';
        const actions = Array.isArray(args?.actions) ? args.actions : [];
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
        const argv = [];
        for (let i = 0; i < actions.length; i++) {
            const encoded = encodeAction(actions[i], i);
            if (!encoded.ok)
                return { success: false, error: encoded.error };
            argv.push(encoded.argv);
        }
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
        auditLog.log({
            event: 'desktop_act',
            app: app || '(frontmost)',
            actions: actions.map((a) => a?.verb),
            coordinateActions: actions.filter((a) => String(a?.verb || '').toLowerCase() === 'clickxy').length
        });
        recordActuation(context?.parentLoop?.taskId, app, actions.map((a) => a?.verb));
        const result = await runWithScriptOnStdin(MAC_INTERPRETER, ['-', app, ...argv], MAC_ACT_SCRIPT, ACTION_TIMEOUT_MS);
        if (/-1743|not authorized|assistive access/i.test(result.stderr || '')) {
            return {
                success: false,
                requiresConsent: true,
                error: 'macOS has not granted Accessibility permission to the terminal running Causyne. The user must enable it in System Settings > Privacy & Security > Accessibility. '
                    + 'Ask them to do that; do not retry until they confirm.'
            };
        }
        if (result.code !== 0) {
            return { success: false, error: `Desktop action failed: ${(result.stderr || '').trim() || 'unknown error'}` };
        }
        const report = String(result.stdout || '').trim();
        const missed = (report.match(/^miss\|/gm) || []).length;
        return {
            success: missed === 0,
            ...(missed > 0 ? { error: `${missed} element(s) not found; remaining actions were not executed.` } : {}),
            output: (report || 'No output.')
                + (missed > 0
                    ? `\n\n${missed} element(s) were not found by name. Run ax_snapshot to see the current element names before retrying.`
                    : '')
        };
    }
};
