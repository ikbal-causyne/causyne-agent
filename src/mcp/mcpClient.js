import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, SSEClientTransport, SdkError, SdkErrorCode, SdkHttpError, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { getPackageVersion } from '../version.js';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const STDERR_LIMIT_BYTES = 8 * 1024;
const TOOL_OUTPUT_LIMIT_CHARS = 1_000_000;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isStringRecord(value) {
    return isRecord(value) && Object.values(value).every(item => typeof item === 'string');
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isAuthenticationError(error) {
    if (error instanceof UnauthorizedError)
        return true;
    if (error instanceof SdkHttpError)
        return error.status === 401;
    return error instanceof SdkError && error.code === SdkErrorCode.ClientHttpAuthentication;
}
function normalizedTimeout(value) {
    if (value === undefined)
        return DEFAULT_TIMEOUT_MS;
    return Math.max(1_000, Math.min(MAX_TIMEOUT_MS, value));
}
function validateStringArray(value, label) {
    if (!Array.isArray(value))
        return `${label} must be an array`;
    if (!value.every(item => typeof item === 'string' && !item.includes('\0'))) {
        return `${label} must contain only strings without NUL characters`;
    }
    return null;
}
function normalizeTool(tool) {
    if (typeof tool.name !== 'string' || tool.name.trim().length === 0)
        return null;
    const inputSchema = isRecord(tool.inputSchema)
        ? tool.inputSchema
        : { type: 'object', properties: {} };
    const normalized = {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        inputSchema
    };
    if (isRecord(tool.annotations))
        normalized.annotations = tool.annotations;
    return normalized;
}
function describeContentBlock(block) {
    if (!isRecord(block) || typeof block.type !== 'string')
        return '';
    if (block.type === 'text' && typeof block.text === 'string')
        return block.text;
    if ((block.type === 'image' || block.type === 'audio') && typeof block.data === 'string') {
        const mime = typeof block.mimeType === 'string' ? block.mimeType : 'application/octet-stream';
        const estimatedBytes = Math.floor(block.data.length * 0.75);
        return `[MCP ${block.type}: ${mime}, ${estimatedBytes} encoded bytes]`;
    }
    if (block.type === 'resource_link') {
        const uri = typeof block.uri === 'string' ? block.uri : '(unknown URI)';
        const name = typeof block.name === 'string' ? ` ${block.name}` : '';
        return `[MCP resource link:${name} ${uri}]`;
    }
    if (block.type === 'resource' && isRecord(block.resource)) {
        const resource = block.resource;
        const uri = typeof resource.uri === 'string' ? resource.uri : '(unknown URI)';
        if (typeof resource.text === 'string')
            return `[MCP resource ${uri}]\n${resource.text}`;
        if (typeof resource.blob === 'string') {
            const mime = typeof resource.mimeType === 'string' ? resource.mimeType : 'application/octet-stream';
            return `[MCP resource ${uri}: ${mime}, ${Math.floor(resource.blob.length * 0.75)} encoded bytes]`;
        }
        return `[MCP resource ${uri}]`;
    }
    try {
        return JSON.stringify(block);
    }
    catch {
        return `[MCP ${block.type} content]`;
    }
}
function boundedOutput(output) {
    return output.length > TOOL_OUTPUT_LIMIT_CHARS
        ? `${output.slice(0, TOOL_OUTPUT_LIMIT_CHARS)}\n\n[MCP output truncated at ${TOOL_OUTPUT_LIMIT_CHARS} characters]`
        : output;
}
function formatToolResult(result) {
    const content = Array.isArray(result.content)
        ? result.content.map(describeContentBlock).filter(Boolean).join('\n\n')
        : '';
    let output = content;
    if (!output && result.structuredContent !== undefined) {
        output = JSON.stringify(result.structuredContent, null, 2);
    }
    if (!output)
        output = JSON.stringify(result, null, 2);
    return boundedOutput(output);
}
function formatResourceContents(contents) {
    const output = contents.map(item => {
        if (!isRecord(item))
            return '';
        const uri = typeof item.uri === 'string' ? item.uri : '(unknown URI)';
        if (typeof item.text === 'string')
            return `[MCP resource ${uri}]\n${item.text}`;
        if (typeof item.blob === 'string') {
            const mime = typeof item.mimeType === 'string' ? item.mimeType : 'application/octet-stream';
            return `[MCP resource ${uri}: ${mime}, ${Math.floor(item.blob.length * 0.75)} encoded bytes]`;
        }
        return `[MCP resource ${uri}]`;
    }).filter(Boolean).join('\n\n');
    return boundedOutput(output);
}
function formatPromptMessages(messages) {
    const output = messages.map(message => {
        if (!isRecord(message))
            return '';
        const role = typeof message.role === 'string' ? message.role : 'unknown';
        return `[${role}] ${describeContentBlock(message.content)}`;
    }).filter(Boolean).join('\n\n');
    return boundedOutput(output);
}
export class McpConnectionError extends Error {
    state;
    constructor(state, message, options) {
        super(message, options);
        this.name = 'McpConnectionError';
        this.state = state;
    }
}
export class McpClient {
    name;
    definition;
    workspace;
    tools = [];
    serverInfo = null;
    instructions = null;
    status = { state: 'disconnected' };
    client = null;
    transport = null;
    stderrTail = '';
    closing = false;
    onStatus;
    onToolsChanged;
    constructor(definition, options = {}) {
        this.name = definition.name;
        this.definition = definition;
        this.workspace = path.resolve(options.workspace ?? process.cwd());
        this.onStatus = options.onStatus;
        this.onToolsChanged = options.onToolsChanged;
    }
    static validateDefinition(definition) {
        if (!isRecord(definition))
            return 'not an object';
        if (typeof definition.name !== 'string' || !/^[a-z0-9_-]{1,48}$/i.test(definition.name)) {
            return 'name must be 1-48 characters of [A-Za-z0-9_-]';
        }
        const hasStdio = typeof definition.command === 'string' && definition.command.trim().length > 0;
        const hasHttp = typeof definition.url === 'string' && definition.url.trim().length > 0;
        if (hasStdio === hasHttp)
            return 'exactly one of `command` (stdio) or `url` (HTTP) is required';
        if (hasStdio) {
            if (definition.command.includes('\0'))
                return '`command` must not contain a NUL character';
            if (definition.args !== undefined) {
                const problem = validateStringArray(definition.args, '`args`');
                if (problem)
                    return problem;
            }
            if (definition.env !== undefined && !isStringRecord(definition.env)) {
                return '`env` must be an object containing only string values';
            }
            if (definition.cwd !== undefined && (typeof definition.cwd !== 'string' || definition.cwd.includes('\0'))) {
                return '`cwd` must be a string without NUL characters';
            }
        }
        if (hasHttp) {
            let parsed;
            try {
                parsed = new URL(definition.url);
            }
            catch {
                return '`url` must be a valid URL';
            }
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return '`url` must use http or https';
            }
            if (parsed.username || parsed.password)
                return '`url` must not embed credentials; use headers or OAuth';
            if (definition.headers !== undefined && !isStringRecord(definition.headers)) {
                return '`headers` must be an object containing only string values';
            }
            if (isStringRecord(definition.headers)) {
                for (const [key, value] of Object.entries(definition.headers)) {
                    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(value)) {
                        return '`headers` contains an invalid name or value';
                    }
                }
            }
        }
        if (definition.timeoutMs !== undefined &&
            (typeof definition.timeoutMs !== 'number' || !Number.isFinite(definition.timeoutMs) || definition.timeoutMs < 1_000 || definition.timeoutMs > MAX_TIMEOUT_MS)) {
            return `\`timeoutMs\` must be between 1000 and ${MAX_TIMEOUT_MS}`;
        }
        if (definition.protocol !== undefined && definition.protocol !== 'legacy' && definition.protocol !== 'auto') {
            return '`protocol` must be "legacy" or "auto"';
        }
        if (definition.enabled !== undefined && typeof definition.enabled !== 'boolean') {
            return '`enabled` must be a boolean';
        }
        if (definition.tools !== undefined) {
            if (!isRecord(definition.tools))
                return '`tools` must be an object';
            for (const key of ['include', 'exclude']) {
                if (definition.tools[key] !== undefined) {
                    const problem = validateStringArray(definition.tools[key], `\`tools.${key}\``);
                    if (problem)
                        return problem;
                }
            }
        }
        return null;
    }
    async connect() {
        const problem = McpClient.validateDefinition(this.definition);
        if (problem)
            throw new McpConnectionError('failed', `invalid server definition: ${problem}`);
        if (this.definition.enabled === false) {
            this.setStatus({ state: 'disabled' });
            return this;
        }
        this.closing = false;
        this.setStatus({ state: 'connecting' });
        const timeout = normalizedTimeout(this.definition.timeoutMs);
        try {
            if (this.definition.url) {
                await this.connectRemote(timeout);
            }
            else {
                await this.connectStdio(timeout);
            }
            await this.refreshTools();
            return this;
        }
        catch (error) {
            await this.dispose();
            const state = isAuthenticationError(error) ? 'needs_auth' : 'failed';
            const suffix = this.stderrTail.trim() ? `: ${this.stderrTail.trim().slice(-600)}` : '';
            const message = `${errorMessage(error)}${suffix}`;
            this.setStatus({ state, error: message });
            throw new McpConnectionError(state, message, { cause: error });
        }
    }
    async refreshTools() {
        if (!this.client)
            throw new Error('MCP client is not connected');
        if (!this.client.getServerCapabilities()?.tools) {
            this.replaceTools([]);
            return this.tools;
        }
        const result = await this.client.listTools(undefined, {
            timeout: normalizedTimeout(this.definition.timeoutMs),
            cacheMode: 'refresh'
        });
        this.replaceTools(result.tools);
        return this.tools;
    }
    async callTool(toolName, args, signal) {
        if (!this.client || this.status.state !== 'connected') {
            return { success: false, error: `MCP server "${this.name}" is not connected` };
        }
        const toolDefinition = this.tools.find(tool => tool.name === toolName);
        if (!toolDefinition)
            return { success: false, error: `MCP server "${this.name}" does not advertise tool "${toolName}"` };
        try {
            const options = {
                timeout: normalizedTimeout(this.definition.timeoutMs),
                resetTimeoutOnProgress: true,
                maxTotalTimeout: MAX_TIMEOUT_MS,
                onprogress: () => { }
            };
            if (signal)
                options.signal = signal;
            const result = await this.client.callTool({ name: toolName, arguments: args }, options);
            const output = formatToolResult(result);
            if (result.isError)
                return { success: false, error: output || 'the MCP server reported an error' };
            const response = { success: true, output };
            if (result.structuredContent !== undefined)
                response.structuredContent = result.structuredContent;
            return response;
        }
        catch (error) {
            return { success: false, error: `MCP server "${this.name}": ${errorMessage(error)}` };
        }
    }
    supportsResources() {
        return Boolean(this.client?.getServerCapabilities()?.resources);
    }
    supportsPrompts() {
        return Boolean(this.client?.getServerCapabilities()?.prompts);
    }
    async listResources(signal) {
        if (!this.client || !this.supportsResources()) {
            return { success: false, error: `MCP server "${this.name}" does not advertise resources` };
        }
        try {
            const options = {
                timeout: normalizedTimeout(this.definition.timeoutMs),
                cacheMode: 'refresh'
            };
            if (signal)
                options.signal = signal;
            const [resourcesResult, templatesResult] = await Promise.allSettled([
                this.client.listResources(undefined, options),
                this.client.listResourceTemplates(undefined, options)
            ]);
            if (resourcesResult.status === 'rejected' && templatesResult.status === 'rejected') {
                throw resourcesResult.reason;
            }
            const warnings = [];
            if (resourcesResult.status === 'rejected')
                warnings.push(`resources/list: ${errorMessage(resourcesResult.reason)}`);
            if (templatesResult.status === 'rejected')
                warnings.push(`resources/templates/list: ${errorMessage(templatesResult.reason)}`);
            const payload = {
                resources: resourcesResult.status === 'fulfilled' ? resourcesResult.value.resources : [],
                resourceTemplates: templatesResult.status === 'fulfilled' ? templatesResult.value.resourceTemplates : []
            };
            if (warnings.length > 0)
                payload.warnings = warnings;
            return {
                success: true,
                output: boundedOutput(JSON.stringify(payload, null, 2))
            };
        }
        catch (error) {
            return { success: false, error: `MCP server "${this.name}": ${errorMessage(error)}` };
        }
    }
    async readResource(uri, signal) {
        if (!this.client || !this.supportsResources()) {
            return { success: false, error: `MCP server "${this.name}" does not advertise resources` };
        }
        try {
            const options = {
                timeout: normalizedTimeout(this.definition.timeoutMs),
                cacheMode: 'refresh'
            };
            if (signal)
                options.signal = signal;
            const result = await this.client.readResource({ uri }, options);
            return { success: true, output: formatResourceContents(result.contents) };
        }
        catch (error) {
            return { success: false, error: `MCP server "${this.name}": ${errorMessage(error)}` };
        }
    }
    async listPrompts(signal) {
        if (!this.client || !this.supportsPrompts()) {
            return { success: false, error: `MCP server "${this.name}" does not advertise prompts` };
        }
        try {
            const options = {
                timeout: normalizedTimeout(this.definition.timeoutMs),
                cacheMode: 'refresh'
            };
            if (signal)
                options.signal = signal;
            const result = await this.client.listPrompts(undefined, options);
            return { success: true, output: boundedOutput(JSON.stringify(result.prompts, null, 2)) };
        }
        catch (error) {
            return { success: false, error: `MCP server "${this.name}": ${errorMessage(error)}` };
        }
    }
    async getPrompt(name, args, signal) {
        if (!this.client || !this.supportsPrompts()) {
            return { success: false, error: `MCP server "${this.name}" does not advertise prompts` };
        }
        try {
            const options = { timeout: normalizedTimeout(this.definition.timeoutMs) };
            if (signal)
                options.signal = signal;
            const result = await this.client.getPrompt({ name, arguments: args }, options);
            const text = formatPromptMessages(result.messages);
            return { success: true, output: result.description ? `${result.description}\n\n${text}` : text };
        }
        catch (error) {
            return { success: false, error: `MCP server "${this.name}": ${errorMessage(error)}` };
        }
    }
    async close() {
        this.closing = true;
        await this.dispose();
        this.tools = [];
        this.setStatus({ state: 'disconnected' });
    }
    makeClient() {
        const client = new Client({ name: 'causyne-agent', version: getPackageVersion() }, {
            capabilities: { roots: {} },
            versionNegotiation: { mode: this.definition.protocol ?? 'legacy' },
            listMaxPages: 64,
            listChanged: {
                tools: {
                    onChanged: (error, result) => {
                        if (error) {
                            this.setStatus({ state: 'failed', error: `tool refresh failed: ${error.message}` });
                            return;
                        }
                        this.replaceTools(result ?? []);
                    }
                }
            }
        });
        client.setRequestHandler('roots/list', async () => ({
            roots: [{ uri: pathToFileURL(this.workspace).href, name: path.basename(this.workspace) || this.workspace }]
        }));
        client.onclose = () => {
            if (!this.closing)
                this.setStatus({ state: 'failed', error: 'connection closed by MCP server' });
        };
        client.onerror = error => {
            if (!this.closing)
                this.setStatus({ state: 'failed', error: error.message });
        };
        return client;
    }
    async connectStdio(timeout) {
        const definition = this.definition;
        if (!definition.command)
            throw new Error('stdio command is missing');
        const cwd = definition.cwd
            ? path.resolve(this.workspace, definition.cwd)
            : this.workspace;
        const transport = new StdioClientTransport({
            command: definition.command,
            args: definition.args ?? [],
            env: { ...getDefaultEnvironment(), ...(definition.env ?? {}) },
            cwd,
            stderr: 'pipe'
        });
        transport.stderr?.on('data', chunk => {
            this.stderrTail = (this.stderrTail + String(chunk)).slice(-STDERR_LIMIT_BYTES);
        });
        const client = this.makeClient();
        this.transport = transport;
        this.client = client;
        await client.connect(transport, { timeout });
        this.captureServer(client, 'stdio');
    }
    async connectRemote(timeout) {
        const definition = this.definition;
        if (!definition.url)
            throw new Error('HTTP URL is missing');
        const url = new URL(definition.url);
        const requestInit = definition.headers ? { headers: definition.headers } : undefined;
        try {
            const transport = new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
            const client = this.makeClient();
            this.transport = transport;
            this.client = client;
            await client.connect(transport, { timeout });
            this.captureServer(client, 'streamable-http');
        }
        catch (error) {
            if (isAuthenticationError(error))
                throw error;
            await this.dispose();
            const transport = new SSEClientTransport(url, requestInit ? { requestInit } : undefined);
            const client = this.makeClient();
            this.transport = transport;
            this.client = client;
            await client.connect(transport, { timeout });
            this.captureServer(client, 'sse');
        }
    }
    captureServer(client, transport) {
        const server = client.getServerVersion();
        this.serverInfo = server ? { name: server.name, version: server.version } : null;
        this.instructions = client.getInstructions()?.trim() || null;
        const status = { state: 'connected', connectedAt: Date.now() };
        if (transport)
            status.transport = transport;
        this.setStatus(status);
    }
    replaceTools(tools) {
        this.tools = tools.map(normalizeTool).filter((tool) => tool !== null);
        this.onToolsChanged?.([...this.tools]);
    }
    setStatus(status) {
        this.status = status;
        this.onStatus?.({ ...status });
    }
    async dispose() {
        const client = this.client;
        const transport = this.transport;
        this.client = null;
        this.transport = null;
        if (transport instanceof StreamableHTTPClientTransport) {
            try {
                await transport.terminateSession();
            }
            catch { }
        }
        if (client) {
            try {
                await client.close();
            }
            catch { }
        }
        else if (transport) {
            try {
                await transport.close();
            }
            catch { }
        }
    }
}
