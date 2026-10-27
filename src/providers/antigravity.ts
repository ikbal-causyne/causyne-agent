import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isLaunchOnlyPrompt } from '../launchIntent.js';
import { scanAndAdaptToolsForProvider } from '../tools/toolScanner.js';
import { LLMProvider, type ProviderConfig, type ChatOptions, type ChatResponse, type ChatResponseAction, type ChatResponseToolCall, type ChatResponseUsage } from './base.js';

/**
 * Baseline fallback models for instant offline availability.
 * Live models are autodetected dynamically from `agy models`
 * and cached in ~/.causyne/models_cache.json.
 */
export const BASELINE_ANTIGRAVITY_MODELS: Record<string, string> = {
  'Gemini 3.8 Flash (Low)': 'gemini-3.8-flash-low',
  'Gemini 3.8 Flash (Medium)': 'gemini-3.8-flash-medium',
  'Gemini 3.8 Flash (High)': 'gemini-3.8-flash-high',
  'Gemini 4 Argon (Low)': 'gemini-4-argon-low',
  'Gemini 4 Argon (Medium)': 'gemini-4-argon-medium',
  'Gemini 4 Argon (High)': 'gemini-4-argon-high',
  'Claude Sonnet 5.5 (Low)': 'claude-sonnet-5-5-low',
  'Claude Sonnet 5.5 (Medium)': 'claude-sonnet-5-5-medium',
  'Claude Sonnet 5.5 (High)': 'claude-sonnet-5-5-high',
  'Claude Opus 5.5 (Low)': 'claude-opus-5-5-low',
  'Claude Opus 5.5 (Medium)': 'claude-opus-5-5-medium',
  'Claude Opus 5.5 (High)': 'claude-opus-5-5-high',
  'GPT-OSS 120B (Medium)': 'gpt-oss-120b-medium'
};

export const ANTIGRAVITY_MODEL_IDS: Record<string, string> = {
  ...BASELINE_ANTIGRAVITY_MODELS
};

export const ANTIGRAVITY_LABEL_BY_ID: Record<string, string> = Object.fromEntries(
  Object.entries(ANTIGRAVITY_MODEL_IDS).map(([label, id]) => [id, label])
);

export const ANTIGRAVITY_MODELS: string[] = Object.keys(ANTIGRAVITY_MODEL_IDS);

export function synthesizeAgySlug(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (!/[\s()]/.test(trimmed)) {
    return trimmed;
  }
  let slug = trimmed
    .toLowerCase()
    .replace(/\(([^()]+)\)/g, ' $1 ')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (slug.startsWith('claude-')) {
    slug = slug.replace(/\./g, '-');
  }
  return slug;
}

export function registerAntigravityModel(slug: string, label?: string): void {
  if (!slug || typeof slug !== 'string') return;
  const rawSlug = slug.trim();
  const cleanLabel = (label && typeof label === 'string' && label.trim()) || rawSlug;
  const cleanSlug = /[\s()]/.test(rawSlug)
    ? (ANTIGRAVITY_MODEL_IDS[rawSlug] || synthesizeAgySlug(rawSlug))
    : rawSlug;

  ANTIGRAVITY_MODEL_IDS[cleanLabel] = cleanSlug;
  ANTIGRAVITY_MODEL_IDS[cleanSlug] = cleanSlug;
  ANTIGRAVITY_LABEL_BY_ID[cleanSlug] = cleanLabel;
  if (!ANTIGRAVITY_MODELS.includes(cleanLabel)) {
    ANTIGRAVITY_MODELS.push(cleanLabel);
  }
}

/**
 * Authoritatively replace the active Antigravity model list with the live
 * models returned by the user's current Antigravity account/tier, while
 * preserving slug lookup mappings in ANTIGRAVITY_MODEL_IDS.
 */
export function replaceAntigravityModels(
  items: Array<{ id: string; label?: string } | string>
): string[] {
  const nextLabels: string[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (!trimmed) continue;
      const existingSlug = ANTIGRAVITY_MODEL_IDS[trimmed] || synthesizeAgySlug(trimmed);
      const label = ANTIGRAVITY_LABEL_BY_ID[trimmed] || trimmed;
      registerAntigravityModel(existingSlug, label);
      if (!nextLabels.includes(label)) nextLabels.push(label);
    } else if (item && typeof item === 'object' && typeof item.id === 'string') {
      const id = item.id.trim();
      if (!id) continue;
      const label = (item.label && item.label.trim()) || ANTIGRAVITY_LABEL_BY_ID[id] || id;
      registerAntigravityModel(id, label);
      if (!nextLabels.includes(label)) nextLabels.push(label);
    }
  }
  if (nextLabels.length > 0) {
    ANTIGRAVITY_MODELS.splice(0, ANTIGRAVITY_MODELS.length, ...nextLabels);
  }
  return [...ANTIGRAVITY_MODELS];
}

export function parseAgyModelsOutput(
  stdout: string,
  options: { replaceActiveList?: boolean } = {}
): Array<{ id: string; label: string }> {
  const result: Array<{ id: string; label: string }> = [];
  if (!stdout || typeof stdout !== 'string') return result;

  const lines = stdout.replace(/\r/g, '\n').split(/\n+/);
  for (const rawLine of lines) {
    const line = rawLine.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim();
    if (!line) continue;
    if (/^(fetching|loading|no models|error|warning|usage|available)/i.test(line)) continue;
    if (line.endsWith('…') || line.endsWith('...')) continue;

    const cleanLine = line.replace(/^[^a-zA-Z0-9_-]+/, '');
    const match = cleanLine.match(/^([a-z0-9_.-]+)(?:\s+(.+))?$/i);
    if (!match) continue;

    const id = match[1]!.trim();
    const label = ((match[2] && match[2].trim()) || id).replace(/\s+\(default\)$/i, '').trim();
    result.push({ id, label });
    registerAntigravityModel(id, label);
  }
  if (options.replaceActiveList && result.length > 0) {
    replaceAntigravityModels(result);
  }
  return result;
}

export function isAntigravityOnboarded(): boolean {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (!home) return false;
    const onboardingFile = path.join(home, '.gemini', 'antigravity-cli', 'cache', 'onboarding.json');
    if (fs.existsSync(onboardingFile)) {
      const parsed = JSON.parse(fs.readFileSync(onboardingFile, 'utf8'));
      if (parsed && parsed.onboardingComplete === true) return true;
    }
    const oauthFile = path.join(home, '.gemini', 'oauth_creds.json');
    if (fs.existsSync(oauthFile)) return true;
  } catch {
    // ignore read errors
  }
  return false;
}

