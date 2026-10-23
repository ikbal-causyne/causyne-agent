import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LLMProvider } from './base.js';

/**
 * Display label → the id `agy --model` actually accepts, exactly as reported
 * by `agy models`. The CLI exposes slugs; the picker shows the readable label.
 * Passing the label through unchanged is what a user would try, so both forms
 * resolve here rather than failing at the provider.
 */
export const ANTIGRAVITY_MODEL_IDS = {
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

export const ANTIGRAVITY_LABEL_BY_ID = Object.fromEntries(
  Object.entries(ANTIGRAVITY_MODEL_IDS).map(([label, id]) => [id, label])
);

export const ANTIGRAVITY_MODELS = Object.keys(ANTIGRAVITY_MODEL_IDS);

export function resolveAgyModelId(model) {
  if (typeof model !== 'string') return '';
  const trimmed = model.trim();
  return ANTIGRAVITY_MODEL_IDS[trimmed] || trimmed;
}

export function isAntigravityProvider(provider) {
  if (!provider) return false;
  const p = String(provider).toLowerCase();
  return p === 'antigravity' || p === 'agy' || p.startsWith('antigravity/') || p.startsWith('agy/');
}

export function resolveAgyBinary() {
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

export class AntigravityProvider extends LLMProvider {
  constructor(config = {}) {
    super(config);
    this.model = config.model || 'Gemini 3.8 Flash (Low)';
    this.command = config.command || resolveAgyBinary();
    // The agy print path takes text only — no image flag is documented, and the
    // formatter below drops image blocks. Claiming vision here would let the
    // agent believe a screenshot was seen when it never left the machine.
    this.visionModels = [];
    this.audioModels = [];
  }

  formatConversation(messages, tools = []) {
    const lines = [];
    lines.push(`[System Instructions]\nYou are acting as an AI reasoning engine for Causyne Agent. Do NOT invoke your own internal host CLI tools or execute commands directly. When an action or tool is required, output an explicit tool call in this exact format:\n<tool_call>{"name": "tool_name", "arguments": { ... }}</tool_call>\nCausyne Agent will execute the tool in its secure environment and return the results back to you.`);

    if (tools && tools.length > 0) {
      const toolSummaries = tools.map(t => {
        const name = t.name || t.function?.name || 'unknown';
        const desc = t.description || t.function?.description || '';
        const params = t.parameters || t.input_schema || t.function?.parameters || {};
        const paramKeys = Object.keys(params.properties || {}).join(', ');
        return `- ${name}(${paramKeys}): ${desc}`;
      }).join('\n');
      lines.push(`[Available Tools]\nYou may invoke tools when needed by outputting:\n<tool_call>{"name": "tool_name", "arguments": { ... }}</tool_call>\n\n${toolSummaries}`);
    }
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
        text = msg.content.map(c => typeof c === 'string' ? c : (c?.text || '')).filter(Boolean).join('\n');
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

  extractToolCalls(text) {
    const calls = [];
    if (!text || typeof text !== 'string') return calls;
    const regex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    let match;
    let index = 0;
    while ((match = regex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1].trim());
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
          const parsed = JSON.parse(match[1].trim());
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

    return calls;
  }

  _isTransientError(errMessage) {
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

  async _executeOnce(messages, options = {}) {
    const promptText = this.formatConversation(messages, options.tools);

    const args = [
      '--output-format',
      'json',
      '--dangerously-skip-permissions',
      '--model',
      resolveAgyModelId(this.model),
      `-p=${promptText}`
    ];

    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, {
        cwd: process.cwd(),
        env: process.env,
        windowsHide: true
      });

      let stdout = '';
      let stderr = '';

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr += chunk; });

      child.on('error', err => {
        reject(new Error(`Antigravity Agent (agy) spawn error: ${err.message}. Make sure Antigravity CLI is installed.`));
      });

      child.on('close', code => {
        const rawOut = stdout.trim();
        if (code !== 0 && !rawOut) {
          const errDetail = stderr.trim() || `exit code ${code}`;
          reject(new Error(`Antigravity Agent (agy) failed: ${errDetail}`));
          return;
        }

        try {
          const parsed = JSON.parse(rawOut);
          if (parsed.status === 'ERROR') {
            reject(new Error(`Antigravity Agent returned error: ${parsed.error || 'Unknown error'}`));
            return;
          }

          let rawContent = (parsed.response || '').trim();
          const toolCalls = this.extractToolCalls(rawContent);

          // Strip tool call tags from prose so raw XML does not leak into chat display
          let content = rawContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();

          // If content is empty and denied_actions is present, describe it
          if (!content && Array.isArray(parsed.denied_actions) && parsed.denied_actions.length > 0) {
            content = `Antigravity attempted action: ${parsed.denied_actions.map(a => a.display_name || a.action).join(', ')}`;
          }

          if (!content && toolCalls.length === 0) {
            content = 'Turn completed by Antigravity Agent.';
          }

          const promptTokens = Number(parsed.usage?.input_tokens) || Math.ceil(promptText.length / 4);
          const completionTokens = Number(parsed.usage?.output_tokens) || Math.ceil(rawContent.length / 4);
          const thinkingTokens = Number(parsed.usage?.thinking_tokens) || 0;

          const response = {
            content: content || (toolCalls.length > 0 ? '' : 'Turn completed by Antigravity Agent.'),
            usage: {
              promptTokens,
              completionTokens: completionTokens + thinkingTokens,
              cachedPromptTokens: Number(parsed.usage?.cache_read_tokens) || 0
            }
          };

          if (toolCalls.length > 0) {
            response.toolCalls = toolCalls;
          }

          resolve(response);
        } catch {
          // If non-JSON returned, wrap raw output
          const content = rawOut || stderr.trim();
          resolve({
            content: content || 'Turn completed by Antigravity Agent.',
            usage: {
              promptTokens: Math.ceil(promptText.length / 4),
              completionTokens: Math.ceil((content || '').length / 4),
              cachedPromptTokens: 0
            }
          });
        }
      });
    });
  }

  async chat(messages, options = {}) {
    const maxRetries = options.maxRetries ?? 2;
    let attempt = 0;
    while (attempt <= maxRetries) {
      try {
        return await this._executeOnce(messages, options);
      } catch (err) {
        if (attempt < maxRetries && this._isTransientError(err.message)) {
          attempt++;
          const delay = attempt * 1200;
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  }
}
