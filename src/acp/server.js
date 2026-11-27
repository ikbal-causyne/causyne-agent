import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { AgentLoop } from '../agentLoop.js';
import { createApprovalScope } from '../approvalGrants.js';
import { loadConfig } from '../config.js';
import { DEFAULT_MODEL_BY_PROVIDER, MODEL_CATALOGUE, PEER_MODEL_CATALOGUE } from '../modelCatalogue.js';
import { resolveModelVariants } from '../modelVariants.js';
import { McpClient } from '../mcp/mcpClient.js';
import { registerSessionMcpServers, unregisterSessionMcpServers } from '../mcp/mcpRegistry.js';
import { createSession, getSession, saveSessionMessages, forkSession } from '../sessionJournal.js';
import { isBlockedWorkspaceRoot } from '../sandboxPolicy.js';
import { safeDisplay } from '../tui/text.js';
import { ACP_ERROR_CODES, ACP_METHODS, ACP_PROTOCOL_VERSION, isJsonRpcNotification, isJsonRpcRequest, isJsonRpcResponse } from './protocol.js';
const FORBIDDEN_ENV_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_SESSION_MCP_SERVERS = 16;
function providerModelsForCatalogue(provider) {
    const norm = provider.trim().toLowerCase();
    if (!norm)
        return [];
    const peerKey = norm.startsWith('acp/') ? norm.slice(4) : norm;
    if (Object.hasOwn(PEER_MODEL_CATALOGUE, peerKey)) {
        return [...(PEER_MODEL_CATALOGUE[peerKey] ?? [])];
    }
    const providerLabelMatch = {
        deepseek: ['DeepSeek'],
        qwen: ['Qwen'],
        dashscope: ['Qwen'],
        'dashscope-byok': ['Qwen'],
        anthropic: ['Anthropic'],
        openai: ['OpenAI'],
        gemini: ['Gemini'],
        'gemini-free': ['Gemini (Free Tier)'],
        moonshot: ['Moonshot'],
        xai: ['xAI'],
        groq: ['Groq (Free Tier)'],
        cerebras: ['Cerebras (Free Tier)'],
        openrouter: ['OpenRouter (Free Tier)'],
        mistral: ['Mistral (Free Tier)']
    };
    const labels = providerLabelMatch[norm] ?? [];
    const models = [];
    for (const label of labels) {
        const entries = MODEL_CATALOGUE[label];
        if (Array.isArray(entries))
            models.push(...entries);
    }
    return models;
}
const MODE_TO_AUTONOMY = {
    autonomous: 'C',
    standard: 'B',
    supervised: 'A'
};
const MODES = {
    currentModeId: 'standard',
    availableModes: [
        { id: 'autonomous', name: 'Autonomous', description: 'Runs without pausing for routine approvals' },
        { id: 'standard', name: 'Standard', description: 'Asks before dangerous actions' },
        { id: 'supervised', name: 'Supervised', description: 'Asks before most mutating actions' }
    ]
};
const MAX_PROMPT_CHARS = 200_000;
const MAX_RAW_CHARS = 4000;
const MAX_JSONRPC_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS = 128;
const MAX_PENDING_PROMPTS_PER_SESSION = 32;
const MAX_PENDING_PROMPTS = 128;
function textFromPrompt(prompt) {
    const parts = [];
    let length = 0;
    for (const block of prompt) {
        if (!block || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') {
            return null;
        }
        length += block.text.length + (parts.length ? 1 : 0);
        if (length > MAX_PROMPT_CHARS)
            return null;
        parts.push(block.text);
    }
    return parts.join('\n');
}
function textFromContent(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (block !== null && typeof block === 'object' && !Array.isArray(block)) {
            const item = block;
            if (item.type === 'text' && typeof item.text === 'string')
                parts.push(item.text);
        }
    }
    return parts.join('\n');
}
function toolKind(name) {
    if (/^(fs_read|read_file|read|fs_list|list_dir|view_file)$/.test(name))
        return 'read';
    if (/^(fs_write|fs_edit|MultiEdit|write_file|edit_file)$/.test(name))
        return 'edit';
    if (/^(fs_delete|delete_file)$/.test(name))
        return 'delete';
    if (/^(fs_move|move_file)$/.test(name))
        return 'move';
    if (/^(grep|glob|search|find|code_search)$/.test(name))
        return 'search';
    if (/^(sysRun|sysRunBg|shell|terminal|terminal_persistent_shell|gitOp|proc_term)$/.test(name))
        return 'execute';
    if (/^(webFetch|webSearch|web_fetch|web_search)$/.test(name))
        return 'fetch';
    if (/^(request_decision|update_plan|think)$/.test(name))
        return 'think';
    return 'other';
}
function bounded(value, limit = MAX_RAW_CHARS) {
    let text;
    try {
        text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    }
    catch {
        text = '[unserializable]';
    }
    return text.length > limit ? `${text.slice(0, limit)}…[truncated]` : text;
}
function toolTitle(name, args) {
    const detail = args.path || args.file_path || args.command || args.cmd || args.query || args.url || args.action;
    const rawSuffix = typeof detail === 'string' && detail.trim() ? ` ${detail.trim()}` : '';
    const title = safeDisplay(`${name}${rawSuffix}`).replace(/\s+/g, ' ').trim();
    return title.length > 200 ? `${title.slice(0, 200)}…` : title;
}
export class AcpServer {
    input;
    output;
    loopFactory;
    agentName;
    agentVersion;
    permissionTimeoutMs;
    sessions = new Map();
    assistantStreams = new WeakMap();
    reasoningStreams = new WeakMap();
    failedTurns = new WeakSet();
    pending = new Map();
    nextClientRequestId = 1;
    pendingPrompts = 0;
    buffer = '';
    discardOversizedFrame = false;
    decoder = new StringDecoder('utf8');
    closed = false;
    workspaceRoot = null;
    dataListener = null;
    endListener = null;
    errorListener = null;
    constructor(options = {}) {
        this.input = options.input ?? null;
        this.output = options.output ?? null;
        this.loopFactory = options.loopFactory ?? null;
        this.agentName = options.agentName ?? 'Causyne Agent';
        this.agentVersion = options.agentVersion ?? '0.0.0';
        const rawTimeout = options.permissionTimeoutMs;
        this.permissionTimeoutMs = typeof rawTimeout === 'number' && Number.isFinite(rawTimeout)
            ? Math.max(1_000, Math.min(3_600_000, Math.round(rawTimeout)))
            : 10 * 60 * 1000;
    }
    start() {
        if (this.closed || !this.input || this.dataListener)
            return;
        this.dataListener = (chunk) => {
            let text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
            if (this.discardOversizedFrame) {
                const newline = text.indexOf('\n');
                if (newline < 0)
                    return;
                text = text.slice(newline + 1);
                this.discardOversizedFrame = false;
            }
            this.buffer += text;
            void this.drainBuffer();
            if (Buffer.byteLength(this.buffer, 'utf8') > MAX_JSONRPC_BUFFER_BYTES) {
                this.buffer = '';
                this.discardOversizedFrame = true;
                this.write({
                    jsonrpc: '2.0',
                    id: null,
                    error: { code: ACP_ERROR_CODES.INVALID_REQUEST, message: 'Request frame exceeds maximum size' }
                });
            }
        };
        this.endListener = () => { void this.stop(); };
        this.errorListener = () => { void this.stop(); };
        this.input.on('data', this.dataListener);
        this.input.on('end', this.endListener);
        this.input.on('error', this.errorListener);
    }
    async stop() {
        if (this.closed)
            return;
        this.closed = true;
        if (this.input && this.dataListener)
            this.input.off('data', this.dataListener);
        if (this.input && this.endListener)
            this.input.off('end', this.endListener);
        if (this.input && this.errorListener)
            this.input.off('error', this.errorListener);
        this.buffer = '';
        const closingIds = [...this.sessions.keys()];
        for (const session of this.sessions.values()) {
            session.cancelled = true;
            session.generation++;
            try {
                session.loop?.abort();
            }
            catch {
                // Shutdown never blocks on a misbehaving tool.
            }
        }
        this.sessions.clear();
        await Promise.allSettled(closingIds.map((id) => unregisterSessionMcpServers(id)));
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error('server stopped'));
            this.pending.delete(id);
        }
    }
    drainBuffer() {
        const lines = [];
        let index = this.buffer.indexOf('\n');
        while (index >= 0) {
            const line = this.buffer.slice(0, index);
            this.buffer = this.buffer.slice(index + 1);
            if (line.trim() || Buffer.byteLength(line, 'utf8') > MAX_JSONRPC_BUFFER_BYTES)
                lines.push(line);
            index = this.buffer.indexOf('\n');
        }
        for (const line of lines) {
            void this.handleLine(line).catch(() => { });
        }
    }
    async handleLine(line) {
        if (this.closed)
            return;
        const cleaned = line.replace(/^\uFEFF/, '').replace(/\r$/, '');
        if (Buffer.byteLength(line, 'utf8') > MAX_JSONRPC_BUFFER_BYTES) {
            this.write({
                jsonrpc: '2.0',
                id: null,
                error: { code: ACP_ERROR_CODES.INVALID_REQUEST, message: 'Request frame exceeds maximum size' }
            });
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(cleaned);
        }
        catch {
            this.write({ jsonrpc: '2.0', id: null, error: { code: ACP_ERROR_CODES.PARSE_ERROR, message: 'Parse error' } });
            return;
        }
        if (isJsonRpcResponse(parsed)) {
            this.resolveClientRequest(parsed);
            return;
        }
        if (isJsonRpcRequest(parsed)) {
            await this.handleRequest(parsed);
            return;
        }
        if (isJsonRpcNotification(parsed)) {
            await this.handleNotification(parsed);
            return;
        }
        this.write({ jsonrpc: '2.0', id: null, error: { code: ACP_ERROR_CODES.INVALID_REQUEST, message: 'Invalid request' } });
    }
    isPlainParams(value) {
        return value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value));
    }
    async handleNotification(notification) {
        if (!this.isPlainParams(notification.params))
            return;
        if (notification.method === ACP_METHODS.CANCEL) {
            const params = notification.params;
            const sid = params && typeof params.sessionId === 'string' ? params.sessionId : '';
            const session = sid ? this.sessions.get(sid) : undefined;
            if (session) {
                session.cancelled = true;
                session.generation++;
                this.rejectPendingForSession(session.id, 'session cancelled');
                try {
                    session.loop?.abort();
                }
                catch {
                    // Cancellation is best effort.
                }
            }
        }
    }
    async handleRequest(request) {
        try {
            if (!this.isPlainParams(request.params)) {
                throw this.paramsError('params must be a JSON object');
            }
            switch (request.method) {
                case ACP_METHODS.INITIALIZE:
                    this.writeResult(request.id, this.initialize(request.params));
                    return;
                case ACP_METHODS.NEW_SESSION:
                    this.writeResult(request.id, this.newSession(request.params));
                    return;
                case ACP_METHODS.PROMPT:
                    this.writeResult(request.id, await this.prompt(request.params));
                    return;
                case ACP_METHODS.SET_MODE:
                    this.writeResult(request.id, this.setMode(request.params));
                    return;
                case ACP_METHODS.SET_MODEL:
                    this.writeResult(request.id, this.setModel(request.params));
                    return;
                case ACP_METHODS.SET_CONFIG_OPTION:
                    this.writeResult(request.id, this.setConfigOption(request.params));
                    return;
                case ACP_METHODS.LIST:
                    this.writeResult(request.id, this.listSessions(request.params));
                    return;
                case ACP_METHODS.CLOSE:
                    this.writeResult(request.id, this.closeSession(request.params));
                    return;
                case ACP_METHODS.LOAD:
                    this.writeResult(request.id, this.loadSession(request.params));
                    return;
                case ACP_METHODS.FORK:
                    this.writeResult(request.id, this.forkSession(request.params));
                    return;
                default:
                    this.writeError(request.id, ACP_ERROR_CODES.METHOD_NOT_FOUND, `Unknown method: ${request.method}`);
            }
        }
        catch (error) {
            const code = error.acpCode ?? ACP_ERROR_CODES.INTERNAL_ERROR;
            this.writeError(request.id, code, error instanceof Error ? error.message : String(error));
        }
    }
    initialize(params) {
        if (!params ||
            typeof params.protocolVersion !== 'number' ||
            !Number.isInteger(params.protocolVersion) ||
            params.protocolVersion < 1) {
            throw this.paramsError('initialize requires a valid positive integer protocolVersion');
        }
        const capabilities = {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
            mcpCapabilities: { http: false, sse: false },
            sessionCapabilities: { list: {}, close: {}, fork: {} }
        };
        return {
            protocolVersion: ACP_PROTOCOL_VERSION,
            agentCapabilities: capabilities,
            agentInfo: { name: this.agentName, version: this.agentVersion }
        };
    }
    paramsError(message) {
        const error = new Error(message);
        error.acpCode = ACP_ERROR_CODES.INVALID_PARAMS;
        return error;
    }
    parseSessionMcpServers(raw, cwd) {
        if (raw === undefined)
            return [];
        if (!Array.isArray(raw)) {
            throw this.paramsError('mcpServers must be an array');
        }
        if (raw.length > MAX_SESSION_MCP_SERVERS) {
            throw this.paramsError(`Maximum ${MAX_SESSION_MCP_SERVERS} MCP servers per session exceeded`);
        }
        const definitions = [];
        for (const entry of raw) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                throw this.paramsError('Each MCP server entry must be an object');
            }
            const item = entry;
            const rawType = typeof item.type === 'string' ? item.type.trim().toLowerCase() : '';
            if (rawType === 'http' || rawType === 'sse' || typeof item.url === 'string') {
                throw this.paramsError('HTTP/SSE MCP servers are not supported by this agent');
            }
            if (typeof item.name !== 'string' || !item.name.trim()) {
                throw this.paramsError('Stdio MCP server requires a non-empty name');
            }
            if (typeof item.command !== 'string' || !item.command.trim()) {
                throw this.paramsError('Stdio MCP server requires a non-empty command');
            }
            if (!Array.isArray(item.args) || !item.args.every((arg) => typeof arg === 'string')) {
                throw this.paramsError('Stdio MCP server requires an args string array');
            }
            let env;
            if (item.env !== undefined) {
                const mapped = Object.create(null);
                if (Array.isArray(item.env)) {
                    for (const pair of item.env) {
                        if (!pair || typeof pair !== 'object' || Array.isArray(pair)) {
                            throw this.paramsError('Stdio MCP server env entries must be { name, value } objects');
                        }
                        const rec = pair;
                        if (typeof rec.name !== 'string' || !rec.name || typeof rec.value !== 'string') {
                            throw this.paramsError('Stdio MCP server env entries require string name and value');
                        }
                        if (!FORBIDDEN_ENV_KEYS.has(rec.name))
                            mapped[rec.name] = rec.value;
                    }
                }
                else if (typeof item.env === 'object' && item.env !== null) {
                    for (const [k, v] of Object.entries(item.env)) {
                        if (typeof v !== 'string') {
                            throw this.paramsError('Stdio MCP server env values must be strings');
                        }
                        if (!FORBIDDEN_ENV_KEYS.has(k))
                            mapped[k] = v;
                    }
                }
                else {
                    throw this.paramsError('Stdio MCP server env must be an array or object');
                }
                if (Object.keys(mapped).length > 0)
                    env = { ...mapped };
            }
            const def = {
                name: item.name.trim(),
                command: item.command.trim(),
                args: [...item.args],
                ...(env ? { env } : {}),
                cwd
            };
            const problem = McpClient.validateDefinition(def);
            if (problem) {
                throw this.paramsError(`Invalid MCP server "${def.name}": ${problem}`);
            }
            definitions.push(def);
        }
        return definitions;
    }
    newSession(params) {
        if (!params || typeof params.cwd !== 'string' || !params.cwd.trim()) {
            throw this.paramsError('session/new requires cwd');
        }
        if (params.additionalDirectories !== undefined && (!Array.isArray(params.additionalDirectories) || params.additionalDirectories.length > 0)) {
            throw this.paramsError('additionalDirectories is not supported by this agent');
        }
        const cwd = this.resolveWorkspace(params.cwd);
        const mcpServers = this.parseSessionMcpServers(params.mcpServers, cwd);
        this.bindWorkspace(cwd);
        if (this.sessions.size >= MAX_SESSIONS) {
            throw this.paramsError(`Maximum concurrent sessions (${MAX_SESSIONS}) exceeded`);
        }
        const record = createSession(cwd, 'Untitled', false);
        const session = this.addSession(record.id, cwd, record.title, MODES.currentModeId);
        if (mcpServers.length > 0) {
            session.mcpServers = mcpServers;
            registerSessionMcpServers(session.id, mcpServers);
        }
        return this.sessionResponse(session);
    }
    resolveWorkspace(cwd) {
        if (typeof cwd !== 'string' || !cwd.trim())
            throw this.paramsError('cwd is required');
        let resolved;
        try {
            resolved = fs.realpathSync(path.resolve(cwd));
            if (!fs.statSync(resolved).isDirectory())
                throw new Error('not a directory');
        }
        catch {
            throw this.paramsError(`cwd is not an accessible directory: ${cwd}`);
        }
        if (isBlockedWorkspaceRoot(resolved)) {
            throw this.paramsError(`cwd points to a blocked system directory: ${cwd}`);
        }
        return resolved;
    }
    bindWorkspace(cwd) {
        if (this.workspaceRoot === null) {
            this.workspaceRoot = cwd;
            process.chdir(cwd);
        }
        else if (this.workspaceRoot !== cwd) {
            throw this.paramsError(`server is bound to ${this.workspaceRoot}; one workspace per server`);
        }
    }
    addSession(id, cwd, title, modeId) {
        if (!this.sessions.has(id) && this.sessions.size >= MAX_SESSIONS) {
            throw this.paramsError(`Maximum concurrent sessions (${MAX_SESSIONS}) exceeded`);
        }
        const session = {
            id,
            memorySessionId: id,
            title: safeDisplay(title).replace(/\s+/g, ' ').trim() || 'Untitled',
            cwd,
            modeId,
            loop: null,
            busy: false,
            cancelled: false,
            updatedAt: Date.now(),
            queue: Promise.resolve(),
            generation: 0,
            pendingPrompts: 0,
            approvalScope: createApprovalScope()
        };
        this.sessions.set(id, session);
        return session;
    }
    modesFor(session) {
        return {
            currentModeId: session.modeId,
            availableModes: MODES.availableModes.map((mode) => ({ ...mode }))
        };
    }
    buildSessionCatalog(session) {
        let config = {};
        try {
            config = loadConfig();
        }
        catch {
            config = {};
        }
        const provider = typeof config.provider === 'string' && config.provider.trim()
            ? config.provider.trim()
            : 'deepseek';
        const configuredModel = typeof config.model === 'string' && config.model.trim()
            ? config.model.trim()
            : (DEFAULT_MODEL_BY_PROVIDER[provider.toLowerCase()] || '');
        const activeModel = session.model || configuredModel;
        const seen = new Set();
        const modelIds = [];
        const addModel = (id) => {
            const clean = id.trim();
            if (!clean || seen.has(clean))
                return;
            seen.add(clean);
            modelIds.push(clean);
        };
        if (activeModel)
            addModel(activeModel);
        if (configuredModel)
            addModel(configuredModel);
        for (const candidate of providerModelsForCatalogue(provider)) {
            addModel(candidate);
            if (modelIds.length >= 64)
                break;
        }
        const configOptions = [];
        const primaryModelId = activeModel || modelIds[0];
        if (modelIds.length > 0 && primaryModelId) {
            configOptions.push({
                id: 'model',
                name: 'Model',
                category: 'model',
                type: 'select',
                currentValue: primaryModelId,
                options: modelIds.map((id) => ({ value: id, name: id }))
            });
        }
        const currentVariant = session.variant
            || (typeof config.reasoningEffort === 'string' && config.reasoningEffort.trim() ? config.reasoningEffort.trim() : undefined);
        if (activeModel) {
            try {
                const variantSpec = resolveModelVariants({
                    provider,
                    model: activeModel,
                    currentVariant: currentVariant ?? null
                });
                if (variantSpec.supported && variantSpec.options.length > 0) {
                    const resolvedVariant = currentVariant || variantSpec.defaultVariant || variantSpec.options[0]?.id;
                    configOptions.push({
                        id: 'thought_level',
                        name: 'Reasoning effort',
                        category: 'thought_level',
                        type: 'select',
                        ...(resolvedVariant ? { currentValue: resolvedVariant } : {}),
                        options: variantSpec.options.map((opt) => ({
                            value: opt.id,
                            name: opt.label,
                            description: opt.description
                        }))
                    });
                }
            }
            catch {
                // Variant discovery is best-effort; never fail session creation.
            }
        }
        const models = modelIds.length > 0 && primaryModelId
            ? {
                currentModelId: primaryModelId,
                availableModels: modelIds.map((id) => ({ modelId: id, name: id }))
            }
            : undefined;
        return {
            ...(models ? { models } : {}),
            ...(configOptions.length > 0 ? { configOptions } : {})
        };
    }
    sessionResponse(session) {
        const catalog = this.buildSessionCatalog(session);
        return {
            sessionId: session.id,
            modes: this.modesFor(session),
            ...(catalog.models ? { models: catalog.models } : {}),
            ...(catalog.configOptions ? { configOptions: catalog.configOptions } : {})
        };
    }
    requireSession(sessionId) {
        if (typeof sessionId !== 'string' || !sessionId)
            throw this.paramsError('sessionId is required');
        const session = this.sessions.get(sessionId);
        if (!session) {
            const error = new Error(`Unknown session: ${sessionId}`);
            error.acpCode = ACP_ERROR_CODES.RESOURCE_NOT_FOUND;
            throw error;
        }
        return session;
    }
    async prompt(params) {
        if (!params || !Array.isArray(params.prompt)) {
            throw this.paramsError('session/prompt requires a prompt array');
        }
        const session = this.requireSession(params.sessionId);
        const text = textFromPrompt(params.prompt);
        if (text === null || !text.trim()) {
            return { stopReason: 'refusal' };
        }
        if (session.pendingPrompts >= MAX_PENDING_PROMPTS_PER_SESSION || this.pendingPrompts >= MAX_PENDING_PROMPTS) {
            throw this.paramsError('Session prompt queue is full');
        }
        session.pendingPrompts++;
        this.pendingPrompts++;
        const generation = session.generation;
        const execute = () => generation === session.generation ? this.runTurn(session, text) : Promise.resolve('cancelled');
        session.queue = session.queue.then(execute, execute);
        try {
            const stopReason = await session.queue;
            return { stopReason };
        }
        finally {
            session.pendingPrompts--;
            this.pendingPrompts--;
        }
    }
    async runTurn(session, text) {
        if (this.closed || this.sessions.get(session.id) !== session) {
            return 'cancelled';
        }
        session.updatedAt = Date.now();
        session.cancelled = false;
        this.assistantStreams.delete(session);
        this.reasoningStreams.delete(session);
        this.failedTurns.delete(session);
        session.busy = true;
        const taskId = `acp-${crypto.randomUUID()}`;
        let acceptingEvents = true;
        const sink = {
            readyState: 1,
            send: (payload) => { if (acceptingEvents && !session.cancelled && this.sessions.get(session.id) === session)
                this.onLoopPayload(session, payload); }
        };
        const peerMcpServers = Array.isArray(session.mcpServers) && session.mcpServers.length > 0
            ? session.mcpServers
                .filter((def) => typeof def.command === 'string' && def.command.length > 0)
                .map((def) => ({
                name: def.name,
                command: def.command,
                args: Array.isArray(def.args) ? [...def.args] : [],
                env: Object.entries(def.env ?? {}).map(([name, value]) => ({ name, value }))
            }))
            : [];
        const loopOptions = {
            workspaceRoot: session.cwd,
            memorySessionId: session.memorySessionId,
            approvalScope: session.approvalScope,
            ...(session.model ? { model: session.model } : {}),
            ...(session.variant ? { variant: session.variant } : {}),
            ...(peerMcpServers.length > 0 ? { peerMcpServers } : {})
        };
        let loop;
        try {
            loop = this.loopFactory
                ? this.loopFactory({
                    sessionId: session.id,
                    memorySessionId: session.memorySessionId,
                    taskId,
                    userPrompt: text,
                    cwd: session.cwd,
                    sink,
                    approvalScope: session.approvalScope
                })
                : new AgentLoop(sink, taskId, text, loopOptions);
        }
        catch {
            acceptingEvents = false;
            session.busy = false;
            session.loop = null;
            return 'refusal';
        }
        const autonomy = MODE_TO_AUTONOMY[session.modeId];
        if (autonomy) {
            try {
                loop.setAutonomyMode(autonomy);
            }
            catch {
                // A loop without autonomy control simply keeps its configured mode.
            }
        }
        loop.waitForDecision = async (request) => this.requestDecision(session, loop, request);
        session.loop = loop;
        let stopReason = 'end_turn';
        try {
            await loop.run();
            if (this.failedTurns.has(session))
                stopReason = 'refusal';
        }
        catch {
            stopReason = 'refusal';
        }
        finally {
            acceptingEvents = false;
            session.loop = null;
            session.busy = false;
            if (this.sessions.get(session.id) === session) {
                this.rejectPendingForSession(session.id, 'turn ended');
                const record = getSession(session.memorySessionId);
                if (record)
                    session.title = safeDisplay(record.title).replace(/\s+/g, ' ').trim() || session.title;
            }
            if (session.cancelled)
                stopReason = 'cancelled';
        }
        return stopReason;
    }
    requestDecision(session, loop, request) {
        if (this.closed || session.cancelled || session.loop !== loop || this.sessions.get(session.id) !== session)
            return Promise.resolve(null);
        if (request === null || typeof request !== 'object' || Array.isArray(request))
            return Promise.resolve(null);
        const record = request;
        const options = Array.isArray(record.options) ? record.options : [];
        const permissionOptions = [];
        const labels = new Map();
        for (const option of options) {
            if (option === null || typeof option !== 'object' || Array.isArray(option))
                continue;
            const item = option;
            const id = typeof item.id === 'string' ? item.id : '';
            const label = typeof item.label === 'string' ? item.label : id;
            if (!id)
                continue;
            if (labels.has(id))
                return Promise.resolve(null);
            labels.set(id, label);
            permissionOptions.push({ optionId: id, name: label, kind: 'allow_once' });
        }
        if (permissionOptions.length === 0)
            return Promise.resolve(null);
        const toolCall = {
            toolCallId: typeof record.id === 'string' ? record.id : crypto.randomUUID(),
            title: typeof record.question === 'string' ? record.question.slice(0, 300) : 'Decision required',
            kind: 'other',
            status: 'pending'
        };
        return this.sendClientRequest(session, ACP_METHODS.REQUEST_PERMISSION, {
            sessionId: session.id,
            toolCall,
            options: permissionOptions
        }).then((response) => {
            if (this.closed || session.cancelled || session.loop !== loop || this.sessions.get(session.id) !== session)
                return null;
            const outcome = response && typeof response.outcome === 'object' && response.outcome !== null
                ? response.outcome
                : null;
            if (!outcome || outcome.outcome !== 'selected' || typeof outcome.optionId !== 'string')
                return null;
            const optionId = outcome.optionId;
            const label = labels.get(optionId);
            if (!label)
                return null;
            return { optionId, label };
        }).catch(() => null);
    }
    onLoopPayload(session, payload) {
        let event;
        try {
            event = JSON.parse(payload);
        }
        catch {
            return;
        }
        if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string')
            return;
        this.onLoopEvent(session, event);
    }
    onLoopEvent(session, event) {
        switch (event.type) {
            case 'agent_message': {
                const text = String(event.content ?? '');
                const key = typeof event.streamId === 'number' || typeof event.streamId === 'string' ? String(event.streamId) : '';
                const previous = this.assistantStreams.get(session);
                const tracked = Boolean(key) || event.streaming === true || previous?.key === '';
                const sameStream = tracked && previous?.key === key;
                const delta = sameStream && text.startsWith(previous.text) ? text.slice(previous.text.length) : text;
                if (tracked)
                    this.assistantStreams.set(session, { key, text });
                if (event.streaming !== true && !key)
                    this.assistantStreams.delete(session);
                if (delta)
                    this.notify(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: delta } });
                return;
            }
            case 'agent_reasoning': {
                const text = String(event.content ?? '');
                const previous = this.reasoningStreams.get(session) || '';
                const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
                if (event.streaming === true)
                    this.reasoningStreams.set(session, text);
                else
                    this.reasoningStreams.delete(session);
                if (delta)
                    this.notify(session.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: delta } });
                return;
            }
            case 'status':
            case 'notice': {
                const text = String(event.message ?? '');
                if (text)
                    this.notify(session.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
                return;
            }
            case 'warning':
            case 'budget_warning':
            case 'error': {
                if (event.type === 'error')
                    this.failedTurns.add(session);
                const text = String(event.message ?? 'Task error');
                this.notify(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
                return;
            }
            case 'step_start': {
                const tool = String(event.tool ?? 'tool');
                const args = event.args !== null && typeof event.args === 'object' && !Array.isArray(event.args)
                    ? event.args
                    : {};
                const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : crypto.randomUUID();
                this.notify(session.id, {
                    sessionUpdate: 'tool_call',
                    toolCallId,
                    title: toolTitle(tool, args),
                    kind: toolKind(tool),
                    status: 'in_progress',
                    rawInput: args
                });
                return;
            }
            case 'step_complete': {
                const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : null;
                if (!toolCallId)
                    return;
                const result = event.result;
                const status = result && result.success === false ? 'failed' : 'completed';
                this.notify(session.id, {
                    sessionUpdate: 'tool_call_update',
                    toolCallId,
                    status,
                    content: [{ type: 'content', content: { type: 'text', text: bounded(event.result) } }]
                });
                return;
            }
            case 'step_error': {
                const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : null;
                if (!toolCallId)
                    return;
                this.notify(session.id, {
                    sessionUpdate: 'tool_call_update',
                    toolCallId,
                    status: 'failed',
                    content: [{ type: 'content', content: { type: 'text', text: bounded(event.error ?? 'tool failed') } }]
                });
                return;
            }
            case 'agent_plan': {
                const plan = Array.isArray(event.plan) ? event.plan : [];
                this.notify(session.id, {
                    sessionUpdate: 'plan',
                    entries: plan.map((entry) => {
                        const item = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
                            ? entry
                            : {};
                        const status = item.status === 'completed' || item.status === 'in_progress' ? item.status : 'pending';
                        return {
                            content: String(item.text ?? item.content ?? 'step'),
                            priority: 'medium',
                            status
                        };
                    })
                });
                return;
            }
            case 'approval_request': {
                const requestingLoop = session.loop;
                if (!requestingLoop)
                    return;
                const toolCallId = String(event.toolCallId ?? '');
                if (!toolCallId)
                    return;
                const args = event.args !== null && typeof event.args === 'object' && !Array.isArray(event.args)
                    ? event.args
                    : {};
                const tool = String(event.tool ?? 'tool');
                const toolCall = {
                    toolCallId,
                    title: toolTitle(tool, args),
                    kind: toolKind(tool),
                    status: 'pending',
                    rawInput: args
                };
                const options = [
                    { optionId: 'allow_once', name: 'Allow this action', kind: 'allow_once' },
                    { optionId: 'allow_always', name: 'Always allow this tool in this conversation', kind: 'allow_always' },
                    { optionId: 'reject_once', name: 'Reject this action', kind: 'reject_once' }
                ];
                void this.sendClientRequest(session, ACP_METHODS.REQUEST_PERMISSION, {
                    sessionId: session.id,
                    toolCall,
                    options
                }).then((response) => {
                    if (session.cancelled || session.loop !== requestingLoop || this.sessions.get(session.id) !== session) {
                        requestingLoop.handleApprovalResponse(toolCallId, false);
                        return;
                    }
                    const outcome = response && typeof response.outcome === 'object' && response.outcome !== null
                        ? response.outcome
                        : null;
                    const selected = outcome && outcome.outcome === 'selected' && typeof outcome.optionId === 'string'
                        ? outcome.optionId
                        : '';
                    const canonicalTool = tool.replace(/\./g, '_');
                    if (selected === 'allow_always')
                        session.approvalScope.grantAlways(canonicalTool);
                    const approved = selected === 'allow_once' || selected === 'allow_always';
                    requestingLoop.handleApprovalResponse(toolCallId, approved);
                }).catch(() => {
                    requestingLoop.handleApprovalResponse(toolCallId, false);
                });
                return;
            }
            default:
                return;
        }
    }
    notify(sessionId, update) {
        const notification = {
            jsonrpc: '2.0',
            method: ACP_METHODS.UPDATE,
            params: { sessionId, update }
        };
        this.write(notification);
    }
    setMode(params) {
        if (!params || typeof params.modeId !== 'string')
            throw this.paramsError('session/set_mode requires modeId');
        const session = this.requireSession(params.sessionId);
        if (!MODES.availableModes.some((mode) => mode.id === params.modeId)) {
            throw this.paramsError(`Unknown mode: ${params.modeId}`);
        }
        session.modeId = params.modeId;
        session.updatedAt = Date.now();
        const autonomy = MODE_TO_AUTONOMY[session.modeId];
        if (autonomy && session.loop) {
            try {
                session.loop.setAutonomyMode(autonomy);
            }
            catch {
                // The running loop keeps its mode; the next turn picks the new one.
            }
        }
        this.notify(session.id, { sessionUpdate: 'current_mode_update', currentModeId: session.modeId });
        return {};
    }
    setModel(params) {
        if (!params || typeof params.modelId !== 'string' || !params.modelId.trim()) {
            throw this.paramsError('session/set_model requires a non-empty modelId');
        }
        const session = this.requireSession(params.sessionId);
        const modelId = params.modelId.trim();
        if (modelId.length > 200)
            throw this.paramsError('modelId is too long');
        session.model = modelId === 'default' ? undefined : modelId;
        session.updatedAt = Date.now();
        const { configOptions } = this.buildSessionCatalog(session);
        if (configOptions) {
            this.notify(session.id, { sessionUpdate: 'config_option_update', configOptions });
        }
        return configOptions ? { configOptions } : {};
    }
    setConfigOption(params) {
        if (!params || typeof params.configId !== 'string' || typeof params.value !== 'string') {
            throw this.paramsError('session/set_config_option requires configId and value');
        }
        const session = this.requireSession(params.sessionId);
        const configId = params.configId.trim().toLowerCase();
        const value = params.value.trim();
        if (!value || value.length > 200)
            throw this.paramsError('Invalid config option value');
        if (configId === 'model') {
            session.model = value === 'default' ? undefined : value;
        }
        else if (configId === 'thought_level' || configId === 'reasoning_effort' || configId === 'thinking' || configId === 'effort') {
            session.variant = value === 'default' || value === 'auto' ? undefined : value;
        }
        else {
            throw this.paramsError(`Unknown config option: ${params.configId}`);
        }
        session.updatedAt = Date.now();
        const { configOptions } = this.buildSessionCatalog(session);
        if (configOptions) {
            this.notify(session.id, { sessionUpdate: 'config_option_update', configOptions });
        }
        return configOptions ? { configOptions } : {};
    }
    canonicalizePath(targetPath) {
        const resolved = path.resolve(targetPath);
        try {
            return fs.realpathSync(resolved);
        }
        catch {
            return resolved;
        }
    }
    listSessions(params) {
        const filter = params && typeof params.cwd === 'string' ? this.canonicalizePath(params.cwd) : null;
        const sessions = [];
        for (const session of this.sessions.values()) {
            if (filter && session.cwd !== filter)
                continue;
            sessions.push({
                sessionId: session.id,
                cwd: session.cwd,
                title: session.title,
                updatedAt: new Date(session.updatedAt).toISOString()
            });
        }
        sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
        return { sessions };
    }
    closeSession(params) {
        const session = this.requireSession(params?.sessionId);
        session.cancelled = true;
        session.generation++;
        this.rejectPendingForSession(session.id, 'session closed');
        try {
            session.loop?.abort();
        }
        catch {
            // Closing never blocks on cancellation.
        }
        this.sessions.delete(session.id);
        void unregisterSessionMcpServers(session.id);
        return {};
    }
    /** Resume a persisted conversation, replaying its transcript to the client. */
    loadSession(params) {
        if (!params || typeof params.sessionId !== 'string' || !params.sessionId) {
            throw this.paramsError('session/load requires sessionId');
        }
        const live = this.sessions.get(params.sessionId);
        if (live) {
            if (params.cwd !== undefined && this.resolveWorkspace(params.cwd) !== live.cwd) {
                throw this.paramsError('session workspace does not match cwd');
            }
            if (live.busy || live.pendingPrompts > 0) {
                throw this.paramsError('session is busy; cancel it before loading');
            }
            const mcpServers = this.parseSessionMcpServers(params.mcpServers, live.cwd);
            this.bindWorkspace(live.cwd);
            if (mcpServers.length > 0) {
                live.mcpServers = mcpServers;
                registerSessionMcpServers(live.id, mcpServers);
            }
            this.replayTranscript(live, getSession(live.memorySessionId)?.messages ?? []);
            return { modes: this.modesFor(live) };
        }
        const record = getSession(params.sessionId);
        if (!record)
            throw this.notFound(`Unknown session: ${params.sessionId}`);
        const requested = params.cwd ?? record.workspace;
        const cwd = this.resolveWorkspace(requested);
        if (record.workspace && this.canonicalizePath(record.workspace) !== cwd) {
            throw this.paramsError('session workspace does not match cwd');
        }
        const mcpServers = this.parseSessionMcpServers(params.mcpServers, cwd);
        this.bindWorkspace(cwd);
        const session = this.addSession(record.id, cwd, record.title, MODES.currentModeId);
        if (mcpServers.length > 0) {
            session.mcpServers = mcpServers;
            registerSessionMcpServers(session.id, mcpServers);
        }
        this.replayTranscript(session, record.messages);
        return { modes: this.modesFor(session) };
    }
    /**
     * Copy the conversation into a new session and deliberately start with a
     * fresh approval scope. Permissions are granted to a conversation, never to
     * the transcript, so a fork must ask again for anything dangerous.
     */
    forkSession(params) {
        if (!params || typeof params.sessionId !== 'string' || !params.sessionId) {
            throw this.paramsError('session/fork requires sessionId');
        }
        const source = this.sessions.get(params.sessionId);
        const sourceRecord = getSession(params.sessionId);
        if (!source && !sourceRecord)
            throw this.notFound(`Unknown session: ${params.sessionId}`);
        if (source && (source.busy || source.pendingPrompts > 0))
            throw this.paramsError('session is busy; cancel it before forking');
        const requested = params.cwd ?? source?.cwd ?? sourceRecord?.workspace;
        const cwd = this.resolveWorkspace(requested);
        if (source && source.cwd !== cwd)
            throw this.paramsError('fork must stay in the source workspace');
        if (sourceRecord?.workspace && this.canonicalizePath(sourceRecord.workspace) !== cwd) {
            throw this.paramsError('fork must stay in the source workspace');
        }
        this.bindWorkspace(cwd);
        const title = `Fork of ${source?.title || sourceRecord?.title || 'Untitled'}`;
        if (this.sessions.size >= MAX_SESSIONS) {
            throw this.paramsError(`Maximum concurrent sessions (${MAX_SESSIONS}) exceeded`);
        }
        const forked = forkSession(params.sessionId, { title, makeActive: false, workspace: cwd });
        if (!forked)
            throw this.paramsError('Failed to fork session journal');
        const session = this.addSession(forked.id, cwd, title, source?.modeId ?? MODES.currentModeId);
        return this.sessionResponse(session);
    }
    replayTranscript(session, messages) {
        for (const message of messages) {
            const role = typeof message.role === 'string' ? message.role : '';
            const text = textFromContent(message.content);
            if (!text)
                continue;
            if (role === 'user') {
                this.notify(session.id, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
            }
            else if (role === 'assistant') {
                this.notify(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
            }
        }
    }
    notFound(message) {
        const error = new Error(message);
        error.acpCode = ACP_ERROR_CODES.RESOURCE_NOT_FOUND;
        return error;
    }
    rejectPendingForSession(sessionId, reason) {
        for (const [id, pending] of this.pending) {
            if (pending.sessionId !== sessionId)
                continue;
            clearTimeout(pending.timer);
            this.pending.delete(id);
            pending.reject(new Error(reason));
        }
    }
    sendClientRequest(session, method, params) {
        const id = `server-${this.nextClientRequestId++}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out`));
            }, this.permissionTimeoutMs);
            if (typeof timer.unref === 'function')
                timer.unref();
            this.pending.set(id, {
                sessionId: session.id,
                resolve: (value) => resolve(value),
                reject,
                timer
            });
            this.write({ jsonrpc: '2.0', id, method, params });
        });
    }
    resolveClientRequest(response) {
        if (response.id === null || response.id === undefined)
            return;
        const pending = this.pending.get(response.id);
        if (!pending)
            return;
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        if (response.error) {
            pending.reject(new Error(response.error.message));
            return;
        }
        pending.resolve(response.result);
    }
    writeResult(id, result) {
        this.write({ jsonrpc: '2.0', id, result });
    }
    writeError(id, code, message) {
        const error = { code, message };
        this.write({ jsonrpc: '2.0', id, error });
    }
    write(message) {
        if (!this.output || this.closed)
            return;
        try {
            this.output.write(`${JSON.stringify(message)}\n`);
        }
        catch {
            // A closed pipe must not crash the agent process.
        }
    }
}
export { MODES as ACP_SESSION_MODES };
