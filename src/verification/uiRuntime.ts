import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInteractivePty, type InteractivePtyResult } from './interactivePty.js';

export interface VerifyUiOptions {
  workspace?: string;
  timeoutMs?: number;
  rows?: number;
  columns?: number;
}

export type VerifyUiResult = InteractivePtyResult & {
  feature: string;
  evidence: string;
};

export async function verifyCausyneTui(options: VerifyUiOptions = {}): Promise<VerifyUiResult> {
  const safeOptions = options && typeof options === 'object' ? options : {};
  const workspace = safeOptions.workspace || process.cwd();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-ui-verify-'));
  try {
    const result = await runInteractivePty({
      workspace, script: 'tests/fixtures/liveTuiTarget.mjs',
      timeoutMs: safeOptions.timeoutMs ?? 15000,
      rows: safeOptions.rows ?? 42,
      columns: safeOptions.columns ?? 126,
      env: { CAUSYNE_HOME: home },
      steps: [
        { name: 'open-usage', waitFor: 'CAUSYNE_VERIFY_READY',
          input: '/usage\r', contains: 'Usage & Context' },
        { name: 'submit-while-pinned', waitFor: 'Usage & Context',
          input: 'verification-message\r', contains: 'CAUSYNE_VERIFY_MESSAGE_OK' },
        { name: 'switch-to-status', waitFor: 'CAUSYNE_VERIFY_MESSAGE_OK',
          input: '/status\r', contains: 'Status' },
        { name: 'submit-while-status-pinned', waitFor: 'Status',
          input: 'verify-exit\r', contains: 'CAUSYNE_VERIFY_EXIT_OK' }
      ]
    });
    return {
      ...result,
      feature: 'tui-usage',
      evidence: 'Observed actual ChatPrompt and StageSurface terminal output at each input boundary'
    };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

export async function verifyCausyneChatMode(options: VerifyUiOptions = {}): Promise<VerifyUiResult> {
  const safeOptions = options && typeof options === 'object' ? options : {};
  const workspace = safeOptions.workspace || process.cwd();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-chat-verify-'));
  try {
    const result = await runInteractivePty({
      workspace, script: 'tests/fixtures/liveChatModeTarget.mjs',
      timeoutMs: safeOptions.timeoutMs ?? 18000,
      rows: safeOptions.rows ?? 42,
      columns: safeOptions.columns ?? 126,
      env: { CAUSYNE_HOME: home },
      steps: [
        { name: 'open-real-chat', waitFor: 'enter send',
          input: '/usage\r', contains: 'Usage & Context' },
        { name: 'real-chat-status', waitFor: 'Usage & Context',
          input: '/status\r', contains: 'Status' },
        { name: 'real-chat-exit', waitFor: 'Status',
          input: 'exit\r', contains: 'exit' }
      ]
    });
    return {
      ...result,
      feature: 'tui-chat-mode',
      evidence: 'Launched Causyne chatMode and observed command handling in real POSIX PTY'
    };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
