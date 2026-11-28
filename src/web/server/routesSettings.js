import path from 'node:path';
import { loadConfig, resolveProviderApiKey, saveConfig } from '../../config.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../../modelCatalogue.js';
import { getDefaultPermissionPreset, normalizePermissionPreset, setDefaultPermissionPreset } from '../../permissionPresets.js';
import { probeOsSandbox, resolveOsSandboxMode } from '../../tools/osSandbox.js';
import { deleteCausyneMemories, readPersonalizationOverview, saveMemoryPreferences, savePersonalizationInstructions } from '../../personalization.js';
import { discoverProjectMcpServers, serverStatus } from '../../mcp/mcpRegistry.js';
import { disablePlugin, enablePlugin, listPlugins, PLUGIN_ROOT } from '../../plugins/pluginManager.js';
import { auditLog } from '../../auditLog.js';
import { readJsonBody, sendJson } from './security.js';
const VAULT_PROVIDER_IDS = [
    'deepseek',
    'qwen',
    'dashscope-byok',
    'anthropic',
    'openai',
    'gemini',
    'moonshot',
    'xai',
    'openrouter',
    'groq',
    'cerebras',
    'mistral'
];
const ALLOWED_OS_SANDBOX_MODES = new Set([
    'off',
    'workspace-write',
    'strict',
    'read-only',
    'read-only-strict'
]);
const ALLOWED_EFFORT_LEVELS = new Set(['', 'off', 'low', 'medium', 'high', 'max']);
function buildHooksOverview(config) {
    const rawHooks = Array.isArray(config.hooks) ? config.hooks : [];
    const items = [];
    for (let i = 0; i < rawHooks.length && i < 64; i++) {
        const entry = rawHooks[i];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            continue;
        const rec = entry;
        const event = typeof rec.event === 'string' && rec.event.trim() ? rec.event.trim() : 'PreToolUse';
        const tools = Array.isArray(rec.tools)
            ? rec.tools.filter((t) => typeof t === 'string' && t.trim().length > 0)
            : [typeof rec.tool === 'string' && rec.tool.trim() ? rec.tool.trim() : '*'];
        const command = Array.isArray(rec.command)
            ? rec.command.map((c) => String(c)).join(' ')
            : '';
        const name = typeof rec.name === 'string' && rec.name.trim()
            ? rec.name.trim().slice(0, 120)
            : `${event}:${tools[0] || '*'}`;
        const timeoutMs = typeof rec.timeoutMs === 'number' && Number.isFinite(rec.timeoutMs)
            ? Math.max(100, Math.min(10_000, Math.round(rec.timeoutMs)))
            : 5_000;
        items.push({
            index: i,
            name,
            event,
            tools,
            commandPreview: command.slice(0, 180),
            timeoutMs,
            enabled: rec.enabled !== false
        });
    }
    return items;
}
function buildSettingsOverviewPayload(ctx) {
    const config = loadConfig();
    const osSandboxCap = probeOsSandbox();
    const osSandboxResolved = resolveOsSandboxMode(process.env, config.osSandbox);
    const configuredOsSandbox = typeof config.osSandbox === 'string' && ALLOWED_OS_SANDBOX_MODES.has(config.osSandbox.trim().toLowerCase())
        ? config.osSandbox.trim().toLowerCase()
        : 'workspace-write';
    const rawBudget = config.tokenBudget && typeof config.tokenBudget === 'object' && !Array.isArray(config.tokenBudget)
        ? config.tokenBudget
        : {};
    const tokenBudget = {
        enabled: rawBudget.enabled === true,
        maxTokensPerTask: typeof rawBudget.maxTokensPerTask === 'number' && Number.isFinite(rawBudget.maxTokensPerTask)
            ? Math.max(1000, Math.round(rawBudget.maxTokensPerTask))
            : 150000,
        maxTokensPerDay: typeof rawBudget.maxTokensPerDay === 'number' && Number.isFinite(rawBudget.maxTokensPerDay)
            ? Math.max(1000, Math.round(rawBudget.maxTokensPerDay))
            : 1000000,
        maxCostUsd: typeof rawBudget.maxCostUsd === 'number' && Number.isFinite(rawBudget.maxCostUsd)
            ? Math.max(0.1, Number(rawBudget.maxCostUsd))
            : 5,
        hardStop: rawBudget.hardStop === true
    };
    const rawCompact = config.contextCompaction && typeof config.contextCompaction === 'object' && !Array.isArray(config.contextCompaction)
        ? config.contextCompaction
        : {};
    const autoCompact = {
        enabled: rawCompact.enabled !== false,
        thresholdPercent: typeof rawCompact.thresholdPercent === 'number' && Number.isFinite(rawCompact.thresholdPercent)
            ? Math.max(40, Math.min(95, Math.round(rawCompact.thresholdPercent)))
            : 78
    };
    const configuredProviders = VAULT_PROVIDER_IDS.filter((id) => Boolean(resolveProviderApiKey(config, id)));
    const projectMcp = discoverProjectMcpServers(ctx.workspaceRoot);
    let pluginItems = [];
    try {
        pluginItems = listPlugins();
    }
    catch {
        pluginItems = [];
    }
    return {
        ok: true,
        general: {
            workspaceRoot: ctx.workspaceRoot,
            workspaceName: path.basename(ctx.workspaceRoot),
            version: ctx.version,
            platform: process.platform,
            provider: config.provider || 'unconfigured',
            model: config.model || DEFAULT_MODEL_BY_PROVIDER[String(config.provider || '')] || 'default'
        },
        configuration: {
            defaultPermissionPreset: getDefaultPermissionPreset(),
            reasoningEffort: typeof config.reasoningEffort === 'string' ? config.reasoningEffort.trim().toLowerCase() : '',
            osSandbox: {
                configuredMode: configuredOsSandbox,
                effectiveMode: osSandboxResolved.mode,
                strict: osSandboxResolved.strict,
                allowNetwork: osSandboxResolved.allowNetwork,
                backend: osSandboxCap.backend,
                available: osSandboxCap.available,
                reason: osSandboxCap.reason
            },
            tokenBudget,
            autoCompact
        },
        personalization: readPersonalizationOverview(ctx.workspaceRoot),
        vault: {
            activeProvider: config.provider || '',
            configuredProviders
        },
        mcp: {
            servers: serverStatus(),
            projectDiscovered: projectMcp.servers.map((srv) => ({
                name: srv.name,
                transport: srv.url ? 'http' : 'stdio',
                target: srv.url ?? [srv.command, ...(srv.args ?? [])].filter(Boolean).join(' ')
            })),
            projectWarnings: projectMcp.warnings,
            projectFile: projectMcp.filePath
        },
        hooks: buildHooksOverview(config),
        plugins: {
            root: PLUGIN_ROOT,
            items: pluginItems
        }
    };
}
function invalidateActiveLoopStaticContexts(ctx) {
    for (const run of ctx.activeRuns.values()) {
        const loopObj = run.loop;
        if (loopObj && typeof loopObj === 'object' && 'staticContext' in loopObj) {
            loopObj.staticContext = null;
        }
    }
}
export async function handleSettingsRoutes(req, res, parsedUrl, ctx) {
    const pathname = parsedUrl.pathname;
    if (req.method === 'GET' && pathname === '/api/settings/overview') {
        sendJson(res, 200, buildSettingsOverviewPayload(ctx));
        return true;
    }
    if (req.method === 'POST' && pathname === '/api/settings/configuration') {
        const body = await readJsonBody(req);
        const config = loadConfig();
        if (body.defaultPermissionPreset !== undefined) {
            const preset = normalizePermissionPreset(body.defaultPermissionPreset);
            if (!preset) {
                sendJson(res, 400, { error: 'Invalid defaultPermissionPreset value.' });
                return true;
            }
            setDefaultPermissionPreset(preset);
            config.defaultPermissionPreset = preset;
        }
        if (typeof body.osSandbox === 'string') {
            const mode = body.osSandbox.trim().toLowerCase();
            if (!ALLOWED_OS_SANDBOX_MODES.has(mode)) {
                sendJson(res, 400, { error: 'Invalid osSandbox mode.' });
                return true;
            }
            config.osSandbox = mode;
        }
        if (typeof body.reasoningEffort === 'string') {
            const effort = body.reasoningEffort.trim().toLowerCase();
            if (!ALLOWED_EFFORT_LEVELS.has(effort)) {
                sendJson(res, 400, { error: 'Invalid reasoningEffort level.' });
                return true;
            }
            if (!effort)
                delete config.reasoningEffort;
            else
                config.reasoningEffort = effort;
        }
        if (body.tokenBudget && typeof body.tokenBudget === 'object' && !Array.isArray(body.tokenBudget)) {
            const raw = body.tokenBudget;
            const prev = config.tokenBudget && typeof config.tokenBudget === 'object'
                ? config.tokenBudget
                : {};
            const nextBudget = { ...prev };
            if (typeof raw.enabled === 'boolean')
                nextBudget.enabled = raw.enabled;
            if (typeof raw.hardStop === 'boolean')
                nextBudget.hardStop = raw.hardStop;
            if (typeof raw.maxTokensPerTask === 'number' && Number.isFinite(raw.maxTokensPerTask)) {
                nextBudget.maxTokensPerTask = Math.max(1000, Math.min(100_000_000, Math.round(raw.maxTokensPerTask)));
            }
            if (typeof raw.maxTokensPerDay === 'number' && Number.isFinite(raw.maxTokensPerDay)) {
                nextBudget.maxTokensPerDay = Math.max(1000, Math.min(1_000_000_000, Math.round(raw.maxTokensPerDay)));
            }
            if (typeof raw.maxCostUsd === 'number' && Number.isFinite(raw.maxCostUsd)) {
                nextBudget.maxCostUsd = Math.max(0.1, Math.min(10_000, Number(raw.maxCostUsd.toFixed(2))));
            }
            config.tokenBudget = nextBudget;
        }
        if (body.autoCompact && typeof body.autoCompact === 'object' && !Array.isArray(body.autoCompact)) {
            const raw = body.autoCompact;
            const prev = config.contextCompaction && typeof config.contextCompaction === 'object'
                ? config.contextCompaction
                : {};
            const nextCompact = { ...prev };
            if (typeof raw.enabled === 'boolean')
                nextCompact.enabled = raw.enabled;
            if (typeof raw.thresholdPercent === 'number' && Number.isFinite(raw.thresholdPercent)) {
                nextCompact.thresholdPercent = Math.max(40, Math.min(95, Math.round(raw.thresholdPercent)));
            }
            config.contextCompaction = nextCompact;
        }
        saveConfig(config);
        auditLog.log({ event: 'skybridge_configuration_updated' });
        sendJson(res, 200, buildSettingsOverviewPayload(ctx));
        return true;
    }
    if (req.method === 'POST' && pathname === '/api/settings/personalization') {
        const body = await readJsonBody(req);
        const scope = body.scope === 'global' ? 'global' : 'project';
        try {
            if (typeof body.instructions === 'string') {
                savePersonalizationInstructions(ctx.workspaceRoot, scope, body.instructions);
            }
            const memPatch = {};
            if (typeof body.memoryEnabled === 'boolean' || body.memoryEnabled === null) {
                memPatch.enabled = body.memoryEnabled;
            }
            if (typeof body.allowToolAssisted === 'boolean' || body.allowToolAssisted === null) {
                memPatch.allowToolAssisted = body.allowToolAssisted;
            }
            if (memPatch.enabled !== undefined || memPatch.allowToolAssisted !== undefined) {
                saveMemoryPreferences(ctx.workspaceRoot, scope, memPatch);
            }
            invalidateActiveLoopStaticContexts(ctx);
            auditLog.log({
                event: 'skybridge_personalization_updated',
                scope,
                updatedInstructions: typeof body.instructions === 'string',
                updatedMemory: memPatch.enabled !== undefined || memPatch.allowToolAssisted !== undefined
            });
            sendJson(res, 200, {
                ok: true,
                scope,
                personalization: readPersonalizationOverview(ctx.workspaceRoot)
            });
            return true;
        }
        catch (err) {
            const rawMsg = err instanceof Error ? err.message : '';
            const safeMsg = rawMsg.includes('exceed maximum size')
                ? 'Personalization instructions exceed the 16 KB limit.'
                : rawMsg.includes('symlink')
                    ? 'Refusing to write personalization through a symbolic link.'
                    : 'Could not save personalization settings.';
            sendJson(res, 400, { error: safeMsg });
            return true;
        }
    }
    if (req.method === 'POST' && pathname === '/api/settings/memories/delete') {
        const body = await readJsonBody(req);
        const scope = body.scope === 'all' ? 'all' : 'project';
        const result = deleteCausyneMemories(ctx.workspaceRoot, scope);
        invalidateActiveLoopStaticContexts(ctx);
        auditLog.log({
            event: 'skybridge_memories_deleted',
            scope,
            factsRemoved: result.factsRemoved,
            observationsRemoved: result.observationsRemoved,
            summariesRemoved: result.summariesRemoved
        });
        sendJson(res, 200, {
            ok: true,
            ...result,
            personalization: readPersonalizationOverview(ctx.workspaceRoot)
        });
        return true;
    }
    if (req.method === 'POST' && pathname === '/api/settings/hooks/toggle') {
        const body = await readJsonBody(req);
        const index = typeof body.index === 'number' && Number.isInteger(body.index) ? body.index : -1;
        const enabled = typeof body.enabled === 'boolean' ? body.enabled : null;
        if (index < 0 || enabled === null) {
            sendJson(res, 400, { error: 'Valid hook index and boolean enabled flag are required.' });
            return true;
        }
        const config = loadConfig();
        if (!Array.isArray(config.hooks) || index >= config.hooks.length) {
            sendJson(res, 404, { error: 'Configured hook entry not found.' });
            return true;
        }
        const target = config.hooks[index];
        if (!target || typeof target !== 'object' || Array.isArray(target)) {
            sendJson(res, 400, { error: 'Hook entry is malformed.' });
            return true;
        }
        target.enabled = enabled;
        saveConfig(config);
        auditLog.log({ event: 'skybridge_hook_toggled', index, enabled });
        sendJson(res, 200, { ok: true, hooks: buildHooksOverview(config) });
        return true;
    }
    if (req.method === 'POST' && pathname === '/api/settings/plugins/toggle') {
        const body = await readJsonBody(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const enabled = typeof body.enabled === 'boolean' ? body.enabled : null;
        if (!name || enabled === null) {
            sendJson(res, 400, { error: 'Valid plugin name and boolean enabled flag are required.' });
            return true;
        }
        const outcome = enabled ? enablePlugin(name) : disablePlugin(name);
        if (!outcome.ok) {
            sendJson(res, 400, { error: 'Could not update plugin trust state.' });
            return true;
        }
        auditLog.log({ event: 'skybridge_plugin_toggled', name, enabled });
        sendJson(res, 200, {
            ok: true,
            plugins: { root: PLUGIN_ROOT, items: listPlugins() }
        });
        return true;
    }
    return false;
}
