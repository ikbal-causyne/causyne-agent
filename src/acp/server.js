import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AgentLoop } from '../agentLoop.js';
import { createApprovalScope } from '../approvalGrants.js';
import { createSession, getSession, saveSessionMessages, forkSession } from '../sessionJournal.js';
import { ACP_ERROR_CODES, ACP_METHODS, ACP_PROTOCOL_VERSION, isJsonRpcNotification, isJsonRpcRequest, isJsonRpcResponse } from './protocol.js';
const MODE_TO_AUTONOMY = {
    autonomous: 'A',
    standard: 'B',
    supervised: 'C'
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
function textFromPrompt(prompt) {
    const parts = [];
    for (const block of prompt) {
        if (block.type !== 'text')
            return null;
        parts.push(block.text);
    }
    return parts.join('\n').slice(0, MAX_PROMPT_CHARS);
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
    const suffix = typeof detail === 'string' && detail.trim() ? ` ${detail.trim()}` : '';
    const title = `${name}${suffix}`;
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
    pending = new Map();
    nextClientRequestId = 1;
    buffer = '';
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
        this.permissionTimeoutMs = options.permissionTimeoutMs ?? 10 * 60 * 1000;
    }
    start() {
        if (!this.input || this.dataListener)
            return;
        this.dataListener = (chunk) => {
            this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            void this.drainBuffer();
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
        for (const session of this.sessions.values()) {
            try {
                session.loop?.abort();
            }
            catch {
                // Shutdown never blocks on a misbehaving tool.
            }
        }
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error('server stopped'));
            this.pending.delete(id);
        }
    }
    async drainBuffer() {
        let index = this.buffer.indexOf('\n');
        while (index >= 0) {
            const line = this.buffer.slice(0, index).trim();
            this.buffer = this.buffer.slice(index + 1);
            if (line)
                await this.handleLine(line);
            index = this.buffer.indexOf('\n');
        }
    }
    async handleLine(line) {
        let parsed;
        try {
            parsed = JSON.parse(line);
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
    async handleNotification(notification) {
        if (notification.method === ACP_METHODS.CANCEL) {
            const params = notification.params;
            const session = params && typeof params.sessionId === 'string' ? this.sessions.get(params.sessionId) : undefined;
            if (session) {
                session.cancelled = true;
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
        if (!params || typeof params.protocolVersion !== 'number') {
            throw this.paramsError('initialize requires protocolVersion');
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
    newSession(params) {
        if (!params || typeof params.cwd !== 'string' || !params.cwd.trim()) {
            throw this.paramsError('session/new requires cwd');
        }
        if (Array.isArray(params.mcpServers) && params.mcpServers.length > 0) {
            throw this.paramsError('MCP servers are not supported by this agent');
        }
        if (Array.isArray(params.additionalDirectories) && params.additionalDirectories.length > 0) {
            throw this.paramsError('additionalDirectories is not supported by this agent');
        }
        const cwd = this.resolveWorkspace(params.cwd);
        this.bindWorkspace(cwd);
        const record = createSession(cwd, 'Untitled', false);
        const session = this.addSession(record.id, cwd, record.title, MODES.currentModeId);
        return this.sessionResponse(session);
    }
    resolveWorkspace(cwd) {
        if (typeof cwd !== 'string' || !cwd.trim())
            throw this.paramsError('cwd is required');
        try {
            const resolved = fs.realpathSync(path.resolve(cwd));
            if (!fs.statSync(resolved).isDirectory())
                throw new Error('not a directory');
            return resolved;
        }
        catch {
            throw this.paramsError(`cwd is not an accessible directory: ${cwd}`);
        }
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
        const session = {
            id,
            memorySessionId: id,
            title,
            cwd,
            modeId,
            loop: null,
            busy: false,
            cancelled: false,
            updatedAt: Date.now(),
            queue: Promise.resolve(),
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
    sessionResponse(session) {
        return {
            sessionId: session.id,
            modes: this.modesFor(session)
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
        session.queue = session.queue.then(() => this.runTurn(session, text), () => this.runTurn(session, text));
        const stopReason = await session.queue;
        return { stopReason };
    }
    async runTurn(session, text) {
        session.updatedAt = Date.now();
        session.cancelled = false;
        session.busy = true;
        const taskId = `acp-${crypto.randomUUID()}`;
        const sink = {
            readyState: 1,
            send: (payload) => this.onLoopPayload(session, payload)
        };
        const loopOptions = {
            workspaceRoot: session.cwd,
            memorySessionId: session.memorySessionId,
            approvalScope: session.approvalScope
        };
        const loop = this.loopFactory
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
        }
        catch {
            stopReason = 'refusal';
        }
        finally {
            session.loop = null;
            session.busy = false;
            const record = getSession(session.memorySessionId);
            if (record)
                session.title = record.title;
            if (session.cancelled)
                stopReason = 'cancelled';
        }
        return stopReason;
    }
    requestDecision(session, loop, request) {
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
            if (!response || response.outcome.outcome !== 'selected')
                return null;
            const optionId = response.outcome.optionId;
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
        this.onLoopEvent(session, event);
    }
    onLoopEvent(session, event) {
        switch (event.type) {
            case 'agent_message': {
                this.notify(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(event.content ?? '') } });
                return;
            }
            case 'agent_reasoning': {
                const text = String(event.content ?? '');
                if (text)
                    this.notify(session.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
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
                    const selected = response?.outcome.outcome === 'selected' ? response.outcome.optionId : '';
                    if (selected === 'allow_always')
                        session.approvalScope.grantAlways(tool);
                    const approved = selected === 'allow_once' || selected === 'allow_always';
                    session.loop?.handleApprovalResponse(toolCallId, approved);
                }).catch(() => {
                    session.loop?.handleApprovalResponse(toolCallId, false);
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
    listSessions(params) {
        const filter = params && typeof params.cwd === 'string' ? path.resolve(params.cwd) : null;
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
        try {
            session.loop?.abort();
        }
        catch {
            // Closing never blocks on cancellation.
        }
        this.sessions.delete(session.id);
        return {};
    }
    /** Resume a persisted conversation, replaying its transcript to the client. */
    loadSession(params) {
        if (!params || typeof params.sessionId !== 'string' || !params.sessionId) {
            throw this.paramsError('session/load requires sessionId');
        }
        const live = this.sessions.get(params.sessionId);
        if (live) {
            this.bindWorkspace(live.cwd);
            this.replayTranscript(live, getSession(live.memorySessionId)?.messages ?? []);
            return { modes: this.modesFor(live) };
        }
        const record = getSession(params.sessionId);
        if (!record)
            throw this.notFound(`Unknown session: ${params.sessionId}`);
        const requested = params.cwd ?? record.workspace;
        const cwd = this.resolveWorkspace(requested);
        if (record.workspace && path.resolve(record.workspace) !== cwd) {
            throw this.paramsError('session workspace does not match cwd');
        }
        this.bindWorkspace(cwd);
        const session = this.addSession(record.id, cwd, record.title, MODES.currentModeId);
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
        if (source?.busy)
            throw this.paramsError('session is busy; cancel it before forking');
        const requested = params.cwd ?? source?.cwd ?? sourceRecord?.workspace;
        const cwd = this.resolveWorkspace(requested);
        if (source && source.cwd !== cwd)
            throw this.paramsError('fork must stay in the source workspace');
        if (sourceRecord?.workspace && path.resolve(sourceRecord.workspace) !== cwd) {
            throw this.paramsError('fork must stay in the source workspace');
        }
        this.bindWorkspace(cwd);
        const title = `Fork of ${source?.title || sourceRecord?.title || 'Untitled'}`;
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
    sendClientRequest(session, method, params) {
        const id = `server-${this.nextClientRequestId++}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out`));
            }, this.permissionTimeoutMs);
            this.pending.set(id, {
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
