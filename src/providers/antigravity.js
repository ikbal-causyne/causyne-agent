import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LLMProvider } from './base.js';

export const ANTIGRAVITY_MODELS = [
  'Gemini 3.8 Flash (Low)',
  'Gemini 3.8 Flash (Medium)',
  'Gemini 3.8 Flash (High)',
  'Gemini 4 Argon (Low)',
  'Gemini 4 Argon (Medium)',
  'Gemini 4 Argon (High)',
  'Claude Sonnet 5.5 (Low)',
  'Claude Sonnet 5.5 (Medium)',
  'Claude Sonnet 5.5 (High)',
  'Claude Opus 5.5 (Low)',
  'Claude Opus 5.5 (Medium)',
  'Claude Opus 5.5 (High)',
  'GPT-OSS 120B (Medium)'
];

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
    this.visionModels = ['*'];
    this.audioModels = [];
  }

  formatConversation(messages, tools = []) {
    const lines = [];
    if (tools && tools.length > 0) {
      lines.push('[Available Tools]\nYou may invoke tools by outputting `<tool_call>{"name": "tool_name", "arguments": {...}}</tool_call>`.');
    }
    for (const msg of messages) {
      const role = msg.role === 'user' ? 'User' : (msg.role === 'assistant' ? 'Assistant' : (msg.role === 'system' ? 'System Instructions' : 'Context'));
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content.map(c => typeof c === 'string' ? c : (c?.text || '')).filter(Boolean).join('\n');
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
        if (parsed.name) {
          calls.push({
            id: `agy_call_${Date.now()}_${index++}`,
            type: 'function',
            function: {
              name: parsed.name,
              arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments || {})
            }
          });
        }
      } catch {
        // ignore malformed tool_call blocks
      }
    }
    return calls;
  }

  async chat(messages, options = {}) {
    const promptText = this.formatConversation(messages, options.tools);

    const args = [
      '--output-format',
      'json',
      '--model',
      this.model,
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

          const content = (parsed.response || '').trim();
          const toolCalls = this.extractToolCalls(content);

          const promptTokens = Number(parsed.usage?.input_tokens) || Math.ceil(promptText.length / 4);
          const completionTokens = Number(parsed.usage?.output_tokens) || Math.ceil(content.length / 4);
          const thinkingTokens = Number(parsed.usage?.thinking_tokens) || 0;

          const response = {
            content: content || 'Turn completed by Antigravity Agent.',
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
}
