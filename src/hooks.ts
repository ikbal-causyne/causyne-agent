import { spawn } from 'node:child_process';
import path from 'node:path';

import type { HookDecision, HookEvent } from './types/contracts.js';
import { sanitizeSubprocessEnv } from './tools/subprocessEnv.js';
import { redactTextSecrets } from './providers/byokHttp.js';

const MAX_HOOKS_PER_EVENT = 32;
const MAX_OUTPUT_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const KILL_ESCALATION_MS = 500;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

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
  toolName?: string;
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

function redactPayloadValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactTextSecrets(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (depth >= 6 || typeof value !== 'object') return '[omitted]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 128).map((item) => redactPayloadValue(item, depth + 1, seen));
  }
  const out = Object.create(null) as UnknownRecord;
  let count = 0;
  for (const [k, v] of Object.entries(value as UnknownRecord)) {
    if (count >= 128) break;
    if (FORBIDDEN_KEYS.has(k)) continue;
    out[k] = redactPayloadValue(v, depth + 1, seen);
    count++;
  }
  return { ...out };
}

/**
 * Linear-time wildcard matcher supporting `*` and `?` without regex backtracking (ReDoS-free).
 */
export function matchHookToolPattern(pattern: string, toolName: string): boolean {
  if (pattern === '*') return true;
  if (pattern === toolName) return true;
  let pi = 0;
  let ti = 0;
  let starIdx = -1;
  let matchIdx = 0;
  while (ti < toolName.length) {
    if (pi < pattern.length && (pattern[pi] === '?' || pattern[pi] === toolName[ti])) {
      pi++;
      ti++;
    } else if (pi < pattern.length && pattern[pi] === '*') {
      starIdx = pi;
      matchIdx = ti;
      pi++;
    } else if (starIdx !== -1) {
      pi = starIdx + 1;
      matchIdx++;
      ti = matchIdx;
    } else {
      return false;
    }
  }
  while (pi < pattern.length && pattern[pi] === '*') {
    pi++;
  }
  return pi === pattern.length;
}

function matchesTool(rule: UnknownRecord, toolName: string): boolean {
  const tools = Array.isArray(rule.tools)
    ? rule.tools
    : [rule.tool == null ? '*' : rule.tool];
  return tools.some((candidate) => typeof candidate === 'string' && matchHookToolPattern(candidate, toolName));
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

export function hasMatchingHook(hooks: unknown, event: HookEvent, toolName = '*'): boolean {
  return (Array.isArray(hooks) ? hooks : [])
    .some((rule) => normalizeRule(rule, event, toolName) !== null);
}

function terminateHookTree(child: ReturnType<typeof spawn>, detached: boolean): void {
  const pid = child.pid;
  if (typeof pid !== 'number' || pid <= 0) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    return;
  }
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true
      });
      killer.unref();
    } catch {
      try { child.kill(); } catch { /* ignore */ }
    }
    return;
  }
  try {
    if (detached) {
      process.kill(-pid, 'SIGTERM');
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
  const escalate = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (detached) {
        process.kill(-pid, 'SIGKILL');
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      // process already exited
    }
  }, KILL_ESCALATION_MS);
  escalate.unref();
}

