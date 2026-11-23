/**
 * Causyne Agent — Headless / CI Automation CLI Runner
 *
 * Provides non-interactive single-task execution (`-p/--print`, `run`),
 * bounded stdin piping, per-invocation overrides (`--model`, `--provider`,
 * `--max-turns`, `--permission-mode`) without mutating saved config, and
 * machine-readable output formats (`text`, `json`, `stream-json`).
 */

import fs from 'node:fs';
import { AgentLoop, type AgentLoopEventSink } from './agentLoop.js';
import { safeDisplay } from './tui/text.js';
import { lspSessionManager } from './lsp/lspClient.js';
import { backgroundTaskManager } from './backgroundTasks.js';
import { closeAll as closeAllMcpServers } from './mcp/mcpRegistry.js';

export type HeadlessOutputFormat = 'text' | 'json' | 'stream-json';
export type AutonomyModeCode = 'A' | 'B' | 'C';

export const MAX_STDIN_PROMPT_BYTES = 1_048_576;
export const MAX_HEADLESS_TURNS = 500;
export const MAX_HEADLESS_TIMEOUT_MS = 3_600_000;

export interface HeadlessToolRecord {
  tool: string;
  status: 'started' | 'completed' | 'error';
  error?: string | undefined;
}

export interface HeadlessUsageSummary {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  cachedTokens?: number | undefined;
  estimatedCostUsd?: number | undefined;
}

export interface HeadlessRunResult {
  ok: boolean;
  status: 'completed' | 'incomplete' | 'error';
  taskId: string;
  sessionId: string | null;
  provider: string;
  model: string;
  response: string;
  structuredOutput?: unknown;
  error: string | null;
  steps: number;
  toolCalls: HeadlessToolRecord[];
  usage: HeadlessUsageSummary | null;
  durationMs: number;
}

export interface HeadlessLoopLike {
  config?: { provider?: string; model?: string; autonomyMode?: string };
  llm?: { model?: string; close?: () => Promise<void> | void } | null | undefined;
  memoryManager?: { sessionId?: string | null };
  stepsCompleted?: number;
  _causyneTaskOutcome?: string;
  autonomyOverride?: string | null;
  providerOverride?: string | null;
  modelOverride?: string | null;
  maxStepsCeiling?: number | null;
  taskTokenLimit?: number | null;
  taskCostLimitUsd?: number | null;
  waitForApproval?: (toolCallId: string) => Promise<boolean>;
  waitForDecision?: (request: unknown) => Promise<unknown>;
  abort?: () => void;
  run: () => Promise<void>;
}

export interface HeadlessRunOptions {
  outputFormat?: HeadlessOutputFormat | string | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  maxTurns?: number | string | undefined;
  maxTokens?: number | string | undefined;
  maxBudgetUsd?: number | string | undefined;
  timeoutSeconds?: number | string | undefined;
  timeoutMs?: number | undefined;
  resumeSession?: boolean | undefined;
  jsonSchema?: string | Record<string, unknown> | undefined;
  permissionMode?: string | undefined;
  workspaceRoot?: string | undefined;
  stdout?: { write: (chunk: string) => unknown } | undefined;
  stderr?: { write: (chunk: string) => unknown } | undefined;
  loopFactory?: ((sink: AgentLoopEventSink, taskId: string, prompt: string) => HeadlessLoopLike) | undefined;
}

export function parseMaxTokens(raw?: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const trimmed = String(raw).trim();
  const parsed = typeof raw === 'number' ? raw : (/^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 10_000_000) {
    throw new Error(`Invalid --max-tokens "${raw}". Expected an integer between 100 and 10000000.`);
  }
  return parsed;
}

export function parseMaxBudgetUsd(raw?: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parsed = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10_000) {
    throw new Error(`Invalid --max-budget-usd "${raw}". Expected a positive number up to 10000.`);
  }
  return parsed;
}

export function parseTimeoutMs(secondsRaw?: unknown, msRaw?: unknown): number | undefined {
  if (typeof msRaw === 'number' && Number.isFinite(msRaw) && msRaw > 0) {
    return Math.min(MAX_HEADLESS_TIMEOUT_MS, Math.max(50, Math.floor(msRaw)));
  }
  if (secondsRaw === undefined || secondsRaw === null || secondsRaw === '') return undefined;
  const parsed = typeof secondsRaw === 'number' ? secondsRaw : Number(String(secondsRaw).trim());
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 3600) {
    throw new Error(`Invalid --timeout "${secondsRaw}". Expected seconds between 1 and 3600.`);
  }
  return Math.floor(parsed * 1000);
}

