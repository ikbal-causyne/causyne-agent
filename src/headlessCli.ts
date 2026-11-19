/**
 * Causyne Agent — Headless / CI Automation CLI Runner
 *
 * Provides non-interactive single-task execution (`-p/--print`, `run`),
 * bounded stdin piping, per-invocation overrides (`--model`, `--provider`,
 * `--max-turns`, `--permission-mode`) without mutating saved config, and
 * machine-readable output formats (`text`, `json`, `stream-json`).
 */

import { AgentLoop, type AgentLoopEventSink } from './agentLoop.js';
import { safeDisplay } from './tui/text.js';

export type HeadlessOutputFormat = 'text' | 'json' | 'stream-json';
export type AutonomyModeCode = 'A' | 'B' | 'C';

export const MAX_STDIN_PROMPT_BYTES = 1_048_576;
export const MAX_HEADLESS_TURNS = 500;

export interface HeadlessToolRecord {
  tool: string;
  status: 'started' | 'completed' | 'error';
  error?: string | undefined;
}

export interface HeadlessUsageSummary {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
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
  error: string | null;
  steps: number;
  toolCalls: HeadlessToolRecord[];
  usage: HeadlessUsageSummary | null;
  durationMs: number;
}

export interface HeadlessLoopLike {
  config?: { provider?: string; model?: string; autonomyMode?: string };
  memoryManager?: { sessionId?: string | null };
  stepsCompleted?: number;
  _causyneTaskOutcome?: string;
  autonomyOverride?: string | null;
  providerOverride?: string | null;
  modelOverride?: string | null;
  maxStepsCeiling?: number | null;
  waitForApproval?: (toolCallId: string) => Promise<boolean>;
  waitForDecision?: (request: unknown) => Promise<unknown>;
  run: () => Promise<void>;
}

export interface HeadlessRunOptions {
  outputFormat?: HeadlessOutputFormat | string | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  maxTurns?: number | string | undefined;
  permissionMode?: string | undefined;
  workspaceRoot?: string | undefined;
  stdout?: { write: (chunk: string) => unknown } | undefined;
  stderr?: { write: (chunk: string) => unknown } | undefined;
  loopFactory?: ((sink: AgentLoopEventSink, taskId: string, prompt: string) => HeadlessLoopLike) | undefined;
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
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw).trim(), 10);
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

    if (type === 'error') {
      const message = typeof parsed.message === 'string' ? safeDisplay(parsed.message) : 'Unknown error';
      this.errors.push(message);
      this.emitStreamLine({ type: 'error', message });
      return;
    }

    if (type === 'usage_update') {
      const summary: HeadlessUsageSummary = {};
      if (typeof parsed.inputTokens === 'number') summary.inputTokens = parsed.inputTokens;
      if (typeof parsed.outputTokens === 'number') summary.outputTokens = parsed.outputTokens;
      if (typeof parsed.totalTokens === 'number') summary.totalTokens = parsed.totalTokens;
      if (typeof parsed.estimatedCostUsd === 'number') summary.estimatedCostUsd = parsed.estimatedCostUsd;
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
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const cleanPrompt = String(taskPrompt ?? '').trim();
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
        ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.model ? { model: options.model } : {})
      });

  if (permissionMode) loop.autonomyOverride = permissionMode;
  if (options.provider) loop.providerOverride = options.provider;
  if (options.model) loop.modelOverride = options.model;
  if (maxTurns !== undefined) loop.maxStepsCeiling = maxTurns;

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
  try {
    await loop.run();
  } catch (err: unknown) {
    fatalError = safeDisplay(err instanceof Error ? err.message : String(err));
  }

  const completed = fatalError === null && loop._causyneTaskOutcome === 'completed';
  const lastError = fatalError ?? (sink.errors.length > 0 ? sink.errors[sink.errors.length - 1] ?? null : null);
  const result: HeadlessRunResult = {
    ok: completed,
    status: fatalError ? 'error' : (completed ? 'completed' : 'incomplete'),
    taskId,
    sessionId: loop.memoryManager?.sessionId ?? null,
    provider: String(options.provider || loop.config?.provider || ''),
    model: String(options.model || loop.config?.model || ''),
    response: sink.response,
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
