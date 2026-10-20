import { spawn } from 'node:child_process';
import path from 'node:path';

import type { HookDecision, HookEvent } from './types/contracts.js';

const MAX_HOOKS_PER_EVENT = 32;
const MAX_OUTPUT_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

type UnknownRecord = Record<string, unknown>;

interface NormalizedHookRule {
  name: string;
  command: [string, ...string[]];
  timeoutMs: number;
}

interface HookProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  overflow?: boolean;
  spawnError?: string;
}

interface RunConfiguredHooksOptions {
  hooks?: unknown;
  event: HookEvent;
  toolName: string;
  args?: unknown;
  result?: unknown;
  taskId?: unknown;
  toolCallId?: unknown;
  workspacePaths?: unknown;
}

function safeObject(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function matchesTool(rule: UnknownRecord, toolName: string): boolean {
  const tools = Array.isArray(rule.tools)
    ? rule.tools
    : [rule.tool == null ? '*' : rule.tool];
  return tools.some((candidate) => candidate === '*' || candidate === toolName);
}

function normalizeRule(rule: unknown, event: HookEvent, toolName: string): NormalizedHookRule | null {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) return null;
  const candidate = rule as UnknownRecord;
  if (candidate.enabled === false || candidate.event !== event || !matchesTool(candidate, toolName)) return null;
  if (!Array.isArray(candidate.command) || candidate.command.length === 0) return null;

  const command = candidate.command.map((part) => String(part));
  const executable = command[0];
  if (!executable || command.length > 64 || command.some((part) => part.length > 4096)) return null;

  return {
    name: String(candidate.name || `${event}:${toolName}`).slice(0, 128),
    command: [executable, ...command.slice(1)],
    timeoutMs: Number.isInteger(candidate.timeoutMs)
      ? Math.max(100, Math.min(candidate.timeoutMs as number, 10_000))
      : DEFAULT_TIMEOUT_MS
  };
}

export function hasMatchingHook(hooks: unknown, event: HookEvent, toolName: string): boolean {
  return (Array.isArray(hooks) ? hooks : [])
    .some((rule) => normalizeRule(rule, event, toolName) !== null);
}

function runOneHook(rule: NormalizedHookRule, payload: UnknownRecord, cwd: string): Promise<HookProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(rule.command[0], rule.command.slice(1), {
      cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '',
        LANG: process.env.LANG || 'C.UTF-8',
        TMPDIR: process.env.TMPDIR || ''
      }
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (value: HookProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ exitCode: null, timedOut: true, stdout, stderr });
    }, rule.timeoutMs);
    timer.unref();

    const collect = (target: string, chunk: Buffer | string): string => {
      const next = target + chunk.toString();
      if (Buffer.byteLength(next, 'utf8') > MAX_OUTPUT_BYTES) {
        child.kill('SIGTERM');
        finish({ exitCode: null, overflow: true, stdout, stderr });
        return target;
      }
      return next;
    };
    child.stdout.on('data', (chunk: Buffer | string) => { stdout = collect(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer | string) => { stderr = collect(stderr, chunk); });
    child.on('error', (error: Error) => finish({ exitCode: null, spawnError: error.message, stdout, stderr }));
    child.on('close', (code: number | null) => finish({ exitCode: code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function feedbackFor(rule: NormalizedHookRule, result: HookProcessResult): string {
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (output) return `${rule.name}: ${output}`.slice(0, MAX_OUTPUT_BYTES);
  if (result.timedOut) return `${rule.name}: timed out after ${rule.timeoutMs} ms`;
  if (result.overflow) return `${rule.name}: output exceeded ${MAX_OUTPUT_BYTES} bytes`;
  if (result.spawnError) return `${rule.name}: ${result.spawnError}`;
  if (result.exitCode !== 0) return `${rule.name}: exited with code ${result.exitCode}`;
  return '';
}

function resolveWorkspaceRoots(workspacePaths: unknown): string[] {
  if (!Array.isArray(workspacePaths)) return [process.cwd()];
  const roots = workspacePaths
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => path.resolve(value));
  return roots.length > 0 ? roots : [process.cwd()];
}

/**
 * Run user-owned lifecycle hooks from ~/.causyne/config.json.
 *
 * Hooks are arrays of argv values and never pass through a shell. Project files
 * are not searched for hooks, which prevents repository code from executing
 * during startup before the user has trusted the workspace.
 */
export async function runConfiguredHooks({
  hooks,
  event,
  toolName,
  args,
  result,
  taskId,
  toolCallId,
  workspacePaths
}: RunConfiguredHooksOptions): Promise<HookDecision> {
  const source: unknown[] = Array.isArray(hooks) ? hooks : [];
  const rules = source
    .map((rule) => normalizeRule(rule, event, toolName))
    .filter((rule): rule is NormalizedHookRule => rule !== null)
    .slice(0, MAX_HOOKS_PER_EVENT);
  if (rules.length === 0) return { denied: false, messages: [] };

  const roots = resolveWorkspaceRoots(workspacePaths);
  const primaryRoot = roots[0] ?? process.cwd();
  const payload: UnknownRecord = {
    event,
    tool: toolName,
    args: safeObject(args),
    taskId: String(taskId || ''),
    toolCallId: String(toolCallId || ''),
    workspacePaths: roots
  };
  if (result !== null && typeof result === 'object') payload.result = result;
  const messages: string[] = [];

  for (const rule of rules) {
    const hookResult = await runOneHook(rule, payload, primaryRoot);
    const feedback = feedbackFor(rule, hookResult);
    if (feedback) messages.push(feedback);

    if (hookResult.exitCode === 2) {
      return feedback
        ? { denied: true, messages, reason: feedback }
        : { denied: true, messages };
    }
    if (event === 'PreToolUse' && hookResult.exitCode !== 0) {
      return { denied: true, messages, reason: feedback || `${rule.name} failed closed` };
    }
  }

  return { denied: false, messages };
}

export { MAX_HOOKS_PER_EVENT, MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS };
