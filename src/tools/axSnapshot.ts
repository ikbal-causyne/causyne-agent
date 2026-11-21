import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { recordObservation } from '../embodimentSession.js';
import { sanitizeSubprocessEnv } from './subprocessEnv.js';
import { getErrorMessage, sanitizeToolError, sanitizeToolText, type ToolWorkspaceContext } from './toolPathSafety.js';

const MAX_AX_OUTPUT_CHARS = 128 * 1024;

const MAC_AX_SCRIPT = readFileSync(new URL('../tool-scripts/ax_snapshot.applescript', import.meta.url), 'utf8');
const WINDOWS_AX_SCRIPT = readFileSync(new URL('../tool-scripts/ax_snapshot.ps1', import.meta.url), 'utf8');

const MAC_INTERPRETER = 'osascript';
const WIN_INTERPRETER = 'powershell';

const MAX_NODES_CEILING = 120;
const DEFAULT_MAX_NODES = 60;

function isConsentRefusal(text: string): boolean {
  return /-1743|not authorized|assistive access|accessibility/i.test(text || '');
}

function runWithScriptOnStdin(
  binary: string,
  args: string[],
  scriptText: string,
  timeoutMs = 15000
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, { env: sanitizeSubprocessEnv(process.env), windowsHide: true });
    } catch (e: unknown) {
      resolve({ code: -1, stdout: '', stderr: getErrorMessage(e) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result: { code: number; stdout: string; stderr: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 1000).unref();
      done({ code: -1, stdout, stderr: stderr + '\ntimed out' });
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < MAX_AX_OUTPUT_CHARS) stdout += d.toString('utf8').slice(0, MAX_AX_OUTPUT_CHARS - stdout.length);
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_AX_OUTPUT_CHARS) stderr += d.toString('utf8').slice(0, MAX_AX_OUTPUT_CHARS - stderr.length);
    });
    child.on('error', (e: Error) => { done({ code: -1, stdout, stderr: e.message }); });
    child.on('close', (code: number | null) => { done({ code: code ?? -1, stdout, stderr }); });

    child.stdin.on('error', () => { /* interpreter exited before reading */ });
    child.stdin.write(scriptText);
    child.stdin.end();
  });
}

function formatRows(raw: string, maxNodes: number): string | null {
  const rows = String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('|'))
    .slice(0, maxNodes);

  if (rows.length === 0) return null;

  const lines: string[] = [];
  for (const row of rows) {
    const parts = row.split('|');
    const role = sanitizeToolText(parts[0] ?? '', 80);
    const title = sanitizeToolText(parts[1] ?? '', 240);
    const value = sanitizeToolText(parts.slice(2).join('|'), 240);
    const label = [title, value].filter(Boolean).join(' = ');
    lines.push(label ? `${role}: ${label}` : role);
  }
  return lines.join('\n');
}

export interface AxSnapshotArgs {
  app?: string | undefined;
  maxNodes?: number | undefined;
}

export interface AxSnapshotResult {
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
  requiresConsent?: boolean | undefined;
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

  async execute(args: AxSnapshotArgs = {}, context: ToolWorkspaceContext = {}): Promise<AxSnapshotResult> {
    const app = typeof args?.app === 'string' ? args.app.trim() : '';
    const requested = typeof args?.maxNodes === 'number' && Number.isInteger(args.maxNodes)
      ? args.maxNodes
      : DEFAULT_MAX_NODES;
    const maxNodes = Math.max(1, Math.min(requested, MAX_NODES_CEILING));

    try {
      if (process.platform === 'darwin') {
        const result = await runWithScriptOnStdin(MAC_INTERPRETER, ['-', app, String(maxNodes)], MAC_AX_SCRIPT);

        if (isConsentRefusal(result.stderr)) {
          return {
            success: false,
            requiresConsent: true,
            error: 'macOS has not granted Accessibility permission to the terminal running Causyne. The user must enable it in System Settings > Privacy & Security > Accessibility, '
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

      return {
        success: false,
        error: 'Reading the accessibility tree is supported on macOS and Windows. On this platform, use screenshot({analyzeText:true}) for OCR bounding boxes instead.'
      };
    } catch (e: unknown) {
      return { success: false, error: sanitizeToolError(e) };
    }
  }
};
