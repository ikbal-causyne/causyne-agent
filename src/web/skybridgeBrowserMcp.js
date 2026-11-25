/**
 * @file src/web/skybridgeBrowserMcp.ts
 * Model Context Protocol (MCP JSON-RPC 2.0) server for Causyne's live shared
 * workspace browser. Exposed additively over Skybridge Streamable HTTP
 * (`POST /api/mcp/browser`) and via stdio (`causyne browser-mcp`) so any
 * connected ACP peer (OpenCode, Claude Code, Codex, Cursor, Hermes, Goose)
 * can natively inspect, screenshot, navigate, and interact with the exact
 * same live browser tabs the user sees and controls beside the chat.
 *
 * Strictly additive per ACP capability policy: never strips peer-native tools,
 * inherited MCP servers, or workspace safety boundaries.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { causyneBrowser } from '../browser/causyneBrowser.js';
import { ensureSafeWorkspaceOutputPath } from '../browser/workspacePathSafety.js';
import { auditLog } from '../auditLog.js';
export const CAUSYNE_BROWSER_MCP_NAME = 'causyne-browser';
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set([
    '2024-11-05',
    '2025-03-26',
    '2025-06-18',
    '2025-11-25'
]);
const DEFAULT_MCP_PROTOCOL_VERSION = '2025-03-26';
export const CAUSYNE_BROWSER_MCP_TOOLS = [
    {
        name: 'browser_tabs',
        description: 'List all currently open tabs in Causyne\'s live shared workspace browser (visible beside the user\'s chat), including active tab ID, title, URL, engine, and display mode.',
        inputSchema: {
            type: 'object',
            properties: {
                ensureStarted: {
                    type: 'boolean',
                    description: 'If true and the browser is idle, start it before listing tabs. Defaults to false.'
                }
            },
            additionalProperties: false
        }
    },
    {
        name: 'browser_read_page',
        description: 'Inspect the live page currently open in Causyne\'s shared browser: returns URL, title, viewport dimensions, HTML5 video/audio playback state, visible page text, interactive accessibility tree with @ref handles, and runtime errors.',
        inputSchema: {
            type: 'object',
            properties: {
                tabId: {
                    type: 'string',
                    description: 'Optional tab ID from browser_tabs. Defaults to the currently active tab.'
                },
                maxChars: {
                    type: 'integer',
                    minimum: 500,
                    maximum: 24000,
                    description: 'Maximum visible text characters to include (default 8000).'
                },
                includeSnapshot: {
                    type: 'boolean',
                    description: 'Include interactive accessibility snapshot with @ref handles (default true).'
                }
            },
            additionalProperties: false
        }
    },
    {
        name: 'browser_screenshot',
        description: 'Capture a live visual screenshot of Causyne\'s shared browser viewport. Returns an inline image block directly for visual inspection, plus URL/title/media timestamp metadata. Supports capturing 1 to 4 sequential frames (frames + intervalMs) to inspect motion, animations, or video playback.',
        inputSchema: {
            type: 'object',
            properties: {
                tabId: {
                    type: 'string',
                    description: 'Optional tab ID to capture. Defaults to the active tab.'
                },
                fullPage: {
                    type: 'boolean',
                    description: 'Capture full scrollable page instead of current viewport (default false; ignored when frames > 1).'
                },
                frames: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 4,
                    description: 'Number of sequential live viewport frames to capture for analyzing motion or video (1-4, default 1).'
                },
                intervalMs: {
                    type: 'integer',
                    minimum: 250,
                    maximum: 1500,
                    description: 'Delay in milliseconds between sequential frames when frames > 1 (250-1500, default 650).'
                },
                savePath: {
                    type: 'string',
                    description: 'Optional workspace-relative file path to also save the captured JPEG image.'
                }
            },
            additionalProperties: false
        }
    },
    {
        name: 'browser_navigate',
        description: 'Navigate or manage tabs in Causyne\'s live shared browser visible to the user (goto URL, open newTab, switchTab, closeTab, back, forward, reload, or web search).',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['goto', 'newTab', 'switchTab', 'closeTab', 'back', 'forward', 'reload', 'search'],
                    description: 'Navigation or tab operation to perform.'
                },
                url: {
                    type: 'string',
                    description: 'Target http/https URL (for goto or newTab).'
                },
                query: {
                    type: 'string',
                    description: 'Search query (for action="search").'
                },
                tabId: {
                    type: 'string',
                    description: 'Target tab ID (for switchTab, closeTab, or targeting a specific tab).'
                }
            },
            required: ['action'],
            additionalProperties: false
        }
    },
    {
        name: 'browser_interact',
        description: 'Operate the active page in Causyne\'s live shared browser: click by @ref, CSS selector, or viewport (x, y) coordinates; type text; press a key (e.g. Space, Enter, Escape, ArrowRight); scroll; hover; select dropdown option; or wait.',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['click', 'type', 'key', 'scroll', 'hover', 'select', 'wait'],
                    description: 'Interaction to perform on the live page.'
                },
                ref: {
                    type: 'string',
                    description: 'Interactive element @ref handle from browser_read_page (e.g. "@e3" or "e3").'
                },
                selector: {
                    type: 'string',
                    description: 'CSS selector when not using ref or coordinates.'
                },
                x: {
                    type: 'number',
                    description: 'Viewport X coordinate in pixels (used with y for coordinate click).'
                },
                y: {
                    type: 'number',
                    description: 'Viewport Y coordinate in pixels (used with x for coordinate click).'
                },
                text: {
                    type: 'string',
                    description: 'Text to enter (for action="type").'
                },
                key: {
                    type: 'string',
                    description: 'Keyboard key name (for action="key", e.g. "Space", "Enter", "Escape", "k").'
                },
                direction: {
                    type: 'string',
                    enum: ['up', 'down'],
                    description: 'Scroll direction (for action="scroll").'
                },
                deltaY: {
                    type: 'number',
                    description: 'Scroll pixel delta (positive scrolls down, negative scrolls up).'
                },
                value: {
                    type: 'string',
                    description: 'Option value or label (for action="select").'
                },
                ms: {
                    type: 'integer',
                    minimum: 100,
                    maximum: 5000,
                    description: 'Milliseconds to wait (for action="wait", default 500).'
                },
                tabId: {
                    type: 'string',
                    description: 'Optional tab ID to focus before interacting.'
                }
            },
            required: ['action'],
            additionalProperties: false
        }
    },
    {
        name: 'browser_extract',
        description: 'Extract structured content from the currently open tab in Causyne\'s live shared browser: visible text, links, images, or form/table structure.',
        inputSchema: {
            type: 'object',
            properties: {
                mode: {
                    type: 'string',
                    enum: ['text', 'links', 'images', 'forms'],
                    description: 'Kind of structured data to extract (default "text").'
                },
                selector: {
                    type: 'string',
                    description: 'Optional CSS selector scope when mode="text".'
                },
                tabId: {
                    type: 'string',
                    description: 'Optional tab ID. Defaults to the active tab.'
                },
                maxChars: {
                    type: 'integer',
                    minimum: 500,
                    maximum: 24000,
                    description: 'Maximum text length to return (default 10000).'
                }
            },
            additionalProperties: false
        }
    }
];
function cleanStr(value, maxLen = 500) {
    return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}
function clampInt(value, min, max, fallback) {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
    return Math.max(min, Math.min(max, n));
}
function formatError(err) {
    return err instanceof Error ? err.message : String(err);
}
function summarizeAwarenessText(ctx) {
    if (!ctx.active) {
        return JSON.stringify({
            active: false,
            visible: ctx.visible,
            engine: ctx.engine,
            tabs: [],
            note: 'Causyne shared browser is currently idle. Call browser_navigate to open a URL.'
        }, null, 2);
    }
    return JSON.stringify({
        active: true,
        visible: ctx.visible,
        engine: ctx.engine,
        activeTabId: ctx.activeTabId,
        url: ctx.url,
        title: ctx.title,
        viewport: ctx.viewport,
        tabs: ctx.tabs
    }, null, 2);
}
async function executeBrowserMcpTool(toolName, args, options) {
    const browser = causyneBrowser({ workspace: options.workspaceRoot });
    const tabId = cleanStr(args.tabId, 120) || undefined;
    if (toolName === 'browser_tabs') {
        if (args.ensureStarted === true && !browser.isActive()) {
            await browser.captureLiveFrame({ ensureStarted: true });
        }
        const ctx = browser.getLiveAwarenessContext();
        return {
            content: [{ type: 'text', text: summarizeAwarenessText(ctx) }]
        };
    }
    if (toolName === 'browser_read_page') {
        const maxChars = clampInt(args.maxChars, 500, 24000, 8000);
        const includeSnapshot = args.includeSnapshot !== false;
        const summary = await browser.inspectPageForAgent({
            tabId,
            maxChars,
            includeSnapshot
        });
        const lines = [
            `URL: ${summary.url || '(blank)'}`,
            `Title: ${summary.title || '(untitled)'}`,
            `Tab: ${summary.tabId} (${summary.tabs.length} open tab${summary.tabs.length === 1 ? '' : 's'})`,
            `Viewport: ${summary.viewport.width}x${summary.viewport.height} (${summary.engine || 'browser'}${summary.visible ? ', native window' : ', embedded live panel'})`
        ];
        if (summary.media.length > 0) {
            lines.push('', 'Media Elements:');
            for (const m of summary.media) {
                const stateLabel = m.error
                    ? `error="${m.error}"`
                    : (m.paused ? 'paused' : 'playing');
                const timing = Number.isFinite(m.duration) && m.duration > 0
                    ? `${m.currentTime.toFixed(1)}s / ${m.duration.toFixed(1)}s`
                    : `${m.currentTime.toFixed(1)}s`;
                const dims = m.width > 0 && m.height > 0 ? ` ${m.width}x${m.height}` : '';
                lines.push(`- <${m.tag}> ${stateLabel} (${timing}${dims}, readyState=${m.readyState})`);
            }
        }
        if (summary.visibleText) {
            lines.push('', 'Visible Page Text:', summary.visibleText);
        }
        if (includeSnapshot && summary.snapshot) {
            lines.push('', `Interactive Accessibility Tree (${summary.refsCount} refs):`, summary.snapshot);
        }
        if (summary.runtimeErrors.length > 0) {
            lines.push('', 'Runtime Errors:', ...summary.runtimeErrors.map((e) => `- ${e}`));
        }
        return {
            content: [{ type: 'text', text: lines.join('\n') }]
        };
    }
    if (toolName === 'browser_screenshot') {
        const frameCount = clampInt(args.frames, 1, 4, 1);
        const intervalMs = clampInt(args.intervalMs, 250, 1500, 650);
        const fullPage = frameCount === 1 && args.fullPage === true;
        const rawSavePath = cleanStr(args.savePath, 400);
        const content = [];
        const notes = [];
        for (let i = 0; i < frameCount; i += 1) {
            if (i > 0) {
                await new Promise((resolve) => setTimeout(resolve, intervalMs));
            }
            const shot = await browser.captureViewportBuffer({
                tabId,
                fullPage,
                quality: frameCount > 1 ? 68 : 78
            });
            if (i === 0 && rawSavePath) {
                const absTarget = path.resolve(options.workspaceRoot, rawSavePath);
                await ensureSafeWorkspaceOutputPath(options.workspaceRoot, absTarget);
                await fs.writeFile(absTarget, shot.buffer);
                notes.push(`Saved screenshot to ${path.relative(options.workspaceRoot, absTarget)}`);
            }
            const mediaNote = shot.mediaTimeSeconds !== null
                ? `, videoTime=${shot.mediaTimeSeconds.toFixed(2)}s${shot.mediaPaused ? ' (paused)' : ' (playing)'}`
                : '';
            notes.push(`Frame ${i + 1}/${frameCount}: "${shot.title || '(untitled)'}" (${shot.url}) ${shot.width}x${shot.height}${mediaNote}`);
            content.push({
                type: 'image',
                mimeType: shot.mimeType,
                data: shot.buffer.toString('base64')
            });
        }
        content.unshift({
            type: 'text',
            text: notes.join('\n')
        });
        return { content };
    }
    if (toolName === 'browser_navigate') {
        const action = cleanStr(args.action, 32);
        const url = cleanStr(args.url, 2000);
        const query = cleanStr(args.query, 500);
        let browserAction;
        if (action === 'goto') {
            if (!url)
                throw new Error('browser_navigate action="goto" requires url.');
            browserAction = { type: 'goto', url, ...(tabId ? { tabId } : {}) };
        }
        else if (action === 'newTab') {
            browserAction = { type: 'newTab', ...(url ? { url } : {}) };
        }
        else if (action === 'switchTab') {
            if (!tabId)
                throw new Error('browser_navigate action="switchTab" requires tabId.');
            browserAction = { type: 'switchTab', tabId };
        }
        else if (action === 'closeTab') {
            if (!tabId)
                throw new Error('browser_navigate action="closeTab" requires tabId.');
            browserAction = { type: 'closeTab', tabId };
        }
        else if (action === 'back' || action === 'forward' || action === 'reload') {
            browserAction = { type: action, ...(tabId ? { tabId } : {}) };
        }
        else if (action === 'search') {
            if (!query)
                throw new Error('browser_navigate action="search" requires query.');
            browserAction = { type: 'search', query };
        }
        else {
            throw new Error(`Unsupported browser_navigate action: ${action}`);
        }
        const results = await browser.run([browserAction], { workspace: options.workspaceRoot });
        const ctx = browser.getLiveAwarenessContext();
        const first = results[0];
        return {
            content: [{
                    type: 'text',
                    text: JSON.stringify({
                        ok: true,
                        action,
                        url: ctx.url,
                        title: ctx.title,
                        activeTabId: ctx.activeTabId,
                        tabsCount: ctx.tabs.length,
                        ...(first?.output ? { output: first.output.slice(0, 4000) } : {}),
                        ...(first?.data ? { data: first.data } : {})
                    }, null, 2)
                }]
        };
    }
    if (toolName === 'browser_interact') {
        const action = cleanStr(args.action, 32);
        const ref = cleanStr(args.ref, 40);
        const selector = cleanStr(args.selector, 400);
        const text = typeof args.text === 'string' ? args.text.slice(0, 4000) : '';
        const key = cleanStr(args.key, 64);
        const value = cleanStr(args.value, 400);
        if (tabId) {
            await browser.run([{ type: 'switchTab', tabId }], { workspace: options.workspaceRoot });
        }
        if (action === 'click' && typeof args.x === 'number' && typeof args.y === 'number' && !ref && !selector) {
            const frame = await browser.interactAt({ kind: 'click', x: args.x, y: args.y });
            return {
                content: [{
                        type: 'text',
                        text: JSON.stringify({ ok: true, action: 'click', x: args.x, y: args.y, url: frame.url, title: frame.title })
                    }]
            };
        }
        if (action === 'scroll') {
            const deltaY = typeof args.deltaY === 'number' && Number.isFinite(args.deltaY)
                ? Math.max(-2400, Math.min(2400, args.deltaY))
                : (args.direction === 'up' ? -600 : 600);
            const frame = await browser.interactAt({ kind: 'wheel', deltaX: 0, deltaY });
            return {
                content: [{
                        type: 'text',
                        text: JSON.stringify({ ok: true, action: 'scroll', deltaY, url: frame.url, title: frame.title })
                    }]
            };
        }
        if (action === 'key') {
            if (!key)
                throw new Error('browser_interact action="key" requires key.');
            const frame = await browser.interactAt({ kind: 'key', key });
            return {
                content: [{
                        type: 'text',
                        text: JSON.stringify({ ok: true, action: 'key', key, url: frame.url, title: frame.title })
                    }]
            };
        }
        if (action === 'wait') {
            const ms = clampInt(args.ms, 100, 5000, 500);
            await browser.run([{ type: 'wait', timeout: ms }], { workspace: options.workspaceRoot });
            const ctx = browser.getLiveAwarenessContext();
            return {
                content: [{
                        type: 'text',
                        text: JSON.stringify({ ok: true, action: 'wait', ms, url: ctx.url, title: ctx.title })
                    }]
            };
        }
        if (action === 'click' || action === 'hover') {
            if (!ref && !selector) {
                throw new Error(`browser_interact action="${action}" requires ref, selector, or (x, y) coordinates.`);
            }
            await browser.run([{
                    type: action,
                    ...(ref ? { ref } : { selector })
                }], { workspace: options.workspaceRoot });
            const ctx = browser.getLiveAwarenessContext();
            return {
                content: [{
                        type: 'text',
                        text: JSON.stringify({ ok: true, action, target: ref || selector, url: ctx.url, title: ctx.title })
                    }]
            };
        }
        if (action === 'type') {
            if (!text)
                throw new Error('browser_interact action="type" requires text.');
            if (ref || selector) {
                await browser.run([{
                        type: 'type',
                        text,
                        ...(ref ? { ref } : { selector })
                    }], { workspace: options.workspaceRoot });
            }
            else {
                await browser.interactAt({ kind: 'type', text });
            }
            const ctx = browser.getLiveAwarenessContext();
            return {
                content: [{
                        type: 'text',
                        text: JSON.stringify({ ok: true, action: 'type', length: text.length, url: ctx.url, title: ctx.title })
                    }]
            };
        }
        if (action === 'select') {
            if (!value || (!ref && !selector)) {
                throw new Error('browser_interact action="select" requires value and ref or selector.');
            }
            await browser.run([{
                    type: 'select',
                    value,
                    ...(ref ? { ref } : { selector })
                }], { workspace: options.workspaceRoot });
            const ctx = browser.getLiveAwarenessContext();
            return {
                content: [{
                        type: 'text',
                        text: JSON.stringify({ ok: true, action: 'select', value, url: ctx.url, title: ctx.title })
                    }]
            };
        }
        throw new Error(`Unsupported browser_interact action: ${action}`);
    }
    if (toolName === 'browser_extract') {
        const mode = cleanStr(args.mode, 32) || 'text';
        const selector = cleanStr(args.selector, 400);
        const maxChars = clampInt(args.maxChars, 500, 24000, 10000);
        if (tabId) {
            await browser.run([{ type: 'switchTab', tabId }], { workspace: options.workspaceRoot });
        }
        if (mode === 'links') {
            const res = await browser.run([{ type: 'links' }], { workspace: options.workspaceRoot });
            return {
                content: [{ type: 'text', text: JSON.stringify(res[0]?.data ?? res[0]?.output ?? [], null, 2).slice(0, maxChars) }]
            };
        }
        if (mode === 'images') {
            const res = await browser.run([{ type: 'images' }], { workspace: options.workspaceRoot });
            return {
                content: [{ type: 'text', text: JSON.stringify(res[0]?.data ?? res[0]?.output ?? [], null, 2).slice(0, maxChars) }]
            };
        }
        if (mode === 'forms') {
            const snap = await browser.snapshot(0);
            return {
                content: [{
                        type: 'text',
                        text: JSON.stringify({
                            url: snap.url,
                            title: snap.title,
                            structure: snap.structure ?? { forms: [], tables: [] }
                        }, null, 2).slice(0, maxChars)
                    }]
            };
        }
        const res = await browser.run([{
                type: 'extract',
                ...(selector ? { selector } : {})
            }], { workspace: options.workspaceRoot });
        const text = res[0]?.output || JSON.stringify(res[0]?.data ?? '');
        return {
            content: [{ type: 'text', text: text.slice(0, maxChars) }]
        };
    }
    throw new Error(`Unknown causyne-browser MCP tool: ${toolName}`);
}
export async function handleBrowserMcpRpc(message, options) {
    const method = typeof message.method === 'string' ? message.method : '';
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== undefined;
    const id = hasId ? (message.id ?? null) : null;
    if (!method) {
        if (!hasId)
            return null;
        return {
            jsonrpc: '2.0',
            id,
            error: { code: -32600, message: 'Invalid JSON-RPC request: method is required.' }
        };
    }
    if (method.startsWith('notifications/') || !hasId) {
        return null;
    }
    if (method === 'initialize') {
        const requested = typeof message.params?.protocolVersion === 'string'
            ? message.params.protocolVersion
            : DEFAULT_MCP_PROTOCOL_VERSION;
        const protocolVersion = SUPPORTED_MCP_PROTOCOL_VERSIONS.has(requested)
            ? requested
            : DEFAULT_MCP_PROTOCOL_VERSION;
        return {
            jsonrpc: '2.0',
            id,
            result: {
                protocolVersion,
                capabilities: {
                    tools: { listChanged: false }
                },
                serverInfo: {
                    name: CAUSYNE_BROWSER_MCP_NAME,
                    version: options.version
                },
                instructions: 'Causyne Shared Browser MCP controls the live workspace browser displayed beside the user\'s chat. '
                    + 'Both you and the user share and operate these exact tabs. Use browser_tabs, browser_read_page, '
                    + 'browser_screenshot, browser_navigate, browser_interact, and browser_extract whenever the user '
                    + 'references the browser, open tabs, pages, or videos.'
            }
        };
    }
    if (method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} };
    }
    if (method === 'tools/list') {
        return {
            jsonrpc: '2.0',
            id,
            result: { tools: CAUSYNE_BROWSER_MCP_TOOLS }
        };
    }
    if (method === 'resources/list') {
        return { jsonrpc: '2.0', id, result: { resources: [] } };
    }
    if (method === 'prompts/list') {
        return { jsonrpc: '2.0', id, result: { prompts: [] } };
    }
    if (method === 'tools/call') {
        const params = message.params && typeof message.params === 'object' ? message.params : {};
        const toolName = cleanStr(params.name, 80);
        const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
            ? params.arguments
            : {};
        if (!toolName) {
            return {
                jsonrpc: '2.0',
                id,
                error: { code: -32602, message: 'tools/call requires params.name.' }
            };
        }
        const detail = cleanStr(args.action || args.url || args.query || args.ref || args.selector || '', 80);
        auditLog.log({ event: 'browser_mcp_tool_call', tool: toolName, detail });
        options.onActivity?.({ phase: 'start', tool: toolName, detail });
        try {
            const result = await executeBrowserMcpTool(toolName, args, options);
            return { jsonrpc: '2.0', id, result };
        }
        catch (err) {
            const errText = formatError(err);
            auditLog.log({ event: 'browser_mcp_tool_error', tool: toolName, error: errText.slice(0, 300) });
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    content: [{ type: 'text', text: `Shared browser tool error (${toolName}): ${errText}` }],
                    isError: true
                }
            };
        }
        finally {
            options.onActivity?.({ phase: 'end', tool: toolName, detail });
        }
    }
    return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
    };
}
function isLoopbackBridgeUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
    }
    catch {
        return false;
    }
}
/**
 * Stdio MCP bridge for ACP peers that do not advertise Streamable HTTP MCP.
 * When CAUSYNE_SKYBRIDGE_URL and CAUSYNE_SKYBRIDGE_TOKEN are provided, every
 * JSON-RPC message is proxied over loopback to Skybridge so the peer operates
 * on the exact same live browser session visible in the user's Browser Panel.
 * Otherwise operates directly against the workspace's CausyneBrowser instance.
 */