function hydrateModelsFromDiskCache(): void {
  try {
    const causyneDir = process.env.CAUSYNE_HOME
      || path.join(process.env.HOME || process.env.USERPROFILE || '', '.causyne');
    const cacheFile = path.join(causyneDir, 'models_cache.json');
    if (!fs.existsSync(cacheFile)) return;
    const content = fs.readFileSync(cacheFile, 'utf8');
    const parsed = JSON.parse(content);
    const agyEntry = parsed?.providers?.antigravity;
    if (agyEntry?.modelIdMap && typeof agyEntry.modelIdMap === 'object') {
      for (const [label, slug] of Object.entries(agyEntry.modelIdMap)) {
        if (typeof slug === 'string' && slug.trim()) {
          registerAntigravityModel(slug.trim(), label);
        }
      }
    }
    const agyModels = agyEntry?.models;
    if (Array.isArray(agyModels) && agyModels.length > 0) {
      for (const item of agyModels) {
        if (typeof item === 'string' && item.trim()) {
          const trimmed = item.trim();
          const slug = ANTIGRAVITY_MODEL_IDS[trimmed] || synthesizeAgySlug(trimmed);
          registerAntigravityModel(slug, trimmed);
        }
      }
    }
  } catch {
    // Ignore cache read errors
  }
}

hydrateModelsFromDiskCache();

export function resolveAgyModelId(model?: string | null): string {
  if (typeof model !== 'string') return '';
  const trimmed = model.trim();
  if (!trimmed) return '';

  if (ANTIGRAVITY_MODEL_IDS[trimmed]) {
    return ANTIGRAVITY_MODEL_IDS[trimmed];
  }

  const lower = trimmed.toLowerCase();
  for (const [key, slug] of Object.entries(ANTIGRAVITY_MODEL_IDS)) {
    if (key.toLowerCase() === lower || slug.toLowerCase() === lower) {
      return slug;
    }
  }

  const effort = resolveAgyEffort(trimmed);
  const candidateWithEffort = `${lower}-${effort}`;
  for (const [key, slug] of Object.entries(ANTIGRAVITY_MODEL_IDS)) {
    if (slug.toLowerCase() === candidateWithEffort || key.toLowerCase() === candidateWithEffort) {
      return slug;
    }
  }
  for (const [key, slug] of Object.entries(ANTIGRAVITY_MODEL_IDS)) {
    if (slug.toLowerCase().startsWith(lower) || key.toLowerCase().startsWith(lower)) {
      return slug;
    }
  }

  if (/[\s()]/.test(trimmed)) {
    return synthesizeAgySlug(trimmed);
  }

  return trimmed;
}

export function resolveAgyEffort(model?: string | null): string {
  if (typeof model !== 'string') return 'low';
  const m = model.toLowerCase();
  if (m.includes('(low)') || m.includes('-low')) return 'low';
  if (m.includes('(medium)') || m.includes('-medium')) return 'medium';
  if (m.includes('(high)') || m.includes('-high')) return 'high';
  if (m.includes('(xhigh)') || m.includes('-xhigh')) return 'xhigh';
  if (m.includes('(max)') || m.includes('-max')) return 'max';
  return 'low';
}

export function isAntigravityProvider(provider?: string | null): boolean {
  if (!provider) return false;
  const p = String(provider).toLowerCase();
  return p === 'antigravity' || p === 'agy' || p.startsWith('antigravity/') || p.startsWith('agy/');
}

export function resolveAgyBinary(): string {
  const envPath = process.env.PATH || '';
  const searchDirs = [
    ...envPath.split(path.delimiter),
    path.join(process.env.HOME || '', '.local/bin'),
    path.join(process.env.HOME || '', '.antigravity/antigravity/bin'),
    path.join(process.env.HOME || '', '.gemini/antigravity-ide/bin'),
    '/Applications/Antigravity.app/Contents/Resources/app/bin',
    '/Applications/Antigravity IDE.app/Contents/Resources/app/bin'
  ];

  const binNames = ['agy', 'antigravity'];
  for (const dir of searchDirs) {
    if (!dir) continue;
    for (const name of binNames) {
      const full = path.join(dir, name);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          return full;
        }
      } catch {
        // ignore inaccessible path
      }
    }
  }
  return 'agy';
}

