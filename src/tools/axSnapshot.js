import { readFileSync } from 'node:fs';
import { spawn } from 'child_process';
import { recordObservation } from '../embodimentSession.js';


const MAC_AX_SCRIPT = readFileSync(new URL('../tool-scripts/ax_snapshot.applescript', import.meta.url), 'utf8');

/**
 * PowerShell + UIAutomation, the Windows counterpart.
 *
 * NOT VERIFIED ON HARDWARE — this machine is macOS. The macOS path was tested
 * to its permission wall; this one is written from the documented
 * UIAutomationClient surface and is marked so nobody mistakes it for measured.
 */
const WINDOWS_AX_SCRIPT = readFileSync(new URL('../tool-scripts/ax_snapshot.ps1', import.meta.url), 'utf8');


const MAC_INTERPRETER = "osascript";
const WIN_INTERPRETER = "powershell";

const MAX_NODES_CEILING = 120;
const DEFAULT_MAX_NODES = 60;

/** macOS returns -1743 when Accessibility has not been granted. */
function isConsentRefusal(text) {
  return /-1743|not authorized|assistive access|accessibility/i.test(text || '');
}

/**
 * Run an interpreter with the script on STDIN. Never touches disk.
 *
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function runWithScriptOnStdin(binary, args, scriptText, timeoutMs = 15000) {
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
 * Collapse the interpreter's flat rows into the compact text the model reads.
 *
 * Deliberately NOT JSON: `AXButton|Export|` is a third the tokens of
 * `{"role":"AXButton","title":"Export","value":""}` and carries the same
 * information. Channel B only beats a screenshot on cost if it stays cheap.
 */
function formatRows(raw, maxNodes) {
  const rows = String(raw || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.includes('|'))
    .slice(0, maxNodes);

  if (rows.length === 0) return null;

  const lines = [];
  for (const row of rows) {
    const [role = '', title = '', value = ''] = row.split('|');
    const label = [title, value].filter(Boolean).join(' = ');
    lines.push(label ? `${role}: ${label}` : role);
  }
  return lines.join('\n');
}

export const axSnapshot = {
  schema: {
    name: 'ax_snapshot',
    description: 'Read the accessibility tree of an application window as structured text — every button, field, menu and label with its role, title and current value. Use this INSTEAD of a screenshot whenever you need to know what is on screen or verify that an action worked: it is roughly 5x cheaper than an image and gives you element names you can target precisely. Requires the user to have granted Accessibility permission to the terminal running Causyne.',
    parameters: {
      type: 'object',
      properties: {
        app: {
          type: 'string',
          description: 'Application process name, e.g. "Safari" or "Finder". Omit to read whichever application is frontmost.'
        },
        maxNodes: {
          type: 'integer',
          description: `Maximum elements to return. Defaults to ${DEFAULT_MAX_NODES}, hard cap ${MAX_NODES_CEILING}.`
        }
      }
    }
  },

  async execute(args = {}, context = {}) {
    const app = typeof args.app === 'string' ? args.app.trim() : '';
    const requested = Number.isInteger(args.maxNodes) ? args.maxNodes : DEFAULT_MAX_NODES;
    const maxNodes = Math.max(1, Math.min(requested, MAX_NODES_CEILING));

    try {
      if (process.platform === 'darwin') {
        const result = await runWithScriptOnStdin(MAC_INTERPRETER, ['-', app, String(maxNodes)], MAC_AX_SCRIPT);

        if (isConsentRefusal(result.stderr)) {
          return {
            success: false,
            requiresConsent: true,
            error: "macOS has not granted Accessibility permission to the terminal running Causyne. The user must enable it in System Settings > Privacy & Security > Accessibility, "
              + 'then this tool works immediately. Ask them to do that; do not retry until they confirm.'
          };
        }
        if (result.code !== 0) {
          return { success: false, error: `Could not read the accessibility tree: ${result.stderr.trim() || 'unknown error'}` };
        }

        const output = formatRows(result.stdout, maxNodes);
        if (!output) {
          return { success: true, output: `No labelled UI elements found${app ? ` in "${app}"` : ' in the frontmost application'}.` };
        }
        // C5: remember WHICH app was read and a hash of what it looked like, so
        // a resumed task can tell "the screen is as I left it" from "the screen
        // changed while I was gone". The tree itself is never stored — a record
        // of what the user's screen said would be a surveillance artefact.
        recordObservation(context?.parentLoop?.taskId, app, output);
        return { success: true, output };
      }

      if (process.platform === 'win32') {
        const result = await runWithScriptOnStdin(
          WIN_INTERPRETER,
          ['-NoProfile', '-NonInteractive', '-Command', '-', String(maxNodes)],
          WINDOWS_AX_SCRIPT
        );
        if (result.code !== 0) {
          return { success: false, error: `Could not read the accessibility tree: ${result.stderr.trim() || 'unknown error'}` };
        }
        const output = formatRows(result.stdout, maxNodes);
        return output
          ? { success: true, output }
          : { success: true, output: 'No labelled UI elements found.' };
      }

      // Linux AT-SPI runs over D-Bus and needs a binding this tool deliberately
      // does not carry. Saying so plainly beats returning an empty tree that
      // the model would read as "the window is empty".
      return {
        success: false,
        error: "Reading the accessibility tree is supported on macOS and Windows. On this platform, use screenshot({analyzeText:true}) for OCR bounding boxes instead."
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