export async function startBrowserMcpStdioServer(options) {
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stdout;
    const bridgeUrl = cleanStr(process.env.CAUSYNE_SKYBRIDGE_URL, 300);
    const bridgeToken = cleanStr(process.env.CAUSYNE_SKYBRIDGE_TOKEN, 256);
    const useRemoteBridge = Boolean(bridgeUrl && bridgeToken && isLoopbackBridgeUrl(bridgeUrl));
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    const writeReply = (reply) => {
        try {
            output.write(`${JSON.stringify(reply)}\n`);
        }
        catch {
            // Peer closed stdout.
        }
    };
    for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line)
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            writeReply({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32700, message: 'Parse error: invalid JSON.' }
            });
            continue;
        }
        if (useRemoteBridge) {
            try {
                const res = await fetch(bridgeUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${bridgeToken}`
                    },
                    body: JSON.stringify(parsed)
                });
                if (res.status === 202 || res.status === 204)
                    continue;
                const text = await res.text();
                if (!text.trim())
                    continue;
                const remoteReply = JSON.parse(text);
                writeReply(remoteReply);
            }
            catch (err) {
                if (Object.prototype.hasOwnProperty.call(parsed, 'id') && parsed.id !== undefined) {
                    writeReply({
                        jsonrpc: '2.0',
                        id: parsed.id ?? null,
                        error: { code: -32603, message: `Skybridge browser MCP proxy error: ${formatError(err)}` }
                    });
                }
            }
            continue;
        }
        const reply = await handleBrowserMcpRpc(parsed, {
            workspaceRoot: options.workspaceRoot,
            version: options.version
        });
        if (reply)
            writeReply(reply);
    }
}
