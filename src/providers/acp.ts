import { formatToolContracts, toolContractUpdate } from './toolContracts.js';
import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { saveCachedModels } from '../dynamicCatalogue.js';
import { LLMProvider, type ProviderConfig, type ChatOptions, type ChatResponse, type ChatResponseToolCall, type ChatResponseAction } from './base.js';
import { AcpClient } from '../acp/client.js';
import { getPeerProfile } from '../acp/peerProfiles.js';
import { BUILTIN_PEER_PRESETS } from '../acp/agentCatalog.js';
import type { RequestPermissionRequest, SessionUpdate } from '../acp/protocol.js';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PEER_COLLABORATION_POLICY } from './collaborationPolicy.js';
import { extractToolCallJsonObjects, stripToolCallMarkup } from '../implementationPlan.js';

interface AcpTransportSnapshot {
  conversationId: string;
  workspaceRoot: string;
  systemHashes: string[];
  historyHashes: string[];
  toolHash: string;
  tools: unknown[];
  lastResponse: { content: string; toolCalls: ChatResponseToolCall[] };
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

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
  private currentTurnSawAction = false;
  private currentTurnChunkHandler: ((chunk: string) => void) | null = null;
  private currentTurnReasoningHandler: ((chunk: string) => void) | null = null;
  private currentTurnNativeActionHandler: ((action: ChatResponseAction) => void) | null = null;
  private currentTurnPlanHandler: ((plan: unknown) => void) | null = null;
  private readonly liveFileActions = new Map<string, ChatResponseAction>();
  private readonly turnActions = new Map<string, ChatResponseAction>();
  private turnReasoning = '';
  private transportSnapshot: AcpTransportSnapshot | null = null;
  private peerServices: ChatOptions | null = null;

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
    lines.push(
      '[System Instructions]\nYou are collaborating with Causyne Agent over the Agent Client Protocol (ACP). Use the negotiated ACP capabilities and preserve configured native tools, MCPs, skills, and project settings. When requesting workspace tools from the Causyne host, format your calls as:\n<tool_call>{"name": "tool_name", "arguments": { ... }}</tool_call>\nCausyne Agent coordinates, validates, and executes the tools in the active workspace and returns results back to you, preserving your full reasoning and ACP capabilities. ' +
      PEER_COLLABORATION_POLICY +
      '\n\n[ACP Tool Routing & Workspace Boundary Rules]\n' +
      '1. NATIVE FUNCTION CHANNEL vs CAUSYNE HOST XML CHANNEL:\n' +
      '   - Your native function-calling channel ONLY accepts your own native tools (such as `read`, `write`, `edit`, `bash`, `glob`, `grep`, `todowrite`, and configured MCP tools). Use your native tools directly for workspace file reads/writes, shell commands, and todo checklists (use `todowrite` if available instead of calling `update_plan` as a native function).\n' +
      '   - Causyne host tools listed under [Available Tools] / [Current Available Tools] (such as `browser_act`, `screenshot`, `vision_inspect_ui`, `update_plan`, `memory_write`, `ui_forge`, `astryx_oracle`, `tool_search`) are NOT registered in your native function-calling schema. NEVER invoke them as native function calls (`to=browser_act` or `to=update_plan`), NEVER call `tool_call` as a native tool, and NEVER emit dummy `bash` (`echo`) calls while trying to invoke them.\n' +
      '   - To invoke a Causyne host tool, write `<tool_call>{"name": "tool_name", "arguments": { ... }}</tool_call>` directly in your assistant text response with NO native function call in that step; Causyne will execute the host tool and return the result on the next turn.\n' +
      '2. WORKSPACE PATH BOUNDARY (NO /tmp):\n' +
      '   - Keep ALL temporary files, server logs, and headless browser screenshots inside the active workspace directory (for example, `./.shots/preview.png` or `./server.log`). NEVER write to, read from, or `cp`/`mv` paths in `/tmp` or outside the workspace root, as the host sandbox rejects `/tmp` access.\n\n[Language & Communication Directive]\nDynamically reflect and match the exact language used by the user in their prompt. Respond naturally in that same language.'
    );

