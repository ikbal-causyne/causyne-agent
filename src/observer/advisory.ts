export interface AdvisoryInput {
  tool: string;
  args: Record<string, unknown>;
  findings: string[];
  workspaceRoot: string;
}

export interface AdvisoryVerdict {
  risk: number;
  confidence: number;
  observation: string;
}

export interface AdvisoryOptions {
  endpoint: string;
  model: string;
  timeoutMs: number;
}

const MAX_PAYLOAD_CHARS = 5000;

export function isLoopbackEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function completionUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function redact(value: string): string {
  return value
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b(api[-_]?key|token|secret|password|passwd)\b\s*[:=]\s*["']?[^"'\s,}]+/gi, '$1=[redacted]')
    .slice(0, MAX_PAYLOAD_CHARS);
}

function compactArguments(args: Record<string, unknown>): string {
  const allowed: Record<string, unknown> = {};
  for (const key of ['command', 'cmd', 'path', 'file_path', 'source', 'destination', 'action', 'url']) {
    const value = args[key];
    if (typeof value === 'string') allowed[key] = value;
  }
  if (typeof args.content === 'string') {
    allowed.contentExcerpt = args.content.slice(0, 800);
    allowed.contentBytes = Buffer.byteLength(args.content, 'utf8');
  }
  if (Array.isArray(args.edits)) {
    allowed.edits = args.edits.slice(0, 8).map((edit) => {
      if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) return {};
      const record = edit as Record<string, unknown>;
      return {
        before: typeof record.old_string === 'string'
          ? record.old_string.slice(0, 200)
          : typeof record.searchContent === 'string' ? record.searchContent.slice(0, 200) : '',
        after: typeof record.new_string === 'string'
          ? record.new_string.slice(0, 200)
          : typeof record.replaceContent === 'string' ? record.replaceContent.slice(0, 200) : ''
      };
    });
  }
  return redact(JSON.stringify(allowed));
}

function parseVerdict(content: string): AdvisoryVerdict | null {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const risk = record.risk;
    const confidence = record.confidence;
    if (typeof risk !== 'number' || !Number.isFinite(risk)) return null;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;
    return {
      risk: Math.max(0, Math.min(1, risk)),
      confidence: Math.max(0, Math.min(1, confidence)),
      observation: typeof record.observation === 'string' ? record.observation.slice(0, 400) : ''
    };
  } catch {
    return null;
  }
}

export async function queryAdvisory(
  input: AdvisoryInput,
  options: AdvisoryOptions
): Promise<AdvisoryVerdict | null> {
  if (!isLoopbackEndpoint(options.endpoint)) return null;
  if (!options.model.trim()) return null;
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 200) return null;

  const payload = {
    model: options.model,
    temperature: 0,
    max_tokens: 160,
    messages: [
      {
        role: 'system',
        content: 'You are an evidence reviewer for a software agent. Judge only the supplied action and deterministic findings. Do not invent facts. Return one JSON object with keys risk (0..1), confidence (0..1), and observation (one sentence). High risk means the action could destroy work, escape the workspace, expose credentials, or publish state. Low risk means the action is reversible and scoped.'
      },
      {
        role: 'user',
        content: `Tool: ${input.tool}\nWorkspace: ${input.workspaceRoot}\nFindings: ${input.findings.slice(0, 6).join(' | ') || 'none'}\nArguments: ${compactArguments(input.args)}`
      }
    ]
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(completionUrl(options.endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
    const choices = (body as Record<string, unknown>).choices;
    if (!Array.isArray(choices) || choices.length === 0) return null;
    const first = choices[0];
    if (first === null || typeof first !== 'object' || Array.isArray(first)) return null;
    const message = (first as Record<string, unknown>).message;
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return null;
    const content = (message as Record<string, unknown>).content;
    if (typeof content !== 'string') return null;
    return parseVerdict(content);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeAdvisory(options: AdvisoryOptions): Promise<{ healthy: boolean; latencyMs: number; detail: string }> {
  if (!isLoopbackEndpoint(options.endpoint)) {
    return { healthy: false, latencyMs: 0, detail: 'endpoint must be a loopback HTTP URL' };
  }
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, options.timeoutMs));
  try {
    const base = options.endpoint.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    const response = await fetch(`${base}/models`, { signal: controller.signal });
    return {
      healthy: response.ok,
      latencyMs: Date.now() - start,
      detail: response.ok ? 'endpoint responded' : `endpoint returned HTTP ${response.status}`
    };
  } catch (error) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      detail: error instanceof Error ? error.message : 'endpoint did not respond'
    };
  } finally {
    clearTimeout(timer);
  }
}
