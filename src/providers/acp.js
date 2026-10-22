import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider } from './base.js';
import { AcpClient } from '../acp/client.js';
import { getPeerProfile } from '../acp/peerProfiles.js';
import { BUILTIN_PEER_PRESETS } from '../acp/agentCatalog.js';

export function isAcpProvider(provider) {
  if (!provider) return false;
  const p = String(provider).toLowerCase();
  return p === 'acp' || p.startsWith('acp/') || p.startsWith('acp:') ||
    ['opencode', 'claude', 'codex', 'cursor', 'hermes', 'goose', 'copilot'].includes(p);
}

export class AcpProvider extends LLMProvider {
  constructor(config = {}) {
    super(config);
    const rawModel = config.model || DEFAULT_MODEL_BY_PROVIDER['acp'] || 'opencode';
    this.model = canonicalModelId(rawModel);

    // Resolve peer identifier from provider or model (e.g. acp/opencode -> opencode)
    const providerStr = String(config.provider || '').toLowerCase();
    let resolvedPeer = 'opencode';
    if (providerStr.startsWith('acp/') || providerStr.startsWith('acp:')) {
      resolvedPeer = providerStr.slice(4);
    } else if (providerStr !== 'acp' && providerStr !== '') {
      resolvedPeer = providerStr;
    } else if (config.peer) {
      resolvedPeer = String(config.peer).toLowerCase();
    } else if (this.model && this.model !== 'acp') {
      resolvedPeer = this.model.toLowerCase();
    }

    this.peerId = resolvedPeer;

    const profile = getPeerProfile(this.peerId);
    if (profile) {
      this.command = profile.command;
      this.args = profile.args || [];
    } else {
      const preset = BUILTIN_PEER_PRESETS[this.peerId];
      if (preset) {
        this.command = preset.command;
        this.args = preset.args || [];
      } else {
        this.command = config.command || this.peerId;
        this.args = config.args || ['acp'];
      }
    }

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
            id: `acp_call_${Date.now()}_${index++}`,
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
    const client = new AcpClient({
      command: this.command,
      args: this.args,
      cwd: process.cwd(),
      promptTimeoutMs: 180_000,
      permissionHandler: async (req) => {
        // Auto-approve peer permissions (allow once / allow always)
        const allowOpt = req.options?.find(o => o.kind === 'allow_once' || o.kind === 'allow_always' || o.optionId === 'allow');
        if (allowOpt) return { outcome: 'selected', optionId: allowOpt.optionId };
        return { outcome: 'cancelled' };
      }
    });

    try {
      await client.start();
      const sessionId = await client.newSession(process.cwd());

      let targetModel = this.model;
      if (this.peerId === 'opencode') {
        targetModel = (this.model && this.model !== 'opencode' && this.model !== 'acp')
          ? (this.model.startsWith('opencode/') ? this.model : `opencode/${this.model}`)
          : 'opencode/beam-free';
        try {
          await client.setSessionModel(sessionId, targetModel);
        } catch {
          // peer does not support setSessionModel
        }
      } else if (this.model && this.model !== 'acp' && this.model !== this.peerId) {
        try {
          await client.setSessionModel(sessionId, this.model);
        } catch {
          // peer does not support setSessionModel
        }
      }

      const promptText = this.formatConversation(messages, options.tools);
      let result;
      try {
        result = await client.prompt(sessionId, promptText);
      } catch (promptErr) {
        // If opencode failed with beam-free, attempt fallback to flint-40b-free
        if (this.peerId === 'opencode' && targetModel !== 'opencode/flint-40b-free') {
          try {
            await client.setSessionModel(sessionId, 'opencode/flint-40b-free');
            result = await client.prompt(sessionId, promptText);
          } catch {
            throw promptErr;
          }
        } else {
          throw promptErr;
        }
      }

      const content = (result?.text || '').trim();
      const toolCalls = this.extractToolCalls(content);

      const response = {
        content: content || `Turn completed by ${this.peerId} over ACP.`,
        usage: {
          promptTokens: Math.ceil(promptText.length / 4),
          completionTokens: Math.ceil((content || '').length / 4),
          cachedPromptTokens: 0
        }
      };
      if (toolCalls.length > 0) {
        response.toolCalls = toolCalls;
      }
      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`ACP Peer Agent (${this.peerId}) Error: ${msg}. Make sure "${this.command}" is installed and running.`);
    } finally {
      await client.close();
    }
  }
}
