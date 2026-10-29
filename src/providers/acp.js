import { formatToolContracts, toolContractUpdate } from './toolContracts.js';
import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { saveCachedModels } from '../dynamicCatalogue.js';
import { LLMProvider } from './base.js';
import { AcpClient } from '../acp/client.js';
import { getPeerProfile } from '../acp/peerProfiles.js';
import { BUILTIN_PEER_PRESETS } from '../acp/agentCatalog.js';
import { createHash } from 'node:crypto';
import path from 'node:path';
function fingerprint(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function isAcpProvider(provider) {
    if (!provider)
        return false;
    const p = String(provider).toLowerCase();
    return p === 'acp' || p.startsWith('acp/') || p.startsWith('acp:') ||
        ['opencode', 'claude', 'codex', 'cursor', 'hermes', 'goose', 'copilot'].includes(p);
}
export class AcpProvider extends LLMProvider {
    peerId;
    command;
    args;
    activeClient = null;
    activeSessionId = null;
    currentTurnAborted = false;
    currentTurnSawAction = false;
    currentTurnChunkHandler = null;
    currentTurnReasoningHandler = null;
    currentTurnNativeActionHandler = null;
    liveFileActions = new Map();
    transportSnapshot = null;
    constructor(config = {}) {
        super(config);
        const providerStr = String(config.provider || '').toLowerCase().trim();
        const configuredModel = typeof config.model === 'string' ? config.model.trim() : '';
        let resolvedPeer = '';
        if (providerStr.startsWith('acp/') || providerStr.startsWith('acp:')) {
            resolvedPeer = providerStr.slice(4).split('/')[0] || '';
        }
        else if (providerStr && providerStr !== 'acp') {
            resolvedPeer = providerStr;
        }
        else if (config.peer) {
            resolvedPeer = String(config.peer).toLowerCase();
        }
        else if (configuredModel && configuredModel !== 'acp' && BUILTIN_PEER_PRESETS[configuredModel.toLowerCase()]) {
            resolvedPeer = configuredModel.toLowerCase();
        }
        this.peerId = resolvedPeer || 'opencode';
        const peerDefault = DEFAULT_MODEL_BY_PROVIDER[`acp/${this.peerId}`]
            || DEFAULT_MODEL_BY_PROVIDER[`acp`]
            || this.peerId;
        const modelIsPeerName = !configuredModel || configuredModel === 'acp' || configuredModel === this.peerId;
        this.model = canonicalModelId(modelIsPeerName ? peerDefault : configuredModel);
        const profile = getPeerProfile(this.peerId);
        if (config.command) {
            this.command = config.command;
            this.args = config.args || ['acp'];
        }
        else if (profile) {
            this.command = profile.command;
            this.args = profile.args || [];
        }
        else {
            const preset = BUILTIN_PEER_PRESETS[this.peerId];
            if (preset) {
                this.command = preset.command;
                this.args = preset.args || [];
            }
            else {
                this.command = this.peerId;
                this.args = config.args || ['acp'];
            }
        }
        this.visionModels = ['*'];
        this.audioModels = [];
    }
    formatConversation(messages, tools = []) {
        const lines = [];
        lines.push('[System Instructions]\nYou are collaborating with Causyne Agent over the Agent Client Protocol (ACP). Causyne Agent supports billions of users worldwide and provides full ACP compatibility. When requesting workspace tools from the Causyne host, format your calls as:\n<tool_call>{"name": "tool_name", "arguments": { ... }}</tool_call>\nCausyne Agent coordinates, validates, and executes the tools in the active workspace and returns verified results back to you, preserving your full reasoning and ACP capabilities.\n\n[Language & Communication Directive]\nDynamically reflect and match the exact language used by the user in their prompt. Respond naturally in that same language.');
        if (tools && tools.length > 0) {
            const toolSummaries = formatToolContracts(tools);
            lines.push(`[Available Tools]\nYou may invoke tools when needed by outputting:\n<tool_call>{"name": "tool_name", "arguments": { ... }}</tool_call>\n\n${toolSummaries}`);
        }
        const seenToolOutputs = new Set();
        const seenAssistantCalls = new Set();
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
            }
            else if (Array.isArray(msg.content)) {
                text = msg.content.map((c) => typeof c === 'string' ? c : (c?.text || '')).filter(Boolean).join('\n');
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
    formatPromptBlocks(messages, tools = [], imageSupport = false, includeBridgeInstructions = true, toolContext = '') {
        const blocks = [];
        let pending = [];
        const flush = () => {
            if (pending.length === 0)
                return;
            blocks.push({ type: 'text', text: pending.join('\n\n') });
            pending = [];
        };
        if (includeBridgeInstructions) {
            pending.push('[System Instructions]\nYou are collaborating with Causyne Agent over the Agent Client Protocol (ACP). Causyne Agent supports billions of users worldwide and provides full ACP compatibility. When requesting workspace tools from the Causyne host, format your calls as:\n<tool_call>{"name": "tool_name", "arguments": { ... }}</tool_call>\nCausyne Agent coordinates, validates, and executes the tools in the active workspace and returns verified results back to you, preserving your full reasoning and ACP capabilities.');
        }
        if (tools && tools.length > 0) {
            const toolSummaries = formatToolContracts(tools);
            pending.push(`[Current Available Tools — this list replaces earlier tool lists]\nYou may invoke tools when needed by outputting:\n<tool_call>{"name": "tool_name", "arguments": { ... }}</tool_call>\n\n${toolSummaries}`);
        }
        if (toolContext)
            pending.push(toolContext);
        for (const msg of messages) {
            const role = this._roleLabel(msg);
            let text = '';
            if (typeof msg.content === 'string') {
                text = msg.content;
            }
            else if (Array.isArray(msg.content)) {
                text = msg.content.map((c) => typeof c === 'string' ? c : (c?.text || '')).filter(Boolean).join('\n');
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
                    if (!image)
                        continue;
                    flush();
                    if (imageSupport) {
                        blocks.push(image);
                    }
                    else {
                        pending.push(`[Image omitted — ${this.peerId} does not accept image input]`);
                    }
                }
            }
        }
        flush();
        return blocks.length > 0 ? blocks : [{ type: 'text', text: 'Continue.' }];
    }
    _roleLabel(msg) {
        if (msg.role === 'user')
            return 'User';
        if (msg.role === 'assistant')
            return 'Assistant';
        if (msg.role === 'system')
            return 'System Instructions';
        if (msg.role === 'tool')
            return `Tool Result (${msg.name || 'tool'})`;
        return 'Context';
    }
    _imageBlock(part) {
        if (!part || typeof part !== 'object')
            return null;
        if (part.type === 'image' && part.source?.type === 'base64') {
            return { type: 'image', mimeType: part.source.media_type, data: part.source.data };
        }
        if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
            const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
            if (match)
                return { type: 'image', mimeType: match[1], data: match[2] };
        }
        return null;
    }
    extractToolCalls(text) {
        const calls = [];
        if (!text || typeof text !== 'string')
            return calls;
        const regex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
        let match;
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
            }
            catch {
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
                }
                catch {
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
                    }
                    catch {
                        // try next candidate
                    }
                }
            }
        }
        return calls;
    }
    async getOrCreateClient(signal, workspaceRoot = process.cwd()) {
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
            allowHostTools: false,
            permissionHandler: async (req) => {
                if (this.currentTurnAborted || signal?.aborted)
                    return { outcome: 'cancelled' };
                // Inference peers cannot grant themselves host execution authority.
                // Return a Causyne tool call so the shared policy and budget can apply.
                return { outcome: 'cancelled' };
            },
            onUpdate: (_sessionId, update) => {
                if (this.currentTurnAborted)
                    return;
                if (update && typeof update === 'object') {
                    const updateObj = update;
                    if (updateObj.sessionUpdate === 'agent_thought_chunk') {
                        const thought = updateObj.content?.text || updateObj.thought || (typeof updateObj.content === 'string' ? updateObj.content : '');
                        if (thought && this.currentTurnReasoningHandler) {
                            this.currentTurnReasoningHandler(thought);
                        }
                    }
                    else if (updateObj.sessionUpdate === 'agent_message_chunk') {
                        const text = updateObj.content?.type === 'text' ? updateObj.content.text : '';
                        if (text && this.currentTurnChunkHandler)
                            this.currentTurnChunkHandler(text);
                    }
                    else if (updateObj.sessionUpdate === 'tool_call' || updateObj.sessionUpdate === 'tool_call_update') {
                        this.currentTurnSawAction = true;
                        const id = String(updateObj.toolCallId || '');
                        const earlier = this.liveFileActions.get(id);
                        const kind = updateObj.kind || (earlier?.name === 'fs_edit' ? 'edit' : earlier?.name === 'fs_delete' ? 'delete' : earlier?.name === 'fs_move' ? 'move' : '');
                        const name = kind === 'edit' ? 'fs_edit' : kind === 'delete' ? 'fs_delete' : kind === 'move' ? 'fs_move'
                            : kind === 'read' ? 'fs_read' : kind === 'search' ? 'codebase_search' : kind === 'fetch' ? 'web_fetch'
                                : kind === 'execute' ? 'sysRun' : String(updateObj.title || earlier?.name || 'provider_tool');
                        if (name && id) {
                            const diff = Array.isArray(updateObj.content)
                                ? updateObj.content.find((item) => item?.type === 'diff')
                                : null;
                            const input = updateObj.rawInput && typeof updateObj.rawInput === 'object' ? updateObj.rawInput : {};
                            const parameters = {
                                ...(earlier?.parameters || {}), ...input,
                                ...(diff?.path ? { path: diff.path } : {}),
                                ...(diff?.newText ? { content: diff.newText } : {}),
                                ...(updateObj.locations?.[0]?.path ? { path: updateObj.locations[0].path } : {})
                            };
                            const status = updateObj.status === 'completed' ? 'completed' : updateObj.status === 'failed' ? 'failed' : 'running';
                            const action = { id: `acp:${id}`, name, status, parameters,
                                detail: String(parameters.path || updateObj.title || '') };
                            if (status === 'running')
                                this.liveFileActions.set(id, action);
                            else
                                this.liveFileActions.delete(id);
                            this.currentTurnNativeActionHandler?.(action);
                        }
                    }
                    else if ('textDelta' in updateObj) {
                        const delta = updateObj.textDelta;
                        if (delta && typeof delta === 'string' && this.currentTurnChunkHandler) {
                            this.currentTurnChunkHandler(delta);
                        }
                    }
                }
            }
        });
        await client.start(signal);
        const sessionId = await client.newSession(workspaceRoot, [], signal);
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
            const matched = liveModels.find((m) => m.toLowerCase() === targetModel.toLowerCase() || m.endsWith(`/${targetModel}`));
            if (matched) {
                targetModel = matched;
                this.model = matched;
            }
            else {
                const staticDefault = DEFAULT_MODEL_BY_PROVIDER[`acp/${this.peerId}`];
                if (targetModel === staticDefault || targetModel === this.peerId || targetModel === 'acp') {
                    targetModel = sessionModels.currentModelId || liveModels[0];
                    this.model = targetModel;
                }
            }
        }
        if (targetModel && targetModel !== 'acp' && targetModel !== this.peerId) {
            try {
                await client.setSessionModel(sessionId, targetModel, signal);
            }
            catch (err) {
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
                    }
                    catch {
                        // Peer already defaults to its own active session model
                    }
                }
            }
        }
        this.activeClient = client;
        this.activeSessionId = sessionId;
        return { client, sessionId };
    }
    abort() {
        this.currentTurnAborted = true;
        this.currentTurnChunkHandler = null;
        this.currentTurnReasoningHandler = null;
        this.currentTurnNativeActionHandler = null;
        this.liveFileActions.clear();
        if (this.activeClient && this.activeSessionId) {
            try {
                this.activeClient.notifyCancel(this.activeSessionId);
            }
            catch {
                // ignore cancel write error
            }
        }
        void this.close();
    }
    async close() {
        const client = this.activeClient;
        this.activeClient = null;
        this.activeSessionId = null;
        this.transportSnapshot = null;
        if (client) {
            try {
                await client.close();
            }
            catch {
                // ignore close error
            }
        }
    }
    async chat(messages, options = {}) {
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
        this.liveFileActions.clear();
        const onAbort = () => {
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
            const sessionChanged = previous && (previous.workspaceRoot !== workspaceRoot || previous.conversationId !== conversationId);
            const historyDiverged = previous && (historyHashes.length < previous.historyHashes.length ||
                previous.historyHashes.some((hash, index) => historyHashes[index] !== hash));
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
                    firstNew.content === previous.lastResponse.content &&
                    fingerprint(firstNew.tool_calls || []) === fingerprint(previous.lastResponse.toolCalls)) {
                    newHistory.shift();
                }
                promptMessages = [
                    ...changedSystem.map(message => ({ ...message, content: `[Current system context — replaces the prior version of this section]\n${message.content}` })),
                    ...newHistory
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
            }
            catch (promptErr) {
                if (this.currentTurnAborted || options.signal?.aborted || promptErr?.name === 'AbortError') {
                    throw promptErr;
                }
                // Replaying after a peer executed native tools can duplicate mutations
                // and charges. Restart only before any observed native action.
                if (this.currentTurnSawAction)
                    throw promptErr;
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
            // Strip tool call XML from chat content display
            let content = rawContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
            this.transportSnapshot = {
                conversationId, workspaceRoot, systemHashes, historyHashes, toolHash, tools: structuredClone(options.tools || []),
                lastResponse: { content: content || (toolCalls.length > 0 ? '' : `Turn completed by ${this.peerId} over ACP.`), toolCalls }
            };
            const response = {
                content: content || (toolCalls.length > 0 ? '' : `Turn completed by ${this.peerId} over ACP.`),
                usage: {
                    promptTokens: Math.ceil(promptText.length / 4),
                    completionTokens: Math.ceil(rawContent.length / 4),
                    cachedPromptTokens: 0,
                    measurement: 'text_estimate',
                    cacheMeasurement: 'unavailable'
                }
            };
            const usage = result?.usage;
            if (usage && Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0
                && Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0) {
                const safeCount = (value) => Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
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
            if (result?.stopReason === 'max_tokens' || result?.stopReason === 'max_turn_requests') {
                response.incompleteTurn = true;
            }
            return response;
        }
        catch (err) {
            await this.close();
            if (this.currentTurnAborted || options.signal?.aborted || err?.name === 'AbortError') {
                const abortErr = new Error('ACP request aborted by user');
                abortErr.name = 'AbortError';
                throw abortErr;
            }
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`ACP Peer Agent (${this.peerId}) Error: ${msg}. Make sure "${this.command}" is installed and running.`);
        }
        finally {
            options.signal?.removeEventListener('abort', onAbort);
            this.currentTurnChunkHandler = null;
            this.currentTurnReasoningHandler = null;
            this.currentTurnNativeActionHandler = null;
            this.liveFileActions.clear();
        }
    }
}