function runOneHook(rule: NormalizedHookRule, payload: UnknownRecord, cwd: string): Promise<HookProcessResult> {
  return new Promise((resolve) => {
    const detached = process.platform !== 'win32';
    const child = spawn(rule.command[0], rule.command.slice(1), {
      cwd,
      shell: false,
      detached,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: sanitizeSubprocessEnv(process.env)
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
      terminateHookTree(child, detached);
      finish({ exitCode: null, timedOut: true, stdout, stderr });
    }, rule.timeoutMs);
    timer.unref();

    const collect = (target: string, chunk: Buffer | string): string => {
      const next = target + chunk.toString();
      if (Buffer.byteLength(next, 'utf8') > MAX_OUTPUT_BYTES) {
        terminateHookTree(child, detached);
        finish({ exitCode: null, overflow: true, stdout, stderr });
        return target;
      }
      return next;
    };
    child.stdout.on('data', (chunk: Buffer | string) => { stdout = collect(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer | string) => { stderr = collect(stderr, chunk); });
    child.on('error', (error: Error) => finish({ exitCode: null, spawnError: error.message, stdout, stderr }));
    child.on('close', (code: number | null) => finish({ exitCode: code, stdout, stderr }));
    child.stdin.on('error', () => {
      // Ignore EPIPE when a hook exits immediately without draining stdin
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function parseStructuredHookStdout(stdout: string): {
  permissionDecision?: 'allow' | 'deny' | 'ask';
  reason?: string;
  updatedInput?: UnknownRecord;
  additionalContext?: string;
  systemMessage?: string;
} | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as UnknownRecord;
  const nested = obj.hookSpecificOutput && typeof obj.hookSpecificOutput === 'object' && !Array.isArray(obj.hookSpecificOutput)
    ? obj.hookSpecificOutput as UnknownRecord
    : obj;

  const out: {
    permissionDecision?: 'allow' | 'deny' | 'ask';
    reason?: string;
    updatedInput?: UnknownRecord;
    additionalContext?: string;
    systemMessage?: string;
  } = {};

  const rawDecision = typeof nested.permissionDecision === 'string'
    ? nested.permissionDecision.toLowerCase()
    : (typeof obj.decision === 'string' ? obj.decision.toLowerCase() : '');
  if (rawDecision === 'allow' || rawDecision === 'approve') out.permissionDecision = 'allow';
  else if (rawDecision === 'deny' || rawDecision === 'block') out.permissionDecision = 'deny';
  else if (rawDecision === 'ask') out.permissionDecision = 'ask';

  const rawReason = nested.permissionDecisionReason ?? obj.reason;
  if (typeof rawReason === 'string' && rawReason.trim()) {
    out.reason = redactTextSecrets(rawReason.trim()).slice(0, MAX_OUTPUT_BYTES);
  }
  if (typeof nested.additionalContext === 'string' && nested.additionalContext.trim()) {
    out.additionalContext = redactTextSecrets(nested.additionalContext.trim()).slice(0, MAX_OUTPUT_BYTES);
  }
  if (typeof obj.systemMessage === 'string' && obj.systemMessage.trim()) {
    out.systemMessage = redactTextSecrets(obj.systemMessage.trim()).slice(0, MAX_OUTPUT_BYTES);
  }
  if (nested.updatedInput && typeof nested.updatedInput === 'object' && !Array.isArray(nested.updatedInput)) {
    const cleanInput = Object.create(null) as UnknownRecord;
    for (const [k, v] of Object.entries(nested.updatedInput as UnknownRecord)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      cleanInput[k] = v;
    }
    out.updatedInput = { ...cleanInput };
  }

  return Object.keys(out).length > 0 ? out : null;
}

function feedbackFor(rule: NormalizedHookRule, result: HookProcessResult): string {
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (output) return `${rule.name}: ${redactTextSecrets(output)}`.slice(0, MAX_OUTPUT_BYTES);
  if (result.timedOut) return `${rule.name}: timed out after ${rule.timeoutMs} ms`;
  if (result.overflow) return `${rule.name}: output exceeded ${MAX_OUTPUT_BYTES} bytes`;
  if (result.spawnError) return `${rule.name}: ${redactTextSecrets(result.spawnError)}`;
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
  toolName = '*',
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
  let currentArgs: UnknownRecord = safeObject(args);
  const messages: string[] = [];
  const additionalContext: string[] = [];
  let updatedInput: UnknownRecord | undefined;
  let permissionDecision: 'allow' | 'deny' | 'ask' | undefined;

  for (const rule of rules) {
    const payload: UnknownRecord = {
      event,
      tool: toolName,
      args: redactPayloadValue(currentArgs),
      taskId: String(taskId || ''),
      toolCallId: String(toolCallId || ''),
      workspacePaths: roots
    };
    if (result !== null && typeof result === 'object') {
      payload.result = redactPayloadValue(result);
    }

    const hookResult = await runOneHook(rule, payload, primaryRoot);
    const structured = hookResult.exitCode === 0 ? parseStructuredHookStdout(hookResult.stdout) : null;

    if (structured) {
      if (structured.additionalContext) {
        additionalContext.push(structured.additionalContext);
        messages.push(`${rule.name}: ${structured.additionalContext}`);
      }
      if (structured.systemMessage) {
        messages.push(`${rule.name}: ${structured.systemMessage}`);
      }
      if (structured.updatedInput) {
        updatedInput = { ...(updatedInput ?? currentArgs), ...structured.updatedInput };
        currentArgs = updatedInput;
      }
      if (structured.permissionDecision) {
        permissionDecision = structured.permissionDecision;
      }
      if (structured.permissionDecision === 'deny') {
        const denyReason = structured.reason || `${rule.name}: denied by hook`;
        messages.push(`${rule.name}: ${denyReason}`);
        return {
          denied: true,
          messages,
          reason: denyReason,
          permissionDecision: 'deny',
          ...(updatedInput ? { updatedInput } : {}),
          ...(additionalContext.length > 0 ? { additionalContext } : {})
        };
      }
      if (hookResult.stderr.trim()) {
        messages.push(`${rule.name}: ${redactTextSecrets(hookResult.stderr.trim())}`.slice(0, MAX_OUTPUT_BYTES));
      }
      continue;
    }

    const feedback = feedbackFor(rule, hookResult);
    if (feedback) messages.push(feedback);

    if (hookResult.exitCode === 2) {
      return feedback
        ? { denied: true, messages, reason: feedback, permissionDecision: 'deny' }
        : { denied: true, messages, permissionDecision: 'deny' };
    }
    if (event === 'PreToolUse' && hookResult.exitCode !== 0) {
      return {
        denied: true,
        messages,
        reason: feedback || `${rule.name} failed closed`,
        permissionDecision: 'deny'
      };
    }
  }

  return {
    denied: false,
    messages,
    ...(updatedInput ? { updatedInput } : {}),
    ...(additionalContext.length > 0 ? { additionalContext } : {}),
    ...(permissionDecision ? { permissionDecision } : {})
  };
}

export { MAX_HOOKS_PER_EVENT, MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS };
