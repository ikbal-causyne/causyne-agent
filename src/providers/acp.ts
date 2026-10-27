import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { saveCachedModels } from '../dynamicCatalogue.js';
import { LLMProvider, type ProviderConfig, type ChatOptions, type ChatResponse, type ChatResponseToolCall, type ChatResponseAction } from './base.js';
import { AcpClient } from '../acp/client.js';
import { getPeerProfile } from '../acp/peerProfiles.js';
import { BUILTIN_PEER_PRESETS } from '../acp/agentCatalog.js';
import type { RequestPermissionRequest, SessionUpdate } from '../acp/protocol.js';

export function isAcpProvider(provider?: string | null): boolean {
  if (!provider) return false;
  const p = String(provider).toLowerCase();
  return p === 'acp' || p.startsWith('acp/') || p.startsWith('acp:') ||
    ['opencode', 'claude', 'codex', 'cursor', 'hermes', 'goose', 'copilot'].includes(p);
}

export class AcpProvider extends LLMProvider {
  peerId: string;
  command: string;
  args: string[];
  private activeClient: AcpClient | null = null;
  private activeSessionId: string | null = null;
  private currentTurnAborted = false;
  private currentTurnChunkHandler: ((chunk: string) => void) | null = null;
  private currentTurnReasoningHandler: ((chunk: string) => void) | null = null;
  private currentTurnNativeActionHandler: ((action: ChatResponseAction) => void) | null = null;
  private readonly liveFileActions = new Map<string, ChatResponseAction>();

  constructor(config: ProviderConfig = {}) {
    super(config);

    const providerStr = String(config.provider || '').toLowerCase().trim();
    const configuredModel = typeof config.model === 'string' ? config.model.trim() : '';
    let resolvedPeer = '';
    if (providerStr.startsWith('acp/') || providerStr.startsWith('acp:')) {
      resolvedPeer = providerStr.slice(4).split('/')[0] || '';
    } else if (providerStr && providerStr !== 'acp') {
      resolvedPeer = providerStr;
    } else if (config.peer) {
      resolvedPeer = String(config.peer).toLowerCase();
    } else if (configuredModel && configuredModel !== 'acp' && (BUILTIN_PEER_PRESETS as Record<string, any>)[configuredModel.toLowerCase()]) {
      resolvedPeer = configuredModel.toLowerCase();
    }
    this.peerId = resolvedPeer || 'opencode';

    const peerDefault = (DEFAULT_MODEL_BY_PROVIDER as Record<string, string>)[`acp/${this.peerId}`]
      || (DEFAULT_MODEL_BY_PROVIDER as Record<string, string>)[`acp`]
      || this.peerId;
    const modelIsPeerName = !configuredModel || configuredModel === 'acp' || configuredModel === this.peerId;
    this.model = canonicalModelId(modelIsPeerName ? peerDefault : configuredModel);

    const profile = getPeerProfile(this.peerId);
    if (config.command) {
      this.command = config.command;
      this.args = config.args || ['acp'];
    } else if (profile) {
      this.command = profile.command;
      this.args = profile.args || [];
    } else {
      const preset = (BUILTIN_PEER_PRESETS as Record<string, any>)[this.peerId];
      if (preset) {
        this.command = preset.command;
        this.args = preset.args || [];
      } else {
        this.command = this.peerId;
        this.args = config.args || ['acp'];
      }
    }

    this.visionModels = ['*'];
    this.audioModels = [];
  }

  formatConversation(messages: any[], tools: any[] = []): string {
    const lines: string[] = [];
    lines.push('[System Instructions]\nYou are acting as an AI reasoning engine for Causyne Agent over ACP. Do NOT invoke your own internal host CLI tools or execute commands directly. When an action or tool is required, output an explicit tool call in this exact format:\n<tool_call>{"name": "tool_name", "arguments": { ... }}</tool_call>\nCausyne Agent will execute the tool in its secure environment and return the results back to you.\n\n[Language & Communication Directive]\nCommunicate strictly in English. Default to English for all responses and reasoning.');

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
    const seenToolOutputs = new Set<string>();
    const seenAssistantCalls = new Set<string>();
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
        text = msg.content.map((c: any) => typeof c === 'string' ? c : (c?.text || '')).filter(Boolean).join('\n');
      }

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

  formatPromptBlocks(messages: any[], tools: any[] = [], imageSupport = false): any[] {
    const blocks: any[] = [];
    let pending: string[] = [];
    const flush = () => {
      if (pending.length === 0) return;
      blocks.push({ type: 'text', text: pending.join('\n\n') });
      pending = [];
    };

    pending.push('[System Instructions]\nYou are acting as an AI reasoning engine for Causyne Agent over ACP. Do NOT invoke your own internal host CLI tools or execute commands directly. When an action or tool is required, output an explicit tool call in this exact format:\n<tool_call>{"name": "tool_name", "arguments": { ... }}</tool_call>\nCausyne Agent will execute the tool in its secure environment and return the results back to you.');

    if (tools && tools.length > 0) {
      const toolSummaries = tools.map(t => {
        const name = t.name || t.function?.name || 'unknown';
        const desc = t.description || t.function?.description || '';
        const params = t.parameters || t.input_schema || t.function?.parameters || {};
        const paramKeys = Object.keys(params.properties || {}).join(', ');
        return `- ${name}(${paramKeys}): ${desc}`;
      }).join('\n');
      pending.push(`[Available Tools]\nYou may invoke tools when needed by outputting:\n<tool_call>{"name": "tool_name", "arguments": { ... }}</tool_call>\n\n${toolSummaries}`);
    }

    const seenToolOutputs = new Set<string>();
    const seenAssistantCalls = new Set<string>();
    for (const msg of messages) {
      const role = this._roleLabel(msg);
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content.map((c: any) => typeof c === 'string' ? c : (c?.text || '')).filter(Boolean).join('\n');
      }

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
        pending.push(`[${role}]\n${text.trim()}`);
      }

      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          const image = this._imageBlock(part);
          if (!image) continue;
          flush();
          if (imageSupport) {
            blocks.push(image);
          } else {
            pending.push(`[Image omitted — ${this.peerId} does not accept image input]`);
          }
        }
      }
    }

    flush();
    return blocks.length > 0 ? blocks : [{ type: 'text', text: 'Continue.' }];
  }

  private _roleLabel(msg: any): string {
    if (msg.role === 'user') return 'User';
    if (msg.role === 'assistant') return 'Assistant';
    if (msg.role === 'system') return 'System Instructions';
    if (msg.role === 'tool') return `Tool Result (${msg.name || 'tool'})`;
    return 'Context';
  }

  private _imageBlock(part: any): any {
    if (!part || typeof part !== 'object') return null;
    if (part.type === 'image' && part.source?.type === 'base64') {
      return { type: 'image', mimeType: part.source.media_type, data: part.source.data };
    }
    if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
      const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) return { type: 'image', mimeType: match[1], data: match[2] };
    }
    return null;
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
            id: `acp_call_${Date.now()}_${index++}`,
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
              id: `acp_call_${Date.now()}_${index++}`,
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
                id: `acp_call_${Date.now()}_0`,
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

  private async getOrCreateClient(signal?: AbortSignal): Promise<{ client: AcpClient; sessionId: string }> {
    if (signal?.aborted) {
      const abortErr = new Error('ACP request aborted by user');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    if (this.activeClient && this.activeSessionId) {
      return { client: this.activeClient, sessionId: this.activeSessionId };
    }

    const client = new AcpClient({
      command: this.command,
      args: this.args,
      cwd: process.cwd(),
      promptTimeoutMs: 900_000,
      permissionHandler: async (req: RequestPermissionRequest) => {
        if (this.currentTurnAborted || signal?.aborted) return { outcome: 'cancelled' };
        const allowOpt = req.options?.find(o => o.kind === 'allow_once' || o.kind === 'allow_always' || o.optionId === 'allow');
        if (allowOpt) return { outcome: 'selected', optionId: allowOpt.optionId };
        return { outcome: 'cancelled' };
      },
      onUpdate: (_sessionId: string, update: SessionUpdate) => {
        if (this.currentTurnAborted) return;
        if (update && typeof update === 'object') {
          const updateObj = update as any;
          if (updateObj.sessionUpdate === 'agent_thought_chunk') {
            const thought = updateObj.content?.text || updateObj.thought || (typeof updateObj.content === 'string' ? updateObj.content : '');
            if (thought && this.currentTurnReasoningHandler) {
              this.currentTurnReasoningHandler(thought);
            }
          } else if (updateObj.sessionUpdate === 'agent_message_chunk') {
            const text = updateObj.content?.type === 'text' ? updateObj.content.text : '';
            if (text && this.currentTurnChunkHandler) this.currentTurnChunkHandler(text);
          } else if (updateObj.sessionUpdate === 'tool_call' || updateObj.sessionUpdate === 'tool_call_update') {
            const id = String(updateObj.toolCallId || '');
            const earlier = this.liveFileActions.get(id);
            const kind = updateObj.kind || (earlier?.name === 'fs_edit' ? 'edit' : earlier?.name === 'fs_delete' ? 'delete' : earlier?.name === 'fs_move' ? 'move' : '');
            const name = kind === 'edit' ? 'fs_edit' : kind === 'delete' ? 'fs_delete' : kind === 'move' ? 'fs_move' : '';
            if (name && id) {
              const diff = Array.isArray(updateObj.content)
                ? updateObj.content.find((item: any) => item?.type === 'diff')
                : null;
              const input = updateObj.rawInput && typeof updateObj.rawInput === 'object' ? updateObj.rawInput : {};
              const parameters: Record<string, unknown> = {
                ...(earlier?.parameters || {}), ...input,
                ...(diff?.path ? { path: diff.path } : {}),
                ...(diff?.newText ? { content: diff.newText } : {}),
                ...(updateObj.locations?.[0]?.path ? { path: updateObj.locations[0].path } : {})
              };
              const status = updateObj.status === 'completed' ? 'completed' : updateObj.status === 'failed' ? 'failed' : 'running';
              const action: ChatResponseAction = { name, status, parameters,
                detail: String(parameters.path || updateObj.title || '') };
              if (status === 'running') this.liveFileActions.set(id, action);
              else this.liveFileActions.delete(id);
              this.currentTurnNativeActionHandler?.(action);
            }
          } else if ('textDelta' in updateObj) {
            const delta = updateObj.textDelta;
            if (delta && typeof delta === 'string' && this.currentTurnChunkHandler) {
              this.currentTurnChunkHandler(delta);
            }
          }
        }
      }
    });

    await client.start(signal);
    const sessionId = await client.newSession(process.cwd(), [], signal);

    const sessionModels = client.getSessionModels(sessionId);
    const liveModels = sessionModels.availableModels;
    if (liveModels.length > 0 && !process.env.NODE_TEST_CONTEXT) {
      saveCachedModels(`acp/${this.peerId}`, liveModels, {
        ...(sessionModels.currentModelId ? { currentModel: sessionModels.currentModelId } : {})
      });
    }

    let targetModel = this.model;
    if (this.peerId === 'opencode' && targetModel !== this.peerId && !targetModel.includes('/')) {
      targetModel = `opencode/${targetModel}`;
    }

    if (liveModels.length > 0 && targetModel && !liveModels.includes(targetModel)) {
      const matched = liveModels.find(
        (m) => m.toLowerCase() === targetModel.toLowerCase() || m.endsWith(`/${targetModel}`)
      );
      if (matched) {
        targetModel = matched;
        this.model = matched;
      } else {
        const staticDefault = (DEFAULT_MODEL_BY_PROVIDER as Record<string, string>)[`acp/${this.peerId}`];
        if (targetModel === staticDefault || targetModel === this.peerId || targetModel === 'acp') {
          targetModel = sessionModels.currentModelId || liveModels[0]!;
          this.model = targetModel;
        }
      }
    }

    if (targetModel && targetModel !== 'acp' && targetModel !== this.peerId) {
      try {
        await client.setSessionModel(sessionId, targetModel, signal);
      } catch (err: any) {
        if (this.currentTurnAborted || signal?.aborted || err?.name === 'AbortError') {
          await client.close();
          throw err;
        }
        // If the requested model is unavailable on the user's current account/tier,
        // gracefully fall back to the peer's active or first advertised live model.
        const fallbackModel = sessionModels.currentModelId || liveModels[0];
        if (fallbackModel && fallbackModel !== targetModel) {
          this.model = fallbackModel;
          try {
            await client.setSessionModel(sessionId, fallbackModel, signal);
          } catch {
            // Peer already defaults to its own active session model
          }
        }
      }
    }

    this.activeClient = client;
    this.activeSessionId = sessionId;
    return { client, sessionId };
  }

  abort(): void {
    this.currentTurnAborted = true;
    this.currentTurnChunkHandler = null;
    this.currentTurnReasoningHandler = null;
    this.currentTurnNativeActionHandler = null;
    this.liveFileActions.clear();
    if (this.activeClient && this.activeSessionId) {
      try {
        this.activeClient.notifyCancel(this.activeSessionId);
      } catch {
        // ignore cancel write error
      }
    }
    void this.close();
  }

  async close(): Promise<void> {
    const client = this.activeClient;
    this.activeClient = null;
    this.activeSessionId = null;
    if (client) {
      try {
        await client.close();
      } catch {
        // ignore close error
      }
    }
  }

  override async chat(messages: any[], options: ChatOptions = {}): Promise<ChatResponse> {
    this.currentTurnAborted = Boolean(options.signal?.aborted);
    if (this.currentTurnAborted) {
      const abortErr = new Error('ACP request aborted by user');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    this.currentTurnChunkHandler = options.onChunk || null;
    this.currentTurnReasoningHandler = options.onReasoningChunk || null;
    this.currentTurnNativeActionHandler = options.onNativeAction || null;
    this.liveFileActions.clear();
    const onAbort = (): void => {
      this.abort();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const { client, sessionId } = await this.getOrCreateClient(options.signal);

      const supportsImages = client.agentCapabilities?.promptCapabilities?.image === true;
      const promptBlocks = this.formatPromptBlocks(messages, options.tools, supportsImages);
      const promptText = promptBlocks.filter(b => b.type === 'text').map(b => b.text).join('\n\n');

      let result;
      try {
        result = await client.prompt(sessionId, promptBlocks, options.signal);
      } catch (promptErr: any) {
        if (this.currentTurnAborted || options.signal?.aborted || promptErr?.name === 'AbortError') {
          throw promptErr;
        }
        // If peer failed before any user abort, try recreating client once in case connection dropped
        await this.close();
        const fresh = await this.getOrCreateClient(options.signal);
        result = await fresh.client.prompt(fresh.sessionId, promptBlocks, options.signal);
      }

      if (this.currentTurnAborted || options.signal?.aborted) {
        const abortErr = new Error('ACP request aborted by user');
        abortErr.name = 'AbortError';
        throw abortErr;
      }

      let rawContent = (result?.text || '').trim();
      const toolCalls = this.extractToolCalls(rawContent);

      // Strip tool call XML from chat content display
      let content = rawContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();

      const response: ChatResponse = {
        content: content || (toolCalls.length > 0 ? '' : `Turn completed by ${this.peerId} over ACP.`),
        usage: {
          promptTokens: Math.ceil(promptText.length / 4),
          completionTokens: Math.ceil(rawContent.length / 4),
          cachedPromptTokens: 0,
          measurement: 'text_estimate',
          cacheMeasurement: 'unavailable'
        }
      };
      if (toolCalls.length > 0) {
        response.toolCalls = toolCalls;
      }
      if (result?.stopReason === 'max_tokens' || result?.stopReason === 'max_turn_requests') {
        response.incompleteTurn = true;
      }
      return response;
    } catch (err: any) {
      await this.close();
      if (this.currentTurnAborted || options.signal?.aborted || err?.name === 'AbortError') {
        const abortErr = new Error('ACP request aborted by user');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`ACP Peer Agent (${this.peerId}) Error: ${msg}. Make sure "${this.command}" is installed and running.`);
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      this.currentTurnChunkHandler = null;
      this.currentTurnReasoningHandler = null;
      this.currentTurnNativeActionHandler = null;
      this.liveFileActions.clear();
    }
  }
}