function describeNativeAction(toolInfo: any): string | undefined {
  const parameters = toolInfo && typeof toolInfo === 'object' ? toolInfo.parameters : null;
  if (parameters && typeof parameters === 'object') {
    for (const key of ['Path', 'path', 'file_path', 'TargetFile', 'target_file', 'CommandLine', 'command', 'url']) {
      const value = parameters[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  for (const key of ['toolAction', 'tool_action', 'toolSummary', 'tool_summary']) {
    const value = toolInfo && toolInfo[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function mapNativeToolToCausyne(
  name: string,
  rawParams: Record<string, any>,
  index: number
): ChatResponseToolCall | null {
  if (!name || typeof name !== 'string') return null;
  const lowerName = name.toLowerCase().replace(/[_-]/g, '');
  const params = rawParams && typeof rawParams === 'object' ? rawParams : {};

  if (lowerName === 'runcommand' || lowerName === 'command' || lowerName === 'sysrun' || lowerName === 'terminal' || lowerName === 'bash' || lowerName === 'shell') {
    const rawCmd = params.CommandLine ?? params.command ?? params.cmd ?? params.input ?? params.detail ?? '';
    let cmd = typeof rawCmd === 'string' ? rawCmd.trim() : '';
    if (!cmd && typeof params.parameters === 'object' && params.parameters) {
      cmd = String(params.parameters.CommandLine || params.parameters.command || params.parameters.cmd || '').trim();
    }
    if (cmd) {
      const isDaemon = Boolean(params.IsDaemon ?? params.isDaemon ?? params.daemon);
      const cwd = params.Cwd ?? params.cwd;
      if (isDaemon) {
        const bgArgs: Record<string, any> = { command: cmd, label: 'daemon' };
        if (typeof cwd === 'string' && cwd.trim()) bgArgs.cwd = cwd.trim();
        return {
          id: `agy_native_${Date.now()}_${index}`,
          type: 'function',
          function: {
            name: 'sysRunBg',
            arguments: JSON.stringify(bgArgs)
          }
        };
      }
      const args: Record<string, any> = { command: cmd };
      if (typeof cwd === 'string' && cwd.trim()) args.cwd = cwd.trim();
      return {
        id: `agy_native_${Date.now()}_${index}`,
        type: 'function',
        function: {
          name: 'sysRun',
          arguments: JSON.stringify(args)
        }
      };
    }
  }

  if (lowerName === 'viewfile' || lowerName === 'readfile' || lowerName === 'read' || lowerName === 'view' || lowerName === 'fsread') {
    const filePath = params.AbsolutePath ?? params.path ?? params.file_path ?? params.TargetFile ?? '';
    if (typeof filePath === 'string' && filePath.trim()) {
      return {
        id: `agy_native_${Date.now()}_${index}`,
        type: 'function',
        function: {
          name: 'fs_read',
          arguments: JSON.stringify({ path: filePath.trim() })
        }
      };
    }
  }

  if (lowerName === 'listdir' || lowerName === 'fslist' || lowerName === 'list') {
    const dirPath = params.DirectoryPath ?? params.path ?? '.';
    return {
      id: `agy_native_${Date.now()}_${index}`,
      type: 'function',
      function: {
        name: 'fs_list',
        arguments: JSON.stringify({ path: String(dirPath).trim() || '.' })
      }
    };
  }

  if (lowerName === 'grepsearch' || lowerName === 'searchworkspace') {
    const query = params.Query ?? params.query ?? '';
    if (typeof query === 'string' && query.trim()) {
      return {
        id: `agy_native_${Date.now()}_${index}`,
        type: 'function',
        function: {
          name: 'workspace_search',
          arguments: JSON.stringify({
            query: query.trim(),
            path: params.SearchPath ?? params.path ?? '.'
          })
        }
      };
    }
  }

  if (lowerName === 'writetofile' || lowerName === 'fswrite') {
    const filePath = params.TargetFile ?? params.path ?? params.file_path ?? '';
    const content = params.CodeContent ?? params.content ?? '';
    if (typeof filePath === 'string' && filePath.trim()) {
      return {
        id: `agy_native_${Date.now()}_${index}`,
        type: 'function',
        function: {
          name: 'fs_write',
          arguments: JSON.stringify({ path: filePath.trim(), content: String(content) })
        }
      };
    }
  }

  if (lowerName === 'replacefilecontent' || lowerName === 'fsedit') {
    const filePath = params.TargetFile ?? params.path ?? params.file_path ?? '';
    const oldText = params.TargetContent ?? params.oldText ?? '';
    const newText = params.ReplacementContent ?? params.newText ?? '';
    if (typeof filePath === 'string' && filePath.trim()) {
      return {
        id: `agy_native_${Date.now()}_${index}`,
        type: 'function',
        function: {
          name: 'fs_edit',
          arguments: JSON.stringify({ path: filePath.trim(), oldText: String(oldText), newText: String(newText) })
        }
      };
    }
  }

  if (lowerName === 'openbrowserurl') {
    const url = params.Url ?? params.url ?? '';
    if (typeof url === 'string' && url.trim()) {
      return {
        id: `agy_native_${Date.now()}_${index}`,
        type: 'function',
        function: {
          name: 'desktop.open',
          arguments: JSON.stringify({ target: url.trim() })
        }
      };
    }
  }

  if (lowerName === 'readurlcontent') {
    const url = params.Url ?? params.url ?? '';
    if (typeof url === 'string' && url.trim()) {
      return {
        id: `agy_native_${Date.now()}_${index}`,
        type: 'function',
        function: {
          name: 'web_fetch',
          arguments: JSON.stringify({ url: url.trim() })
        }
      };
    }
  }

  if (lowerName === 'searchweb') {
    const query = params.query ?? params.Query ?? '';
    if (typeof query === 'string' && query.trim()) {
      return {
        id: `agy_native_${Date.now()}_${index}`,
        type: 'function',
        function: {
          name: 'web_search',
          arguments: JSON.stringify({ query: query.trim() })
        }
      };
    }
  }

  if (lowerName === 'multireplacefilecontent' || lowerName === 'multireplace') {
    const filePath = params.TargetFile ?? params.path ?? params.file_path ?? '';
    const rawChunks = Array.isArray(params.ReplacementChunks) ? params.ReplacementChunks : [];
    const edits = rawChunks.map((chunk: any) => ({
      old_string: String(chunk.TargetContent ?? chunk.old_string ?? ''),
      new_string: String(chunk.ReplacementContent ?? chunk.new_string ?? '')
    })).filter((e: any) => e.old_string);
    if (typeof filePath === 'string' && filePath.trim() && edits.length > 0) {
      return {
        id: `agy_native_${Date.now()}_${index}`,
        type: 'function',
        function: {
          name: 'MultiEdit',
          arguments: JSON.stringify({ file_path: filePath.trim(), edits })
        }
      };
    }
  }

  if (lowerName === 'browsersubagent' || lowerName === 'browseragent') {
    const textToSearch = [
      params.Url, params.url, params.Task, params.task, params.TaskName, params.taskName, params.TaskSummary
    ].filter(Boolean).join(' ');
    const urlMatch = textToSearch.match(/https?:\/\/[^\s'")]+/i) || textToSearch.match(/localhost:\d+[^\s'")]*/i);
    if (urlMatch) {
      let targetUrl = urlMatch[0];
      if (!targetUrl.startsWith('http')) targetUrl = `http://${targetUrl}`;
      return {
        id: `agy_native_${Date.now()}_${index}`,
        type: 'function',
        function: {
          name: 'desktop.open',
          arguments: JSON.stringify({ target: targetUrl })
        }
      };
    }
  }

  if (lowerName === 'managetask') {
    const action = String(params.Action ?? params.action ?? '').toLowerCase();
    if (action === 'list') {
      return {
        id: `agy_native_${Date.now()}_${index}`,
        type: 'function',
        function: {
          name: 'process_list',
          arguments: JSON.stringify({})
        }
      };
    }
    if (action === 'kill') {
      const pid = Number(params.TaskId ?? params.taskId ?? params.pid);
      if (!Number.isNaN(pid) && pid > 0) {
        return {
          id: `agy_native_${Date.now()}_${index}`,
          type: 'function',
          function: {
            name: 'proc_term',
            arguments: JSON.stringify({ pid })
          }
        };
      }
    }
  }

  return null;
}

export class AntigravityProvider extends LLMProvider {
  command: string;
  printTimeout: string;
  currentConversationId: string | null = null;
  lastTaskId: string | null = null;
  private lastCumulativeUsage: { conversationId: string; input: number; output: number; thinking: number; cacheRead: number } | null = null;

  constructor(config: ProviderConfig = {}) {
    super(config);
    this.model = config.model || 'Gemini 3.8 Flash (Low)';
    this.command = config.command || resolveAgyBinary();
    this.printTimeout = typeof config.printTimeout === 'string' && config.printTimeout.trim()
      ? config.printTimeout.trim()
      : '1800s';
    // This ACP bridge currently sends text-only stream-json messages. Image
    // blocks are reduced to labels in formatDelta/formatConversation, so do
    // not advertise vision or ask for desktop capture as proof of inspection.
    this.visionModels = [];
    this.audioModels = [];
  }

  formatDelta(messages: any[]): string {
    const lines: string[] = [];
    for (const msg of messages) {
      const role = msg.role === 'user'
        ? 'User'
        : (msg.role === 'assistant'
          ? 'Assistant'
          : (msg.role === 'system'
            ? 'System Instructions'
            : (msg.role === 'tool'
              ? `Tool Result (${msg.name || 'tool'})`
              : 'Context')));

      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content.map((c: any) => {
          if (typeof c === 'string') return c;
          if (c?.text) return c.text;
          if (c?.type === 'image_url' || c?.type === 'image') {
            const url = c?.image_url?.url || '';
            const mime = c?.source?.media_type || (url.startsWith('data:') ? url.slice(5, url.indexOf(';')) : 'image');
            return `[Visual Content: ${mime}]`;
          }
          return '';
        }).filter(Boolean).join('\n');
      }

      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const fn = tc.function || {};
          const fnArgs = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {});
          text += `\n<tool_call>{"name": "${fn.name}", "arguments": ${fnArgs}}</tool_call>`;
        }
      }

      if (text.trim()) {
        lines.push(`[${role}]\n${text.trim()}`);
      }
    }
    return lines.join('\n\n');
  }

  formatConversation(messages: any[], tools: any[] = []): string {
    const lines: string[] = [];

    // Host capabilities must be learned from real tool results in this session.
    lines.push(
      '[System Instructions]\n' +
      'You are the execution engine for Causyne Agent, operating inside the user\'s workspace. ' +
      'Do not claim a tool action succeeded without evidence. Use Causyne tools for file changes, terminal commands, and browser actions. ' +
      'When a command, browser action, or other external action is required, output an explicit tool call in this exact format:\n' +
      '<tool_call>{"name": "tool_name", "arguments": { ... }}</tool_call>\n' +
      'Causyne Agent will execute the tool in its secure environment and return the results back to you.\n\n' +
      '[Action Directive]\n' +
      '1. When the user requests to create, build, code, fix, write, optimize, or implement anything, invoke the relevant file or command tools immediately.\n' +
      '2. When the user requests to OPEN, LAUNCH, RUN, SERVE, or PLAY an application, project, or game:\n' +
      '   - If a background server is required (e.g. server.py, python -m http.server, npm run dev), start it using sysRunBg or a background command.\n' +
      '   - If the default port (e.g. 8080 or 3000) is already occupied or in use by another process, immediately use the next available port (e.g. 8081, 8082, 3001) rather than getting stuck in process-checking loops.\n' +
      '   - Immediately open the URL or project in the user\'s browser using desktop.open with {"target": "http://localhost:<port>"} or run the native open command.\n' +
      '   - Confirm the application is accessible only after a readiness check succeeds.\n' +
      '3. NEVER reply with conversational pleasantries, canned greetings (e.g. "How can I help you today?"), or ask what the user wants when an instruction has already been provided.\n' +
      '4. Create or edit files only when the current user request authorizes it.\n' +
      '5. TOKEN CONSERVATION & MEDIA DIRECTIVE:\n' +
      '   - NEVER attempt to read binary or media files (.png, .jpg, .blend, .glb, .wasm, .zip, etc.) using text reading tools like read_file or cat. This blows up the token context.\n' +
      '   - For 3D modeling, Blender, or media tasks: write a single self-contained generator script and execute it in one batch. Avoid dozens of speculative CLI exploration commands.\n' +
      '   - For verifying images or rendered files, use visual inspection or file metadata receipts only.\n\n' +
      '[Environment State & Idempotency Directive]\n' +
      'Reuse relevant verified tool results from this session, and check uncertain prerequisites before relying on them.\n\n' +
      '[Language & Communication Directive]\n' +
      'Dynamically reflect and match the exact language used by the user in their prompt. Respond naturally in that same language. Never send conversational pleasantries or canned greetings.'
    );

    if (tools && tools.length > 0) {
      const scanReport = scanAndAdaptToolsForProvider(tools, 'antigravity');
      const toolSummaries = scanReport.adaptedTools.map((t: any) => {
        const name = t.name || 'unknown';
        const desc = t.description || '';
        const params = t.parameters || {};
        const paramKeys = Object.keys(params.properties || {}).join(', ');
        return `- ${name}(${paramKeys}): ${desc}`;
      }).join('\n');
      lines.push(
        `[Available Tools]\nYou may invoke tools when needed by outputting:\n<tool_call>{"name": "tool_name", "arguments": { ... }}</tool_call>\n\n${toolSummaries}`
      );
    }

    const seenToolOutputs = new Set<string>();
    const seenAssistantCalls = new Set<string>();
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const isRecent = messages.length - i <= 4;
      const role = msg.role === 'user'
        ? 'User'
        : (msg.role === 'assistant'
          ? 'Assistant'
          : (msg.role === 'system'
            ? 'System Instructions'
            : (msg.role === 'tool'
              ? `Tool Result (${msg.name || 'tool'})`
              : 'Context')));

      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content.map((c: any) => {
          if (typeof c === 'string') return c;
          if (c?.text) return c.text;
          if (c?.type === 'image_url' || c?.type === 'image') {
            const url = c?.image_url?.url || '';
            const mime = c?.source?.media_type || (url.startsWith('data:') ? url.slice(5, url.indexOf(';')) : 'image');
            return `[Visual Content: ${mime}]`;
          }
          return '';
        }).filter(Boolean).join('\n');
      }

      // Compact duplicate identical tool outputs to prevent token ballooning
      if (msg.role === 'tool' && text.trim()) {
        const normalized = text.trim();
        if (seenToolOutputs.has(normalized)) {
          continue;
        }
        seenToolOutputs.add(normalized);
      }

      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const fn = tc.function || {};
          const fnArgs = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {});
          const callSig = `${fn.name}:${fnArgs}`;
          if (seenAssistantCalls.has(callSig)) {
            continue;
          }
          seenAssistantCalls.add(callSig);
          text += `\n<tool_call>{"name": "${fn.name}", "arguments": ${fnArgs}}</tool_call>`;
        }
      }

      if (text.trim()) {
        lines.push(`[${role}]\n${text.trim()}`);
      }
    }
    return lines.join('\n\n');
  }

  extractToolCalls(text: string): ChatResponseToolCall[] {
    const calls: ChatResponseToolCall[] = [];
    if (!text || typeof text !== 'string') return calls;
    const regex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    let match: RegExpExecArray | null;
    let index = 0;
    while ((match = regex.exec(text)) !== null) {
      try {
        const raw = match[1]?.trim() || '';
        const parsed = JSON.parse(raw);
        const name = parsed.name || parsed.tool || parsed.function?.name;
        if (name) {
          const rawArgs = parsed.arguments !== undefined ? parsed.arguments : (parsed.parameters !== undefined ? parsed.parameters : (parsed.input !== undefined ? parsed.input : (parsed.function?.arguments || {})));
          calls.push({
            id: `agy_call_${Date.now()}_${index++}`,
            type: 'function',
            function: {
              name,
              arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || {})
            }
          });
        }
      } catch {
        // ignore malformed tool_call blocks
      }
    }

    if (calls.length === 0) {
      const fenceRegex = /```(?:tool_call|json)?\s*(\{[\s\S]*?"name"\s*:\s*[\s\S]*?\})\s*```/g;
      while ((match = fenceRegex.exec(text)) !== null) {
        try {
          const raw = match[1]?.trim() || '';
          const parsed = JSON.parse(raw);
          const name = parsed.name || parsed.tool || parsed.function?.name;
          if (name) {
            const rawArgs = parsed.arguments !== undefined ? parsed.arguments : (parsed.parameters !== undefined ? parsed.parameters : (parsed.input !== undefined ? parsed.input : (parsed.function?.arguments || {})));
            calls.push({
              id: `agy_call_${Date.now()}_${index++}`,
              type: 'function',
              function: {
                name,
                arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || {})
              }
            });
          }
        } catch {
          // ignore
        }
      }
    }

    // Unclosed tool_call recovery (when model generated large file content and closed turn)
    if (calls.length === 0) {
      const openIndex = text.lastIndexOf('<tool_call>');
      if (openIndex !== -1 && text.indexOf('</tool_call>', openIndex) === -1) {
        const partial = text.slice(openIndex + '<tool_call>'.length).trim();
        for (const suffix of ['', '}', '}}', '}}}', '"}', '"}}', '"}}}', '"}]}}', '"]}}', '"]}}}']) {
          try {
            const parsed = JSON.parse(partial + suffix);
            const name = parsed.name || parsed.tool || parsed.function?.name;
            if (name) {
              const rawArgs = parsed.arguments !== undefined ? parsed.arguments : (parsed.parameters !== undefined ? parsed.parameters : (parsed.input !== undefined ? parsed.input : (parsed.function?.arguments || {})));
              calls.push({
                id: `agy_call_${Date.now()}_0`,
                type: 'function',
                function: {
                  name,
                  arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || {})
                }
              });
              break;
            }
          } catch {
            // try next candidate
          }
        }
      }
    }

    return calls;
  }

  _isTransientError(errMessage: string): boolean {
    if (!errMessage) return false;
    const msg = String(errMessage).toLowerCase();
    return msg.includes('connection reset') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('streamgeneratecontent') ||
      msg.includes('socket hang up') ||
      msg.includes('network error') ||
      msg.includes('temporarily unavailable') ||
      msg.includes('status 503') ||
      msg.includes('status 504') ||
      msg.includes('status 429');
  }

  async _executeOnce(messages: any[], options: ChatOptions = {}): Promise<ChatResponse> {
    const currentSessionKey = (options as any).conversationId || (options as any).taskId || null;
    if (currentSessionKey && currentSessionKey !== this.lastTaskId) {
      this.currentConversationId = null;
      this.lastCumulativeUsage = null;
      this.lastTaskId = currentSessionKey;
    }
    if (messages.length <= 1) {
      this.currentConversationId = null;
      this.lastCumulativeUsage = null;
    }

    const useConversation = Boolean(this.currentConversationId);
    const resumedConversationId = this.currentConversationId;
    const latestUserMessage = [...messages].reverse().find(message => message.role === 'user');
    const latestPrompt = typeof latestUserMessage?.content === 'string' ? latestUserMessage.content : '';
    const launchOnly = (options as any).taskIntent === 'launch' || isLaunchOnlyPrompt(latestPrompt);
    const desktopTask = (options as any).taskArchetype === 'desktop_personalization';
    let promptText: string;

    if (useConversation) {
      let lastAssistantIndex = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') {
          lastAssistantIndex = i;
          break;
        }
      }
      const deltaMessages = lastAssistantIndex >= 0 ? messages.slice(lastAssistantIndex + 1) : messages;
      promptText = this.formatDelta(deltaMessages.length > 0 ? deltaMessages : [messages[messages.length - 1]]);
    } else {
      promptText = this.formatConversation(messages, options.tools);
    }

    // A resumed agy conversation retains its old instructions. Reassert the
    // current turn's narrower scope on every call, including formatDelta turns.
    if (launchOnly) {
      promptText = '[Current request: open existing project only]\n' +
        'Inspect the selected project, start an existing server in the background if needed, verify readiness, and open it. ' +
        'Do not create, edit, delete, install, or regenerate files. Do not claim the app opened unless a tool confirmed it. ' +
        'Use Causyne tool calls for commands and desktop opening.\n\n' + promptText;
    }
    if (desktopTask) {
      promptText = '[Current desktop task: finish and verify the requested change]\n' +
        'Use only the tools needed. Search and download alone are not completion. ' +
        'After setting the desktop picture, read back the actual system wallpaper and compare it with the intended image. ' +
        'If a command is denied or the readback does not confirm the change, report the blocker honestly. ' +
        'Keep native tool actions within 12; use Causyne tool calls when a native action is blocked.\n\n' + promptText;
    }

    const modelSlug = resolveAgyModelId(this.model);
    const effort = resolveAgyEffort(this.model);

    // Standard high-performance non-blocking CLI invocation:
    // 1. stream-json output for real-time responsiveness and non-buffering progress.
    // 2. --disable-slash-commands prevents sluggish filesystem and customization scans.
    // 3. agy only treats stdin as a prompt in stream-json input mode. Plain text
    //    stdin without --print starts an interactive session and loses the task.
    //    Keep the prompt off the process command line by sending one user event.
    // 4. --mode accept-edits lets agy create and edit workspace files in
    //    headless mode, where the default request-review policy cannot prompt
    //    and would auto-deny every write. --dangerously-skip-permissions must
    //    stay off: it would also grant shell commands and other host tools,
    //    bypassing Causyne. Native terminal/browser tools remain denied; those
    //    must go through Causyne XML tool calls.
    // 5. Launch-only turns use a shorter limit because they should not spend
    //    several minutes generating code or holding a foreground server open.
    // 6. --conversation links multi-turn steps to agy's local session memory to prevent re-reading files.
    const args = [
      '--mode',
      launchOnly ? 'plan' : 'accept-edits',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--disable-slash-commands',
      '--print-timeout',
      launchOnly ? '90s' : this.printTimeout,
      '--model',
      modelSlug,
      '--effort',
      effort
    ];

    if (useConversation && this.currentConversationId) {
      args.push('--conversation', this.currentConversationId);
    }

    return new Promise<ChatResponse>((resolve, reject) => {
      let isSettled = false;
      const child = spawn(this.command, args, {
        cwd: typeof (options as any).workspaceRoot === 'string' ? (options as any).workspaceRoot : process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let streamedResponse = '';
      let finalResultObj: any = null;
      let sawToolAfterLastText = false;
      const nativeActions: ChatResponseAction[] = [];
      const attemptedNativeTools: {
        name: string;
        parameters: Record<string, any>;
        status: 'running' | 'completed' | 'failed';
        error?: string | undefined;
        detail?: string | undefined;
      }[] = [];
      let childClosed = false;
      const terminateChild = () => {
        try {
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!childClosed) child.kill('SIGKILL');
          }, 1000).unref();
        } catch {
          // A process that already exited needs no further action.
        }
      };
      const maxNativeActions = desktopTask ? 12 : Infinity;
      let nativeActionStarts = 0;
      const seenNativeActionSteps = new Set<number>();
      // Antigravity's result usage is cumulative across the conversation, but
      // DONE step updates carry usage for that step. Keep a turn-local subtotal
      // so a single headless run cannot consume an entire task budget unseen.
      const completedUsageSteps = new Set<number>();
      const partialUsage: ChatResponseUsage = {
        promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0,
        thinkingTokens: 0, measurement: 'provider_reported', cacheMeasurement: 'provider_reported'
      };
      // A headless peer can run many paid model steps before chat() returns.
      // Keep a finite per-call ceiling even when the optional task budget is
      // disabled. Users can set a lower task budget through the existing UI.
      const remainingTaskBudget = Number(options.maxTokensThisCall);
      const tokenLimit = Number.isFinite(remainingTaskBudget) && remainingTaskBudget > 0
        ? Math.min(remainingTaskBudget, 100_000) : 100_000;
      const wallTimer = desktopTask ? setTimeout(() => {
        const error = new Error('Antigravity exceeded the 180-second desktop task limit. Outcome is unverified.') as Error & { code: string };
        error.code = 'AGY_DESKTOP_TASK_LIMIT';
        safeReject(error);
        terminateChild();
      }, 180_000) : null;
      wallTimer?.unref();

      const cleanup = () => {
        if (wallTimer) clearTimeout(wallTimer);
        if (options.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
      };

      const safeReject = (err: Error) => {
        if (isSettled) return;
        isSettled = true;
        // Failed native turns can have already consumed several model steps.
        // Preserve their reported usage for the outer task ledger and prevent
        // the provider from silently replaying a paid turn.
        if (partialUsage.promptTokens + partialUsage.completionTokens > 0) {
          Object.assign(err, { partialUsage: { ...partialUsage } });
        }
        cleanup();
        reject(err);
      };

      const safeResolve = (res: ChatResponse) => {
        if (isSettled) return;
        isSettled = true;
        cleanup();
        resolve(res);
      };

      const onAbort = () => {
        terminateChild();
        const abortErr = new Error('Turn aborted by user or timeout.');
        abortErr.name = 'AbortError';
        safeReject(abortErr);
      };

      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      // Feed prompt directly into child process stdin, then close stdin
      try {
        child.stdin.on('error', () => {});
        child.stdin.write(JSON.stringify({ event: 'user', message: { content: promptText } }) + '\n', 'utf8');
        child.stdin.end();
      } catch (err: any) {
        safeReject(new Error(`Failed to pipe prompt to Antigravity CLI: ${err.message}`));
        return;
      }

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk;

        // Process line-delimited stream-json events
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || ''; // Keep incomplete trailing fragment in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed);
            if (event.event === 'init') {
              if (event.conversation_id) {
                this.currentConversationId = event.conversation_id;
              }
            } else if (event.event === 'step_update') {
              const stepUpdate = event.step_update;
              const usage = stepUpdate?.usage;
              const usageStepIndex = Number(stepUpdate?.step_index ?? event?.step_index);
              if (stepUpdate?.state === 'DONE' && usage && Number.isFinite(usageStepIndex)
                && !completedUsageSteps.has(usageStepIndex)) {
                const input = Number(usage.input_tokens);
                const output = Number(usage.output_tokens);
                if (Number.isFinite(input) && input >= 0 && Number.isFinite(output) && output >= 0) {
                  completedUsageSteps.add(usageStepIndex);
                  partialUsage.promptTokens += input;
                  partialUsage.completionTokens += output;
                  partialUsage.cachedPromptTokens = (partialUsage.cachedPromptTokens || 0)
                    + (Number(usage.cache_read_tokens) || 0);
                  partialUsage.thinkingTokens = (partialUsage.thinkingTokens || 0)
                    + (Number(usage.thinking_tokens) || 0);
                  if (partialUsage.promptTokens + partialUsage.completionTokens >= tokenLimit) {
                    this.currentConversationId = null;
                    const error = Object.assign(
                      new Error(`Antigravity reported at least ${partialUsage.promptTokens + partialUsage.completionTokens} noncached tokens against a ${tokenLimit}-token per-call ceiling. This turn stopped and its outcome is unverified.`),
                      { code: 'AGY_TOKEN_BUDGET', tokenLimit, partialUsage: { ...partialUsage } }
                    );
                    safeReject(error);
                    terminateChild();
                    return;
                  }
                }
              }
              const delta = stepUpdate?.text_delta;
              const stepType = stepUpdate?.step_type;
              if (stepType === 'tool') {
                const state = stepUpdate?.state;
                const stepIndex = Number(stepUpdate?.step_index ?? event?.step_index);
                const newNativeAction = (state === 'ACTIVE' || (state === 'DONE' && Number.isFinite(stepIndex)))
                  && (!Number.isFinite(stepIndex) || !seenNativeActionSteps.has(stepIndex));
                if (newNativeAction && Number.isFinite(stepIndex)) seenNativeActionSteps.add(stepIndex);
                if (desktopTask && newNativeAction && ++nativeActionStarts > maxNativeActions) {
                  const error = new Error(`Antigravity exceeded ${maxNativeActions} native actions for this desktop task. Outcome is unverified.`) as Error & { code: string };
                  error.code = 'AGY_NATIVE_ACTION_BUDGET';
                  safeReject(error);
                  terminateChild();
                  return;
                }
                const toolInfo = stepUpdate?.tool_info || {};
                const name = stepUpdate?.tool_name || toolInfo?.name;
                const status = state === 'DONE' || state === 'ERROR'
                  ? (state === 'ERROR' || toolInfo?.error ? 'failed' : 'completed')
                  : 'running';
                const rawParams = (toolInfo && typeof toolInfo === 'object' && toolInfo.parameters) ||
                  (stepUpdate && typeof stepUpdate === 'object' && stepUpdate.parameters) ||
                  (toolInfo && typeof toolInfo === 'object' && toolInfo.input) ||
                  {};

                if (name) {
                  const existingAttempt = attemptedNativeTools.find(a => a.name === name && a.status === 'running');
                  if (existingAttempt) {
                    existingAttempt.status = status;
                    if (rawParams && Object.keys(rawParams).length > 0) {
                      existingAttempt.parameters = { ...existingAttempt.parameters, ...rawParams };
                    }
                    if (toolInfo?.error?.message) existingAttempt.error = toolInfo.error.message;
                  } else {
                    attemptedNativeTools.push({
                      name,
                      parameters: { ...rawParams },
                      status,
                      error: toolInfo?.error?.message,
                      detail: describeNativeAction(toolInfo) || describeNativeAction({ parameters: rawParams })
                    });
                  }
                }

                if (name && (state === 'ACTIVE' || state === 'DONE' || state === 'ERROR')) {
                  sawToolAfterLastText = true;
                  const detail = describeNativeAction(toolInfo) || describeNativeAction({ parameters: rawParams });
                  const action: ChatResponseAction = {
                    name,
                    status,
                    ...(detail ? { detail } : {})
                  };
                  if (status !== 'running') {
                    const existing = nativeActions.find(a => a.name === action.name && a.detail === action.detail);
                    if (existing) existing.status = status;
                    else nativeActions.push(action);
                  }
                  // Stream the start; completion is reported only after the
                  // final result has checked for denied actions.
                  if (status === 'running' && typeof options.onNativeAction === 'function') {
                    const parameters = rawParams && typeof rawParams === 'object'
                      ? rawParams as Record<string, unknown>
                      : {};
                    options.onNativeAction({ ...action, parameters });
                  }
                }
              }
              if (delta && typeof delta === 'string') {
                if (stepType === 'thought' || stepType === 'agent_thought') {
                  if (typeof options.onReasoningChunk === 'function') {
                    options.onReasoningChunk(delta);
                  }
                } else {
                  if (sawToolAfterLastText && streamedResponse.length > 0 && !/\s$/.test(streamedResponse) && !/^\s/.test(delta)) {
                    streamedResponse += '\n';
                    if (typeof options.onChunk === 'function') {
                      options.onChunk('\n');
                    }
                  }
                  if (delta.trim().length > 0) {
                    sawToolAfterLastText = false;
                  }
                  streamedResponse += delta;
                  if (typeof options.onChunk === 'function') {
                    options.onChunk(delta);
                  }
                }
              }
            } else if (event.event === 'result') {
              finalResultObj = event.result;
              if (event.result?.conversation_id) {
                this.currentConversationId = event.result.conversation_id;
              }
            } else if (event.status === 'ERROR') {
              if (useConversation) this.currentConversationId = null;
              safeReject(new Error(`Antigravity Agent returned error: ${event.error || 'Unknown error'}`));
              return;
            }
          } catch {
            // Non-JSON line (fallback log)
          }
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderrBuffer += chunk;
      });

      child.on('error', (err: Error) => {
        if (useConversation) this.currentConversationId = null;
        safeReject(new Error(`Antigravity Agent (agy) spawn error: ${err.message}. Make sure Antigravity CLI is installed.`));
      });

      child.on('close', (code: number | null) => {
        childClosed = true;
        // A budget or user abort has already settled this call. Do not accept
        // a late result from the terminated process as a resumable session.
        if (isSettled) return;
        // Process any remaining bytes in stdoutBuffer
        if (stdoutBuffer.trim()) {
          try {
            const event = JSON.parse(stdoutBuffer.trim());
            if (event.event === 'result') {
              finalResultObj = event.result;
              if (event.result?.conversation_id) {
                this.currentConversationId = event.result.conversation_id;
              }
            } else if (event.status === 'ERROR') {
              if (useConversation) this.currentConversationId = null;
              safeReject(new Error(`Antigravity Agent returned error: ${event.error || 'Unknown error'}`));
              return;
            }
          } catch {
            // ignore
          }
        }

        if (code !== 0 || (finalResultObj?.status && finalResultObj.status !== 'SUCCESS')) {
          if (useConversation) this.currentConversationId = null;
          const errDetail = finalResultObj?.error || stderrBuffer.trim() ||
            `terminal status ${finalResultObj?.status || 'unknown'}, exit code ${code}`;
          safeReject(new Error(`Antigravity Agent (agy) failed: ${errDetail}`));
          return;
        }

        let rawContent = (finalResultObj?.response || streamedResponse || '').trim();
        let extractedReasoning = finalResultObj?.reasoning || finalResultObj?.thought || '';

        // Extract <thought> or <thinking> blocks if present in rawContent
        const thoughtMatch = /<(?:thought|thinking)>([\s\S]*?)<\/(?:thought|thinking)>/i.exec(rawContent);
        if (thoughtMatch && thoughtMatch[1]) {
          extractedReasoning = (extractedReasoning ? extractedReasoning + '\n' : '') + thoughtMatch[1].trim();
          rawContent = rawContent.replace(/<(?:thought|thinking)>[\s\S]*?<\/(?:thought|thinking)>/gi, '').trim();
        }

        const toolCalls = this.extractToolCalls(rawContent);

        // Strip tool call tags from prose so raw XML does not leak into chat display
        let content = rawContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();

        const deniedActions: any[] = Array.isArray(finalResultObj?.denied_actions)
          ? finalResultObj.denied_actions : [];
        const normalizeAction = (value: unknown): string =>
          String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const deniedNames = new Set(deniedActions.flatMap(action =>
          [normalizeAction(action?.action), normalizeAction(action?.display_name)]).filter(Boolean));
        for (const action of nativeActions) {
          if (deniedNames.has(normalizeAction(action.name))) action.status = 'failed';
          if (typeof options.onNativeAction === 'function') {
            const attempt = [...attemptedNativeTools].reverse().find(candidate =>
              normalizeAction(candidate.name) === normalizeAction(action.name));
            options.onNativeAction({ ...action, parameters: attempt?.parameters || {} });
          }
        }

        if (deniedActions.length > 0) {
          const unmapped: string[] = [];
          for (const denied of deniedActions) {
            const name = String(denied?.action || denied?.display_name || 'unknown');
            const attempt = [...attemptedNativeTools].reverse().find(candidate =>
              normalizeAction(candidate.name) === normalizeAction(name)
              || normalizeAction(candidate.name) === normalizeAction(denied?.display_name));
            const parameters = {
              ...(attempt?.parameters || {}),
              ...(denied?.parameters || {}),
              ...(attempt?.detail ? { detail: attempt.detail } : {})
            };
            const mapped = mapNativeToolToCausyne(attempt?.name || String(denied?.display_name || name), parameters, toolCalls.length);
            if (!mapped) {
              unmapped.push(String(denied?.display_name || name));
              continue;
            }
            if (!toolCalls.some(call => call.function.name === mapped.function.name
              && call.function.arguments === mapped.function.arguments)) {
              toolCalls.push(mapped);
            }
          }
          if (unmapped.length > 0) {
            const error = new Error(`Antigravity could not perform: ${unmapped.join(', ')}. The denied action had no safe Causyne tool mapping.`) as Error & { code: string };
            error.code = 'AGY_NATIVE_ACTION_DENIED';
            safeReject(error);
            return;
          }
          // Any prose produced alongside a denied action may claim work that
          // did not occur. Wait for the mapped Causyne tool result instead.
          content = '';
        }

        const completedNativeActions = nativeActions.filter((a: ChatResponseAction) => a.status === 'completed');

        if (!content && completedNativeActions.length > 0) {
          content = `Antigravity completed: ${completedNativeActions
            .map((a: ChatResponseAction) => `${a.name}${a.detail ? ` (${a.detail})` : ''}`)
            .join(', ')}`;
        }

        if (!content && toolCalls.length === 0) {
          const detail = stderrBuffer.trim();
          safeReject(new Error(detail
            ? `Antigravity returned no response: ${detail}`
            : 'Antigravity returned no response.'));
          return;
        }

        const timedOutMidTurn = /print timeout after .* with turn in progress|returning partial output/i.test(stderrBuffer);
        const finalResponseText = typeof finalResultObj?.response === 'string' ? finalResultObj.response.trim() : '';
        const endedAfterToolWithoutFinalResponse =
          sawToolAfterLastText && !finalResponseText && deniedActions.length === 0 && toolCalls.length === 0;
        const missingResultEvent =
          finalResultObj === null && deniedActions.length === 0 && toolCalls.length === 0;

        const usageIsReported = finalResultObj?.usage?.input_tokens != null
          && finalResultObj?.usage?.output_tokens != null
          && Number.isFinite(Number(finalResultObj.usage.input_tokens))
          && Number.isFinite(Number(finalResultObj.usage.output_tokens));
        const cumulative = {
          input: usageIsReported ? Number(finalResultObj.usage.input_tokens) : Math.ceil(promptText.length / 4),
          output: usageIsReported ? Number(finalResultObj.usage.output_tokens) : Math.ceil(rawContent.length / 4),
          thinking: Number(finalResultObj?.usage?.thinking_tokens) || 0,
          cacheRead: Number(finalResultObj?.usage?.cache_read_tokens) || 0
        };
        const prior = useConversation && resumedConversationId === this.lastCumulativeUsage?.conversationId
          ? this.lastCumulativeUsage : null;
        const delta = (current: number, previous: number): number => current >= previous ? current - previous : current;
        const promptTokens = prior && usageIsReported ? delta(cumulative.input, prior.input) : cumulative.input;
        const completionTokens = prior && usageIsReported ? delta(cumulative.output, prior.output) : cumulative.output;
        const thinkingTokens = prior && usageIsReported ? delta(cumulative.thinking, prior.thinking) : cumulative.thinking;
        const cachedPromptTokens = prior && usageIsReported ? delta(cumulative.cacheRead, prior.cacheRead) : cumulative.cacheRead;

        const response: ChatResponse = {
          content,
          usage: {
            promptTokens,
            completionTokens,
            thinkingTokens,
            cachedPromptTokens,
            measurement: usageIsReported ? 'provider_reported' : 'text_estimate',
            cacheMeasurement: finalResultObj?.usage?.cache_read_tokens != null
              ? 'provider_reported' : 'unavailable'
          }
        };

        if (extractedReasoning) {
          response.reasoningContent = extractedReasoning;
        }

        if (toolCalls.length > 0) {
          response.toolCalls = toolCalls;
        }

        if (nativeActions.length > 0) {
          response.externalActions = nativeActions.filter((a: ChatResponseAction) => a.status !== 'running');
        }

        if (timedOutMidTurn || endedAfterToolWithoutFinalResponse || missingResultEvent) {
          response.incompleteTurn = true;
        }

        if (usageIsReported && this.currentConversationId) {
          this.lastCumulativeUsage = { conversationId: this.currentConversationId, ...cumulative };
        }
        safeResolve(response);
      });
    });
  }

  override async chat(messages: any[], options: ChatOptions = {}): Promise<ChatResponse> {
    const maxRetries = options.maxRetries ?? ((options as any).taskIntent === 'launch' ? 1 : 2);
    let attempt = 0;
    while (attempt <= maxRetries) {
      const hadConversation = Boolean(this.currentConversationId);
      try {
        return await this._executeOnce(messages, options);
      } catch (err: any) {
        if (options.signal?.aborted || err?.name === 'AbortError') {
          throw err;
        }
        if (err?.partialUsage?.promptTokens + err?.partialUsage?.completionTokens > 0) {
          throw err;
        }
        const canRetryResetConversation =
          hadConversation && !this.currentConversationId
          && (err as any)?.code !== 'AGY_NATIVE_ACTION_DENIED'
          && (err as any)?.code !== 'AGY_TOKEN_BUDGET';
        if (attempt < maxRetries && (this._isTransientError(err.message) || canRetryResetConversation)) {
          attempt++;
          const delay = attempt * 1200;
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw new Error('Antigravity execution failed after maximum retries.');
  }
}