function loadJsonSchemaObject(raw?: string | Record<string, unknown>): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  const text = String(raw).trim();
  if (!text) return null;
  let source = text;
  if (!text.startsWith('{')) {
    const stat = fs.lstatSync(text);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 256 * 1024) {
      throw new Error(`Invalid --json-schema file: ${text}`);
    }
    source = fs.readFileSync(text, 'utf8');
  }
  const parsed: unknown = JSON.parse(source);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--json-schema must be a JSON object schema.');
  }
  return parsed as Record<string, unknown>;
}

function extractAndValidateStructuredOutput(
  responseText: string,
  schema: Record<string, unknown>
): { ok: true; value: unknown } | { ok: false; error: string } {
  let candidate = responseText.trim();
  const fenceStart = candidate.indexOf('```');
  if (fenceStart !== -1) {
    const afterLang = candidate.indexOf('\n', fenceStart + 3);
    const fenceEnd = afterLang !== -1 ? candidate.indexOf('```', afterLang + 1) : -1;
    if (afterLang !== -1 && fenceEnd !== -1) {
      candidate = candidate.slice(afterLang + 1, fenceEnd).trim();
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err: unknown) {
    return {
      ok: false,
      error: `Headless --json-schema validation failed: response is not valid JSON (${err instanceof Error ? err.message : String(err)}).`
    };
  }
  if (schema.type === 'object' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
    return { ok: false, error: 'Headless --json-schema validation failed: expected a JSON object.' };
  }
  if (schema.type === 'array' && !Array.isArray(parsed)) {
    return { ok: false, error: 'Headless --json-schema validation failed: expected a JSON array.' };
  }
  if (Array.isArray(schema.required) && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    const missing = schema.required.filter((k) => typeof k === 'string' && !Object.hasOwn(record, k));
    if (missing.length > 0) {
      return { ok: false, error: `Headless --json-schema validation failed: missing required keys: ${missing.join(', ')}.` };
    }
  }
  return { ok: true, value: parsed };
}

export function parseOutputFormat(raw?: unknown): HeadlessOutputFormat {
  if (raw === undefined || raw === null || raw === '') return 'text';
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'text' || normalized === 'json' || normalized === 'stream-json') {
    return normalized;
  }
  throw new Error(`Invalid --output-format "${raw}". Expected one of: text, json, stream-json.`);
}

export function parsePermissionMode(raw?: unknown): AutonomyModeCode | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const normalized = String(raw).trim().toUpperCase();
  if (normalized === 'A' || normalized === 'SUPERVISED' || normalized === 'STRICT') return 'A';
  if (normalized === 'B' || normalized === 'BALANCED' || normalized === 'DEFAULT') return 'B';
  if (normalized === 'C' || normalized === 'AUTONOMOUS' || normalized === 'AUTO') return 'C';
  throw new Error(`Invalid --permission-mode "${raw}". Expected A (supervised), B (balanced), or C (autonomous).`);
}

export function parseMaxTurns(raw?: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const trimmed = String(raw).trim();
  const parsed = typeof raw === 'number' ? raw : (/^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_HEADLESS_TURNS) {
    throw new Error(`Invalid --max-turns "${raw}". Expected an integer between 1 and ${MAX_HEADLESS_TURNS}.`);
  }
  return parsed;
}

export function composeHeadlessPrompt(
  promptArg: string | boolean | undefined,
  stdinText: string
): string {
  const cleanStdin = stdinText.trim();
  const rawPrompt = typeof promptArg === 'string' ? promptArg.trim() : '';
  const effectivePrompt = rawPrompt === '-' ? '' : rawPrompt;

  if (effectivePrompt && cleanStdin) {
    return `${effectivePrompt}\n\n<stdin>\n${cleanStdin}\n</stdin>`;
  }
  if (effectivePrompt) return effectivePrompt;
  if (cleanStdin) return cleanStdin;
  return '';
}