    if (tools && tools.length > 0) {
      const toolSummaries = formatToolContracts(tools);
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

  formatPromptBlocks(messages: any[], tools: any[] = [], imageSupport = false, includeBridgeInstructions = true, toolContext = ''): any[] {
    const blocks: any[] = [];
    let pending: string[] = [];
    const flush = () => {
      if (pending.length === 0) return;
      blocks.push({ type: 'text', text: pending.join('\n\n') });
      pending = [];
    };

    if (includeBridgeInstructions) {
      pending.push(
        '[System Instructions]\nYou are collaborating with Causyne Agent over the Agent Client Protocol (ACP). Use the negotiated ACP capabilities and preserve configured native tools, MCPs, skills, and project settings. When requesting workspace tools from the Causyne host, format your calls as:\n<tool_call>{"name": "tool_name", "arguments": { ... }}</tool_call>\nCausyne Agent coordinates, validates, and executes the tools in the active workspace and returns results back to you, preserving your full reasoning and ACP capabilities. ' +
        PEER_COLLABORATION_POLICY +
        '\n\n[ACP Tool Routing & Workspace Boundary Rules]\n' +
        '1. NATIVE FUNCTION CHANNEL vs CAUSYNE HOST XML CHANNEL:\n' +
        '   - Your native function-calling channel ONLY accepts your own native tools (such as `read`, `write`, `edit`, `bash`, `glob`, `grep`, `todowrite`, and configured MCP tools). Use your native tools directly for workspace file reads/writes, shell commands, and todo checklists (use `todowrite` if available instead of calling `update_plan` as a native function).\n' +
        '   - Causyne host tools listed under [Current Available Tools] (such as `browser_act`, `screenshot`, `vision_inspect_ui`, `update_plan`, `memory_write`, `ui_forge`, `astryx_oracle`, `tool_search`) are NOT registered in your native function-calling schema. NEVER invoke them as native function calls (`to=browser_act` or `to=update_plan`), NEVER call `tool_call` as a native tool, and NEVER emit dummy `bash` (`echo`) calls while trying to invoke them.\n' +
        '   - To invoke a Causyne host tool, write `<tool_call>{"name": "tool_name", "arguments": { ... }}</tool_call>` directly in your assistant text response with NO native function call in that step; Causyne will execute the host tool and return the result on the next turn.\n' +
        '2. WORKSPACE PATH BOUNDARY (NO /tmp):\n' +
        '   - Keep ALL temporary files, server logs, and headless browser screenshots inside the active workspace directory (for example, `./.shots/preview.png` or `./server.log`). NEVER write to, read from, or `cp`/`mv` paths in `/tmp` or outside the workspace root, as the host sandbox rejects `/tmp` access.'
      );
    }

    if (tools && tools.length > 0) {
      const toolSummaries = formatToolContracts(tools);
      pending.push(`[Current Available Tools — this list replaces earlier tool lists]\nYou may invoke tools when needed by outputting:\n<tool_call>{"name": "tool_name", "arguments": { ... }}</tool_call>\n\n${toolSummaries}`);
    }

    if (toolContext) pending.push(toolContext);

    for (const msg of messages) {
      const role = this._roleLabel(msg);
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content.map((c: any) => typeof c === 'string' ? c : (c?.text || '')).filter(Boolean).join('\n');
      }

      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const fn = tc.function || {};
          const fnArgs = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {});
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
    let index = 0;
    for (const parsed of extractToolCallJsonObjects(text)) {
      const fnObj = parsed.function && typeof parsed.function === 'object'
        ? (parsed.function as Record<string, unknown>)
        : null;
      const name = String(parsed.name || parsed.tool || fnObj?.name || '').trim();
      if (!name) continue;
      const rawArgs = parsed.arguments !== undefined
        ? parsed.arguments
        : parsed.parameters !== undefined
          ? parsed.parameters
          : parsed.input !== undefined
            ? parsed.input
            : (fnObj?.arguments ?? {});
      calls.push({
        id: `acp_call_${Date.now()}_${index++}`,
        type: 'function',
        function: {
          name,
          arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || {})
        }
      });
    }
    return calls;
  }

  private async getOrCreateClient(signal?: AbortSignal, workspaceRoot = process.cwd()): Promise<{ client: AcpClient; sessionId: string }> {
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
      cwd: workspaceRoot,
      promptTimeoutMs: 900_000,
      allowHostTools: true,
      permissionHandler: async (req: RequestPermissionRequest) => {
        if (this.currentTurnAborted || this.peerServices?.signal?.aborted) return { outcome: 'cancelled' };
        return this.peerServices?.onPeerPermission?.(req) ?? { outcome: 'cancelled' };
      },
      fsReadHandler: async (file, options) => {
        if (!this.peerServices?.onPeerFileRead) throw new Error('The ACP client has no file-read service attached');
        const content = await this.peerServices.onPeerFileRead(file, options);
        this.currentTurnSawAction = true;
        const hasTrackedRead = [...this.turnActions.values()].some(
          a => a.name === 'fs_read' && (a.detail === file || a.parameters?.path === file)
        );
        if (!hasTrackedRead) {
          const synthId = `fs_read:${file}`;
          this.turnActions.set(synthId, {
            id: `acp:${synthId}`,
            name: 'fs_read',
            status: 'completed',
            parameters: { path: file },
            detail: file
          });
        }
        return content;
      },
      fsWriteHandler: async (file, content) => {
        if (!this.peerServices?.onPeerFileWrite) throw new Error('The ACP client has no file-write service attached');
        await this.peerServices.onPeerFileWrite(file, content);
        this.currentTurnSawAction = true;
        const hasTrackedWrite = [...this.turnActions.values()].some(
          a => (a.name === 'fs_write' || a.name === 'fs_edit') && (a.detail === file || a.parameters?.path === file)
        );
        if (!hasTrackedWrite) {
          const synthId = `fs_write:${file}`;
          this.turnActions.set(synthId, {
            id: `acp:${synthId}`,
            name: 'fs_write',
            status: 'completed',
            parameters: { path: file, content },
            detail: file
          });
        }
      },
      onUpdate: (_sessionId: string, update: SessionUpdate) => {
        if (this.currentTurnAborted) return;
        if (update && typeof update === 'object') {
          const updateObj = update as any;
          if (updateObj.sessionUpdate === 'agent_thought_chunk') {
            const thought = updateObj.content?.text || updateObj.thought || (typeof updateObj.content === 'string' ? updateObj.content : '');
            if (thought) {
              this.turnReasoning += thought;
              if (this.currentTurnReasoningHandler) {
                this.currentTurnReasoningHandler(thought);
              }
            }
          } else if (updateObj.sessionUpdate === 'agent_message_chunk') {
            const text = updateObj.content?.type === 'text' ? updateObj.content.text : '';
            if (text && this.currentTurnChunkHandler) this.currentTurnChunkHandler(text);
          } else if (updateObj.sessionUpdate === 'plan') {
            if (Array.isArray(updateObj.entries) && updateObj.entries.length > 0) {
              this.currentTurnPlanHandler?.({ entries: updateObj.entries });
            }
          } else if (updateObj.sessionUpdate === 'tool_call' || updateObj.sessionUpdate === 'tool_call_update') {
            this.currentTurnSawAction = true;
            const id = String(updateObj.toolCallId || '');
            const earlier = this.liveFileActions.get(id) || this.turnActions.get(id);
            const earlierKind = earlier?.name === 'fs_edit' ? 'edit'
              : earlier?.name === 'fs_delete' ? 'delete'
              : earlier?.name === 'fs_move' ? 'move'
              : earlier?.name === 'fs_read' ? 'read'
              : earlier?.name === 'codebase_search' ? 'search'
              : earlier?.name === 'web_fetch' ? 'fetch'
              : earlier?.name === 'sysRun' ? 'execute'
              : '';
            const kind = updateObj.kind || earlierKind;
            const rawTitle = String(updateObj.title || '').trim();
            const input = updateObj.rawInput && typeof updateObj.rawInput === 'object' ? updateObj.rawInput : {};
            const rawOutputObj = updateObj.rawOutput && typeof updateObj.rawOutput === 'object'
              ? updateObj.rawOutput as Record<string, any>
              : null;
            const hasTodoPayload = Array.isArray((input as any).todos)
              || Array.isArray((earlier?.parameters as any)?.todos)
              || Array.isArray(rawOutputObj?.todos)
              || Array.isArray(rawOutputObj?.metadata?.todos)
              || /^\d+\s+todos?$/i.test(rawTitle);
            const name = kind === 'edit' ? 'fs_edit'
              : kind === 'delete' ? 'fs_delete'
              : kind === 'move' ? 'fs_move'
              : kind === 'read' ? 'fs_read'
              : kind === 'search' ? 'codebase_search'
              : kind === 'fetch' ? 'web_fetch'
              : kind === 'execute' ? 'sysRun'
              : hasTodoPayload ? 'todowrite'
              : (earlier?.name && earlier.name !== 'provider_tool' ? earlier.name : (rawTitle || 'provider_tool'));
            if (name && id) {
              const diff = Array.isArray(updateObj.content)
                ? updateObj.content.find((item: any) => item?.type === 'diff')
                : null;
              const isInvalidPseudoTool = rawTitle.toLowerCase() === 'invalid'
                || earlier?.parameters?.__invalidTool === true
                || (typeof input.error === 'string' && input.error.length > 0 && typeof input.tool === 'string');
              if (isInvalidPseudoTool) {
                this.liveFileActions.delete(id);
                this.turnActions.delete(id);
                return;
              }
              const locationPath = updateObj.locations?.[0]?.path;
              const inputPath = typeof input.path === 'string' ? input.path
                : typeof input.filePath === 'string' ? input.filePath
                : typeof input.file === 'string' ? input.file
                : '';
              const resolvedPath = name === 'sysRun'
                ? ''
                : (diff?.path || locationPath || inputPath || (typeof earlier?.parameters?.path === 'string' ? earlier.parameters.path : ''));
              const parameters: Record<string, unknown> = {
                ...(earlier?.parameters || {}),
                ...input,
                ...(resolvedPath ? { path: resolvedPath } : {}),
                ...(diff?.newText ? { content: diff.newText } : {})
              };
              const planCandidate = Array.isArray((parameters as any).todos) ? { todos: (parameters as any).todos }
                : Array.isArray((parameters as any).plan) ? { plan: (parameters as any).plan }
                : Array.isArray(rawOutputObj?.todos) ? { todos: rawOutputObj.todos }
                : Array.isArray(rawOutputObj?.metadata?.todos) ? { todos: rawOutputObj.metadata.todos }
                : null;
              if (planCandidate) {
                this.currentTurnPlanHandler?.(planCandidate);
              }
              const commandDetail = typeof parameters.command === 'string' ? parameters.command
                : typeof parameters.cmd === 'string' ? parameters.cmd
                : '';
              const rawToolCandidate = typeof (parameters as any).tool === 'string' ? (parameters as any).tool
                : typeof (input as any).tool === 'string' ? (input as any).tool
                : '';
              const isInvalidToolAttempt = rawToolCandidate.toLowerCase() === 'invalid'
                || rawTitle.toLowerCase() === 'invalid'
                || rawTitle.toLowerCase() === 'invalid tool'
                || name.toLowerCase() === 'invalid tool'
                || name.toLowerCase() === 'invalid'
                || (typeof parameters.error === 'string' && /Model tried to call unavailable tool/i.test(parameters.error));
              if (isInvalidToolAttempt || (name === 'sysRun' && (commandDetail.trim() === 'true' || commandDetail.trim() === ':'))) {
                this.liveFileActions.delete(id);
                this.turnActions.delete(id);
                return;
              }
              const queryDetail = typeof parameters.query === 'string' ? parameters.query
                : typeof parameters.pattern === 'string' ? parameters.pattern
                : typeof parameters.url === 'string' ? parameters.url
                : '';
              const titleIsGeneric = !rawTitle
                || /^(read|write|edit|multiedit|delete|move|search|grep|glob|fetch|execute|bash|sh|zsh|terminal|provider_tool)$/i.test(rawTitle)
                || rawTitle.toLowerCase() === name.toLowerCase();
              const detail = String(
                commandDetail
                || resolvedPath
                || queryDetail
                || (!titleIsGeneric ? rawTitle : '')
                || earlier?.detail
                || ''
              );
              const status = updateObj.status === 'completed' ? 'completed' : updateObj.status === 'failed' ? 'failed' : 'running';
              const isEmptyPendingStub = updateObj.status === 'pending'
                && !detail
                && Object.keys(input).length === 0
                && !diff?.newText
                && !planCandidate;
              const action: ChatResponseAction = {
                id: `acp:${id}`,
                name,
                status,
                parameters: { ...parameters, __pendingStub: isEmptyPendingStub },
                detail
              };
              const shouldNotify = !isEmptyPendingStub && (
                !earlier
                || earlier.parameters?.__pendingStub === true
                || earlier.status !== status
                || earlier.name !== name
                || earlier.detail !== detail
                || Boolean(diff?.newText && diff.newText !== earlier?.parameters?.content)
              );
              this.turnActions.set(id, action);
              if (status === 'running') this.liveFileActions.set(id, action);
              else this.liveFileActions.delete(id);
              if (shouldNotify) {
                this.currentTurnNativeActionHandler?.(action);
              }
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
    const sessionId = await client.newSession(workspaceRoot, this.peerServices?.peerMcpServers || [], signal);

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
    this.currentTurnPlanHandler = null;
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
    this.transportSnapshot = null;
    if (client) {
      try {
        await client.close();
      } catch {
        // ignore close error
      }
    }
  }

  override async chat(messages: any[], options: ChatOptions = {}): Promise<ChatResponse> {
    this.peerServices = options;
    this.currentTurnAborted = Boolean(options.signal?.aborted);
    this.currentTurnSawAction = false;
    if (this.currentTurnAborted) {
      const abortErr = new Error('ACP request aborted by user');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    this.currentTurnChunkHandler = options.onChunk || null;
    this.currentTurnReasoningHandler = options.onReasoningChunk || null;
    this.currentTurnNativeActionHandler = options.onNativeAction || null;
    this.currentTurnPlanHandler = options.onPlanUpdate || null;
    this.liveFileActions.clear();
    this.turnActions.clear();
    this.turnReasoning = '';
    const onAbort = (): void => {
      this.abort();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const workspaceRoot = path.resolve(String(options.workspaceRoot || process.cwd()));
      const conversationId = String(options.conversationId || options.taskId || '__default__');
      const systemMessages = messages.filter(message => message.role === 'system');
      const historyMessages = messages.filter(message => message.role !== 'system');
      const systemHashes = systemMessages.map(fingerprint);
      const historyHashes = historyMessages.map(fingerprint);
      const toolHash = fingerprint(options.tools || []);
      let previous = this.transportSnapshot;

      const sessionChanged = previous && (
        previous.workspaceRoot !== workspaceRoot || previous.conversationId !== conversationId
      );
      const historyDiverged = previous && (
        historyHashes.length < previous.historyHashes.length ||
        previous.historyHashes.some((hash, index) => historyHashes[index] !== hash)
      );
      const systemShapeChanged = previous && systemHashes.length < previous.systemHashes.length;
      if (sessionChanged || historyDiverged || systemShapeChanged) {
        await this.close();
        previous = null;
      }

      const { client, sessionId } = await this.getOrCreateClient(options.signal, workspaceRoot);

      const supportsImages = client.agentCapabilities?.promptCapabilities?.image === true;
      let promptMessages = messages;
      let promptTools = options.tools || [];
      let includeBridgeInstructions = true;
      let toolContext = '';
      if (previous) {
        const changedSystem = systemMessages.filter((_, index) => systemHashes[index] !== previous.systemHashes[index]);
        const newHistory = historyMessages.slice(previous.historyHashes.length);
        // The peer already generated its previous assistant turn. AgentLoop
        // records that turn for stateless BYOK APIs; replaying it into ACP would
        // duplicate the peer's own response before the next tool result.
        const firstNew = newHistory[0];
        if (firstNew?.role === 'assistant' &&
            (firstNew.content === previous.lastResponse.content ||
             (!previous.lastResponse.content && firstNew.content === 'No final response was provided.')) &&
            fingerprint(firstNew.tool_calls || []) === fingerprint(previous.lastResponse.toolCalls)) {
          newHistory.shift();
        }
        const filteredNewHistory = newHistory.filter(
          message => !(message?.role === 'assistant' && message?.content === 'No final response was provided.' && (!message.tool_calls || message.tool_calls.length === 0))
        );
        promptMessages = [
          ...changedSystem.map(message => ({ ...message, content: `[Current system context — replaces the prior version of this section]\n${message.content}` })),
          ...filteredNewHistory
        ];
        toolContext = toolContractUpdate(options.tools || [], previous.tools);
        promptTools = [];
        includeBridgeInstructions = false;
      }
      let promptBlocks = this.formatPromptBlocks(promptMessages, promptTools, supportsImages, includeBridgeInstructions, toolContext);
      let promptText = promptBlocks.filter(b => b.type === 'text').map(b => b.text).join('\n\n');

      let result;
      try {
        result = await client.prompt(sessionId, promptBlocks, options.signal);
      } catch (promptErr: any) {
        if (this.currentTurnAborted || options.signal?.aborted || promptErr?.name === 'AbortError') {
          throw promptErr;
        }
        // Replaying after a peer executed native tools can duplicate mutations
        // and charges. Restart only before any observed native action.
        if (this.currentTurnSawAction) throw promptErr;
        // If peer failed before any user abort, try recreating client once in case connection dropped
        await this.close();
        const fresh = await this.getOrCreateClient(options.signal, workspaceRoot);
        promptBlocks = this.formatPromptBlocks(messages, options.tools, fresh.client.agentCapabilities?.promptCapabilities?.image === true);
        promptText = promptBlocks.filter(b => b.type === 'text').map(b => b.text).join('\n\n');
        result = await fresh.client.prompt(fresh.sessionId, promptBlocks, options.signal);
      }

      if (this.currentTurnAborted || options.signal?.aborted) {
        const abortErr = new Error('ACP request aborted by user');
        abortErr.name = 'AbortError';
        throw abortErr;
      }

      let rawContent = (result?.text || '').trim();
      const toolCalls = this.extractToolCalls(rawContent);

      // Strip tool call XML / DSML from chat content display
      let content = stripToolCallMarkup(rawContent);
      const externalActions = [...this.turnActions.values()].map(action => (
        action.status === 'running' ? { ...action, status: 'completed' as const } : action
      ));
      const incompleteFromActions = !content && toolCalls.length === 0 && externalActions.length > 0;
      const finalContent = content || (toolCalls.length > 0 || incompleteFromActions ? '' : `Turn completed by ${this.peerId} over ACP.`);

      this.transportSnapshot = {
        conversationId, workspaceRoot, systemHashes, historyHashes, toolHash, tools: structuredClone(options.tools || []),
        lastResponse: { content: finalContent, toolCalls }
      };

      const response: ChatResponse = {
        content: finalContent,
        usage: {
          promptTokens: Math.ceil(promptText.length / 4),
          completionTokens: Math.ceil(rawContent.length / 4),
          cachedPromptTokens: 0,
          measurement: 'text_estimate',
          cacheMeasurement: 'unavailable'
        }
      };
      if (externalActions.length > 0) {
        response.externalActions = externalActions;
      }
      if (this.turnReasoning.trim()) {
        response.reasoningContent = this.turnReasoning;
      }
      const usage = result?.usage;
      if (usage && Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0
        && Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0) {
        const safeCount = (value: number | undefined): number => Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
        const cached = safeCount(usage.cachedReadTokens);
        const writes = safeCount(usage.cachedWriteTokens);
        response.usage = {
          promptTokens: usage.inputTokens + cached + writes,
          uncachedPromptTokens: usage.inputTokens + writes,
          completionTokens: usage.outputTokens + safeCount(usage.thoughtTokens),
          cachedPromptTokens: cached,
          measurement: 'provider_reported',
          cacheMeasurement: usage.cachedReadTokens !== undefined ? 'provider_reported' : 'unavailable'
        };
      }
      if (toolCalls.length > 0) {
        response.toolCalls = toolCalls;
      }
      if (result?.stopReason === 'max_tokens' || result?.stopReason === 'max_turn_requests' || incompleteFromActions) {
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
      this.peerServices = null;
      this.currentTurnChunkHandler = null;
      this.currentTurnReasoningHandler = null;
      this.currentTurnNativeActionHandler = null;
      this.currentTurnPlanHandler = null;
      this.liveFileActions.clear();
    }
  }
}