export async function readBoundedStdin(
  stream: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  maxBytes = MAX_STDIN_PROMPT_BYTES
): Promise<string> {
  if (!stream || stream.isTTY) return '';

  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;

    const onData = (chunk: Buffer | string): void => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (truncated) return;
      const remaining = maxBytes - totalBytes;
      if (buf.length <= remaining) {
        chunks.push(buf);
        totalBytes += buf.length;
      } else {
        if (remaining > 0) chunks.push(buf.subarray(0, remaining));
        totalBytes = maxBytes;
        truncated = true;
      }
    };

    const cleanup = (): void => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    };

    const onEnd = (): void => {
      cleanup();
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(truncated ? `${text}\n\n[stdin truncated at ${maxBytes} bytes]` : text);
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class HeadlessEventSink implements AgentLoopEventSink {
  readyState = 1;
  response = '';
  errors: string[] = [];
  toolCalls: HeadlessToolRecord[] = [];
  usage: HeadlessUsageSummary | null = null;

  private readonly format: HeadlessOutputFormat;
  private readonly stdout: { write: (chunk: string) => unknown };
  private streamedPrefix = '';

  constructor(
    format: HeadlessOutputFormat,
    stdout: { write: (chunk: string) => unknown } = process.stdout
  ) {
    this.format = format;
    this.stdout = stdout;
  }

  private emitStreamLine(payload: Record<string, unknown>): void {
    if (this.format !== 'stream-json') return;
    this.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  send(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(parsed) || typeof parsed.type !== 'string') return;

    const type = parsed.type;

    if (type === 'agent_message') {
      const content = typeof parsed.content === 'string' ? safeDisplay(parsed.content) : '';
      const streaming = Boolean(parsed.streaming);
      if (streaming) {
        const delta = content.startsWith(this.streamedPrefix)
          ? content.slice(this.streamedPrefix.length)
          : content;
        this.streamedPrefix = content;
        this.response = content;
        if (delta) {
          this.emitStreamLine({ type: 'delta', text: delta });
        }
      } else {
        this.streamedPrefix = '';
        if (content) {
          this.response = content;
          this.emitStreamLine({ type: 'message', role: 'assistant', text: content });
        }
      }
      return;
    }

    if (type === 'step_start') {
      const tool = typeof parsed.tool === 'string' ? safeDisplay(parsed.tool) : 'tool';
      this.toolCalls.push({ tool, status: 'started' });
      this.emitStreamLine({ type: 'tool_call', tool });
      return;
    }

    if (type === 'step_complete') {
      const tool = typeof parsed.tool === 'string' ? safeDisplay(parsed.tool) : 'tool';
      const last = [...this.toolCalls].reverse().find(entry => entry.tool === tool && entry.status === 'started');
      if (last) last.status = 'completed';
      else this.toolCalls.push({ tool, status: 'completed' });
      this.emitStreamLine({ type: 'tool_result', tool, ok: true });
      return;
    }

    if (type === 'step_error') {
      const tool = typeof parsed.tool === 'string' ? safeDisplay(parsed.tool) : 'tool';
      const errText = typeof parsed.error === 'string' ? safeDisplay(parsed.error) : 'Tool failed';
      const last = [...this.toolCalls].reverse().find(entry => entry.tool === tool && entry.status === 'started');
      if (last) {
        last.status = 'error';
        last.error = errText;
      } else {
        this.toolCalls.push({ tool, status: 'error', error: errText });
      }
      this.emitStreamLine({ type: 'tool_result', tool, ok: false, error: errText });
      return;
    }

    if (type === 'notice' && parsed.nativeStep === true && typeof parsed.actionName === 'string') {
      const tool = safeDisplay(parsed.actionName);
      this.toolCalls.push({ tool, status: 'completed' });
      this.emitStreamLine({ type: 'tool_result', tool, ok: true });
      return;
    }

    if (type === 'warning' && parsed.nativeStep === true && parsed.nativeFailed === true && typeof parsed.actionName === 'string') {
      const tool = safeDisplay(parsed.actionName);
      const errText = typeof parsed.message === 'string' ? safeDisplay(parsed.message) : 'Tool failed';
      this.toolCalls.push({ tool, status: 'error', error: errText });
      this.emitStreamLine({ type: 'tool_result', tool, ok: false, error: errText });
      return;
    }

    if (type === 'approval_request') {
      const tool = typeof parsed.tool === 'string' ? safeDisplay(parsed.tool) : 'tool';
      const msg = `Approval required for "${tool}" in non-interactive headless mode (auto-denied).`;
      this.errors.push(msg);
      this.emitStreamLine({ type: 'approval_denied', tool, message: msg });
      return;
    }

    if (type === 'budget_warning') {
      const msg = typeof parsed.message === 'string' ? safeDisplay(parsed.message) : 'Token/budget threshold warning';
      this.emitStreamLine({ type: 'budget_warning', message: msg });
      return;
    }

    if (type === 'error') {
      const message = typeof parsed.message === 'string' ? safeDisplay(parsed.message) : 'Unknown error';
      this.errors.push(message);
      this.emitStreamLine({ type: 'error', message });
      return;
    }

    if (type === 'usage_update') {
      const prevIn = this.usage?.inputTokens ?? 0;
      const prevOut = this.usage?.outputTokens ?? 0;
      const summary: HeadlessUsageSummary = {};
      if (typeof parsed.inputTokens === 'number' && parsed.inputTokens > 0) {
        summary.inputTokens = prevIn + parsed.inputTokens;
      } else if (prevIn > 0) {
        summary.inputTokens = prevIn;
      }
      if (typeof parsed.outputTokens === 'number' && parsed.outputTokens > 0) {
        summary.outputTokens = prevOut + parsed.outputTokens;
      } else if (prevOut > 0) {
        summary.outputTokens = prevOut;
      }
      if (typeof parsed.totalTokens === 'number') {
        summary.totalTokens = parsed.totalTokens;
      } else if (typeof parsed.taskTokens === 'number' && parsed.taskTokens > 0) {
        summary.totalTokens = parsed.taskTokens;
      } else if ((summary.inputTokens ?? 0) + (summary.outputTokens ?? 0) > 0) {
        summary.totalTokens = (summary.inputTokens ?? 0) + (summary.outputTokens ?? 0);
      }
      if (typeof parsed.cachedTokens === 'number' && parsed.cachedTokens > 0) {
        summary.cachedTokens = parsed.cachedTokens;
      }
      if (typeof parsed.estimatedCostUsd === 'number') {
        summary.estimatedCostUsd = parsed.estimatedCostUsd;
      } else if (typeof parsed.taskCostUsd === 'number') {
        summary.estimatedCostUsd = parsed.taskCostUsd;
      } else if (typeof parsed.costUsd === 'number') {
        summary.estimatedCostUsd = parsed.costUsd;
      }
      if (Object.keys(summary).length > 0) {
        this.usage = summary;
        this.emitStreamLine({ type: 'usage', ...summary });
      }
    }
  }
}

export async function runHeadlessTask(
  taskPrompt: string,
  options: HeadlessRunOptions = {}
): Promise<HeadlessRunResult> {
  const startedAt = Date.now();
  const format = parseOutputFormat(options.outputFormat);
  const permissionMode = parsePermissionMode(options.permissionMode);
  const maxTurns = parseMaxTurns(options.maxTurns);
  const maxTokens = parseMaxTokens(options.maxTokens);
  const maxBudgetUsd = parseMaxBudgetUsd(options.maxBudgetUsd);
  const timeoutMs = parseTimeoutMs(options.timeoutSeconds, options.timeoutMs);
  const schemaObj = loadJsonSchemaObject(options.jsonSchema);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const basePrompt = String(taskPrompt ?? '').trim();
  const cleanPrompt = basePrompt && schemaObj
    ? `${basePrompt}\n\nRespond ONLY with valid JSON conforming to this JSON Schema:\n${JSON.stringify(schemaObj)}`
    : basePrompt;
  const taskId = `cli_headless_${startedAt}`;
  const sink = new HeadlessEventSink(format, stdout);

  if (!cleanPrompt) {
    const emptyResult: HeadlessRunResult = {
      ok: false,
      status: 'error',
      taskId,
      sessionId: null,
      provider: '',
      model: '',
      response: '',
      error: 'No prompt provided. Pass a prompt argument or pipe input on stdin.',
      steps: 0,
      toolCalls: [],
      usage: null,
      durationMs: Date.now() - startedAt
    };
    if (format === 'json' || format === 'stream-json') {
      stdout.write(`${JSON.stringify(format === 'stream-json' ? { type: 'result', ...emptyResult } : emptyResult)}\n`);
    } else {
      stderr.write(`${emptyResult.error}\n`);
    }
    process.exitCode = 2;
    return emptyResult;
  }

  const loop: HeadlessLoopLike = options.loopFactory
    ? options.loopFactory(sink, taskId, cleanPrompt)
    : new AgentLoop(sink, taskId, cleanPrompt, {
        ephemeralSession: options.resumeSession !== true,
        ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.model ? { model: options.model } : {})
      });

  if (permissionMode) loop.autonomyOverride = permissionMode;
  if (options.provider) loop.providerOverride = options.provider;
  if (options.model) loop.modelOverride = options.model;
  if (maxTurns !== undefined) loop.maxStepsCeiling = maxTurns;
  if (maxTokens !== undefined) loop.taskTokenLimit = maxTokens;
  if (maxBudgetUsd !== undefined) loop.taskCostLimitUsd = maxBudgetUsd;

  // Non-interactive approval boundary: never hang waiting for a TTY prompt.
  loop.waitForApproval = async () => false;
  loop.waitForDecision = async () => null;

  if (format === 'stream-json') {
    stdout.write(`${JSON.stringify({
      type: 'start',
      taskId,
      provider: options.provider || loop.config?.provider || '',
      model: options.model || loop.config?.model || ''
    })}\n`);
  }

  let fatalError: string | null = null;
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs !== undefined) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      try { loop.abort?.(); } catch { /* ignore */ }
    }, timeoutMs);
    timeoutHandle.unref?.();
  }
  try {
    await loop.run();
  } catch (err: unknown) {
    fatalError = safeDisplay(err instanceof Error ? err.message : String(err));
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    try {
      await loop.llm?.close?.();
    } catch {
      // ignore provider teardown errors on headless exit
    }
    try {
      await closeAllMcpServers();
    } catch {
      // ignore MCP server teardown errors on headless exit
    }
    try {
      await lspSessionManager.shutdownAll();
    } catch {
      // ignore LSP shutdown errors on headless exit
    }
    try {
      backgroundTaskManager.stopAll();
    } catch {
      // ignore background task shutdown errors on headless exit
    }
  }

  if (timedOut && !fatalError) {
    fatalError = `Headless execution timed out after ${timeoutMs}ms.`;
  }

  let structuredOutput: unknown = undefined;
  let schemaError: string | null = null;
  const rawCompleted = fatalError === null && loop._causyneTaskOutcome === 'completed';
  if (rawCompleted && schemaObj) {
    const validated = extractAndValidateStructuredOutput(sink.response, schemaObj);
    if (validated.ok) {
      structuredOutput = validated.value;
    } else {
      schemaError = validated.error;
    }
  }

  const completed = rawCompleted && schemaError === null;
  const lastError = fatalError ?? schemaError ?? (sink.errors.length > 0 ? sink.errors[sink.errors.length - 1] ?? null : null);
  const result: HeadlessRunResult = {
    ok: completed,
    status: (fatalError || schemaError) ? 'error' : (completed ? 'completed' : 'incomplete'),
    taskId,
    sessionId: loop.memoryManager?.sessionId ?? null,
    provider: String(options.provider || loop.config?.provider || ''),
    model: String(options.model || loop.llm?.model || loop.config?.model || ''),
    response: sink.response,
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    error: completed ? null : (lastError || 'No verified task completion was recorded.'),
    steps: typeof loop.stepsCompleted === 'number' ? loop.stepsCompleted : 0,
    toolCalls: sink.toolCalls,
    usage: sink.usage,
    durationMs: Date.now() - startedAt
  };

  if (format === 'json') {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (format === 'stream-json') {
    stdout.write(`${JSON.stringify({ type: 'result', ...result })}\n`);
  } else {
    if (result.response) {
      stdout.write(result.response.endsWith('\n') ? result.response : `${result.response}\n`);
    }
    if (!result.ok && result.error) {
      stderr.write(`${result.error}\n`);
    }
  }

  process.exitCode = result.ok ? 0 : 1;
  return result;
}
