import path from 'node:path';
import { applyProviderOverrides, loadConfig, resolveProviderApiKey, saveConfig } from '../../config.js';
import { detectZeroCostProviders } from '../../zeroCostRouting.js';
import { DEFAULT_MODEL_BY_PROVIDER, MODEL_CATALOGUE } from '../../modelCatalogue.js';
import { getAvailableProvidersOverview, resolveAvailableProvidersOverview } from '../../dynamicCatalogue.js';
import { reconcileConfigVariant } from '../../modelVariants.js';
import { buildModelPickerItems } from '../../tui/modelPicker.js';
import { getGameStudioStatus, launchGameStudio, stopGameStudio } from '../../game/gameLauncher.js';
import { installGameStudio, locateGameStudio } from '../../game/gameProvisioner.js';
import { disconnectOpenRouter } from '../../auth/openrouterAuth.js';
import { auditLog } from '../../auditLog.js';
import { formatRedactedProviderErrorReport } from '../../providers/byokHttp.js';
import { formatByokProbeReport, runZeroSpendByokProbe } from '../../verification/byokSmokeProbe.js';
import { DAILY_LIMIT_SUPPORT_MESSAGE, EntitlementAccessError, EntitlementClient } from '../../licensing/entitlements.js';
import { LICENSE_ENFORCEMENT_ENABLED, isValidLicensePlan } from '../../licensing/policy.js';
import { PERMISSION_PRESET_CATALOG, getDefaultPermissionPreset, getSessionPermissionPreset, normalizePermissionPreset, presetToAutonomyMode, setDefaultPermissionPreset, setSessionPermissionPreset } from '../../permissionPresets.js';
import { SAFE_MODEL_RE, SAFE_PROVIDER_RE, SAFE_SESSION_ID_RE, readJsonBody, sendJson } from './security.js';
const PROVIDER_KEY_FOR_CATALOG_LABEL = {
    'DeepSeek': 'deepseek',
    'Qwen': 'qwen',
    'Anthropic': 'anthropic',
    'OpenAI': 'openai',
    'Gemini': 'gemini',
    'Meta (Muse)': 'muse',
    'Ollama (Local)': 'ollama',
    'Alibaba (DashScope)': 'dashscope-byok',
    'Moonshot (Kimi)': 'moonshot',
    'xAI (Grok)': 'xai',
    'Google Antigravity': 'antigravity',
    'Pi (Local Peer)': 'pi',
    'ACP (Peer Agents)': 'acp',
    'OpenCode (ACP)': 'acp/opencode',
    'Claude Code (ACP)': 'acp/claude',
    'OpenRouter (Free)': 'openrouter',
    'Groq (Free Tier)': 'groq',
    'Cerebras (Free Tier)': 'cerebras',
    'Mistral (Free Tier)': 'mistral'
};
export async function handleCoreRoutes(req, res, parsedUrl, ctx) {
    const pathname = parsedUrl.pathname;
    if (req.method === 'GET' && pathname === '/api/health') {
        const config = loadConfig();
        const zeroCost = await detectZeroCostProviders({ config, probeOllama: false });
        const readyZeroCost = zeroCost.filter((z) => z.readiness === 'ready');
        sendJson(res, 200, {
            ok: true,
            version: ctx.version,
            workspaceRoot: ctx.workspaceRoot,
            workspaceName: path.basename(ctx.workspaceRoot),
            provider: config.provider || 'unconfigured',
            model: config.model || DEFAULT_MODEL_BY_PROVIDER[String(config.provider || '')] || 'default',
            zeroCostReadyCount: readyZeroCost.length,
            zeroCostRoutes: readyZeroCost.map((z) => ({
                id: z.id,
                provider: z.provider,
                model: z.model,
                label: z.label,
                costTier: z.costTier
            })),
            defaultPermissionPreset: getDefaultPermissionPreset(),
            busy: ctx.activeRuns.size > 0
        });
        return true;
    }
    if (req.method === 'GET' && pathname === '/api/permissions') {
        const rawSid = (parsedUrl.searchParams.get('sessionId') || '').trim();
        const sessionId = rawSid && SAFE_SESSION_ID_RE.test(rawSid) ? rawSid : null;
        const defaultPreset = getDefaultPermissionPreset();
        const currentPreset = getSessionPermissionPreset(sessionId);
        sendJson(res, 200, {
            ok: true,
            catalog: PERMISSION_PRESET_CATALOG,
            defaultPreset,
            currentPreset,
            mode: presetToAutonomyMode(currentPreset),
            sessionId
        });
        return true;
    }
    if (req.method === 'POST' && pathname === '/api/permissions') {
        const body = await readJsonBody(req);
        const preset = normalizePermissionPreset(body.preset ?? body.permissionPreset ?? body.mode);
        if (!preset) {
            sendJson(res, 400, { error: 'Valid permission preset (read-only, workspace-write, danger-full-access) is required.' });
            return true;
        }
        const scope = body.scope === 'default' ? 'default' : 'session';
        const rawSid = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        const sessionId = rawSid && SAFE_SESSION_ID_RE.test(rawSid) ? rawSid : null;
        if (scope === 'default') {
            setDefaultPermissionPreset(preset);
        }
        else if (sessionId) {
            setSessionPermissionPreset(sessionId, preset);
        }
        else {
            setDefaultPermissionPreset(preset);
        }
        const defaultPreset = getDefaultPermissionPreset();
        const currentPreset = sessionId ? getSessionPermissionPreset(sessionId) : defaultPreset;
        auditLog.log({
            event: 'skybridge_permission_preset_changed',
            scope,
            sessionId: sessionId || undefined,
            preset
        });
        sendJson(res, 200, {
            ok: true,
            scope,
            sessionId,
            currentPreset,
            defaultPreset,
            mode: presetToAutonomyMode(currentPreset)
        });
        return true;
    }
    if (req.method === 'GET' && pathname === '/api/game/status') {
        const located = locateGameStudio();
        const status = getGameStudioStatus();
        sendJson(res, 200, {
            ok: true,
            installed: Boolean(located),
            ...(located ? { source: located.source, version: located.version, ready: located.hasNodeModules && located.hasStudioBuild } : {}),
            ...status
        });
        return true;
    }
    if (req.method === 'POST' && pathname === '/api/game/launch') {
        let body = {};
        try {
            body = await readJsonBody(req);
        }
        catch {
            body = {};
        }
        try {
            const openBrowser = body.openBrowser !== false;
            const launched = await launchGameStudio({ openBrowser, copyToClipboard: false });
            sendJson(res, 200, {
                ok: true,
                url: launched.url,
                origin: launched.origin,
                port: launched.port,
                source: launched.source,
                ...(launched.version ? { version: launched.version } : {}),
                reused: launched.reused,
                openedBrowser: launched.openedBrowser
            });
        }
        catch (err) {
            sendJson(res, 400, {
                ok: false,
                error: err instanceof Error ? err.message : String(err)
            });
        }
        return true;
    }
    if (req.method === 'POST' && pathname === '/api/game/install') {
        let body = {};
        try {
            body = await readJsonBody(req);
        }
        catch {
            body = {};
        }
        const confirm = body.confirm === true;
        const manifestUrl = typeof body.manifestUrl === 'string' && body.manifestUrl.trim()
            ? body.manifestUrl.trim()
            : undefined;
        const result = await installGameStudio({
            confirm,
            ...(manifestUrl ? { manifestUrl } : {})
        });
        sendJson(res, result.success ? 200 : (result.requiresConsent ? 202 : 400), {
            ok: result.success,
            ...result
        });
        return true;
    }
    if (req.method === 'POST' && pathname === '/api/game/stop') {
        const stopped = await stopGameStudio();
        sendJson(res, 200, { ok: true, stopped });
        return true;
    }
    if (req.method === 'GET' && pathname === '/api/models') {
        const config = loadConfig();
        const forceRefresh = parsedUrl.searchParams.get('refresh') === '1';
        const allowLive = forceRefresh || parsedUrl.searchParams.get('live') === '1';
        const overview = allowLive
            ? await resolveAvailableProvidersOverview(config, { forceRefresh })
            : getAvailableProvidersOverview(config);
        const activeProviderRaw = String(config.provider || '').toLowerCase().trim();
        const initialTab = activeProviderRaw === 'openrouter'
            ? 'free'
            : (activeProviderRaw === 'antigravity'
                || activeProviderRaw === 'agy'
                || activeProviderRaw === 'pi'
                || activeProviderRaw === 'acp'
                || activeProviderRaw.startsWith('acp/')
                ? 'acp'
                : 'byok');
        const tabs = {
            acp: buildModelPickerItems(config, overview, { tab: 'acp', maxAcpPerPeer: Infinity }),
            byok: buildModelPickerItems(config, overview, { tab: 'byok', maxAcpPerPeer: Infinity }),
            free: buildModelPickerItems(config, overview, { tab: 'free', maxAcpPerPeer: Infinity })
        };
        const zeroCost = await detectZeroCostProviders({ config, probeOllama: false });
        const readySet = new Set(zeroCost.filter((z) => z.readiness === 'ready').map((z) => z.provider));
        const groups = Object.entries(MODEL_CATALOGUE).map(([label, models]) => {
            const providerId = PROVIDER_KEY_FOR_CATALOG_LABEL[label] || label.toLowerCase();
            const hasKey = Boolean(resolveProviderApiKey(config, providerId));
            const isZeroCostReady = readySet.has(providerId);
            return {
                label,
                provider: providerId,
                configured: hasKey || isZeroCostReady,
                zeroCostReady: isZeroCostReady,
                defaultModel: DEFAULT_MODEL_BY_PROVIDER[providerId] || models[0] || '',
                models
            };
        });
        sendJson(res, 200, {
            ok: true,
            activeProvider: config.provider || 'unconfigured',
            activeModel: config.model || DEFAULT_MODEL_BY_PROVIDER[String(config.provider || '')] || '',
            initialTab,
            tabs,
            overview,
            zeroCost: zeroCost.map((z) => ({
                id: z.id,
                provider: z.provider,
                model: z.model,
                label: z.label,
                costTier: z.costTier,
                readiness: z.readiness
            })),
            groups
        });
        return true;
    }
    if (req.method === 'POST' && pathname === '/api/model') {
        const body = await readJsonBody(req);
        const action = typeof body.action === 'string' ? body.action.trim() : '';
        const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
        const model = typeof body.model === 'string' ? body.model.trim() : '';
        if (action === 'disconnect' && provider === 'openrouter') {
            disconnectOpenRouter();
            const updated = loadConfig();
            auditLog.log({ event: 'skybridge_openrouter_disconnect' });
            sendJson(res, 200, {
                ok: true,
                disconnected: true,
                provider: updated.provider || 'unconfigured',
                model: updated.model || DEFAULT_MODEL_BY_PROVIDER[String(updated.provider || '')] || 'default'
            });
            return true;
        }
        if (!provider || !SAFE_PROVIDER_RE.test(provider)) {
            sendJson(res, 400, { error: 'Valid provider identifier is required.' });
            return true;
        }
        if (model && !SAFE_MODEL_RE.test(model)) {
            sendJson(res, 400, { error: 'Invalid model identifier.' });
            return true;
        }
        const config = loadConfig();
        const resolvedModel = model || DEFAULT_MODEL_BY_PROVIDER[provider] || '';
        applyProviderOverrides(config, provider, resolvedModel);
        reconcileConfigVariant(config);
        saveConfig(config);
        auditLog.log({
            event: 'skybridge_model_switch',
            provider: config.provider,
            model: config.model
        });
        sendJson(res, 200, {
            ok: true,
            provider: config.provider,
            model: config.model || DEFAULT_MODEL_BY_PROVIDER[String(config.provider || '')] || 'default'
        });
        return true;
    }
    if (req.method === 'GET' && pathname === '/api/doctor/report') {
        const config = loadConfig();
        sendJson(res, 200, {
            ok: true,
            report: formatRedactedProviderErrorReport({
                provider: config.provider,
                model: config.model,
                causyneVersion: ctx.version
            })
        });
        return true;
    }
    if (req.method === 'POST' && pathname === '/api/doctor/probe') {
        const report = await runZeroSpendByokProbe();
        sendJson(res, 200, {
            ok: true,
            report: formatByokProbeReport(report),
            summary: {
                testedCount: report.testedCount,
                passedCount: report.passedCount,
                failedCount: report.failedCount,
                skippedCount: report.skippedCount
            }
        });
        return true;
    }
    if (req.method === 'GET' && pathname === '/api/license/status') {
        const liveRequested = parsedUrl.searchParams.get('live') === '1';
        const hasCustomClient = Boolean(ctx.entitlementClient);
        if (!LICENSE_ENFORCEMENT_ENABLED && !hasCustomClient && !liveRequested) {
            sendJson(res, 200, {
                ok: true,
                enforcementEnabled: false,
                entitlement: 'free',
                plan: 'free',
                paidUntil: null,
                dailySeconds: 21_600,
                remainingSeconds: 21_600,
                resetsAt: null,
                recoveryCode: null,
                supportMessage: DAILY_LIMIT_SUPPORT_MESSAGE
            });
            return true;
        }
        try {
            const client = ctx.entitlementClient ?? new EntitlementClient();
            const data = await client.status();
            sendJson(res, 200, {
                ok: true,
                enforcementEnabled: LICENSE_ENFORCEMENT_ENABLED,
                entitlement: typeof data?.entitlement === 'string' ? data.entitlement : 'free',
                plan: typeof data?.plan === 'string' ? data.plan : 'free',
                status: typeof data?.status === 'string' ? data.status : 'free',
                paidUntil: typeof data?.paidUntil === 'string' ? data.paidUntil : null,
                dailySeconds: typeof data?.dailySeconds === 'number' ? data.dailySeconds : null,
                remainingSeconds: typeof data?.remainingSeconds === 'number' ? data.remainingSeconds : null,
                resetsAt: typeof data?.resetsAt === 'string' ? data.resetsAt : null,
                recoveryCode: typeof data?.recoveryCode === 'string' ? data.recoveryCode : null,
                supportMessage: typeof data?.upgradeMessage === 'string' ? data.upgradeMessage : DAILY_LIMIT_SUPPORT_MESSAGE
            });
        }
        catch (err) {
            const msg = err instanceof EntitlementAccessError
                ? err.message
                : 'Unable to reach licensing service right now.';
            sendJson(res, 503, { ok: false, error: msg, enforcementEnabled: LICENSE_ENFORCEMENT_ENABLED });
        }
        return true;
    }
    if (req.method === 'POST' && pathname === '/api/license/checkout') {
        const body = await readJsonBody(req);
        const plan = typeof body.plan === 'string' ? body.plan.trim() : '';
        if (!isValidLicensePlan(plan)) {
            sendJson(res, 400, { error: 'Unknown Causyne plan.' });
            return true;
        }
        try {
            const client = ctx.entitlementClient ?? new EntitlementClient();
            const result = await client.checkout(plan);
            auditLog.log({ event: 'skybridge_license_checkout', plan });
            sendJson(res, 200, { ok: true, plan, url: result.url });
        }
        catch (err) {
            const msg = err instanceof EntitlementAccessError
                ? err.message
                : 'Unable to start Paddle checkout right now. Visit https://causyne.com/pricing.html.';
            sendJson(res, 502, { ok: false, error: msg });
        }
        return true;
    }
    if (req.method === 'POST' && pathname === '/api/license/recover') {
        const body = await readJsonBody(req);
        const code = typeof body.recoveryCode === 'string' ? body.recoveryCode.trim() : '';
        try {
            const client = ctx.entitlementClient ?? new EntitlementClient();
            const result = await client.recover(code);
            auditLog.log({ event: 'skybridge_license_recover', ok: true });
            sendJson(res, 200, {
                ok: true,
                entitlement: result?.entitlement ?? 'pro',
                plan: result?.plan ?? 'monthly',
                paidUntil: result?.paidUntil ?? null
            });
        }
        catch (err) {
            const status = err instanceof EntitlementAccessError && err.code === 'INVALID_RECOVERY_CODE' ? 400 : 404;
            const msg = err instanceof EntitlementAccessError ? err.message : 'Could not link recovery code.';
            sendJson(res, status, { ok: false, error: msg });
        }
        return true;
    }
    if (req.method === 'POST' && pathname === '/api/license/portal') {
        try {
            const client = ctx.entitlementClient ?? new EntitlementClient();
            const result = await client.portal();
            sendJson(res, 200, { ok: true, url: result.url });
        }
        catch (err) {
            const msg = err instanceof EntitlementAccessError ? err.message : 'Billing portal unavailable.';
            sendJson(res, 502, { ok: false, error: msg });
        }
        return true;
    }
    if (req.method === 'POST' && pathname === '/api/config/key') {
        const body = await readJsonBody(req);
        const provider = typeof body.provider === 'string' ? body.provider.trim().toLowerCase() : '';
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
        const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
        if (!provider || forbidden.has(provider) || !SAFE_PROVIDER_RE.test(provider)) {
            sendJson(res, 400, { error: 'Valid provider identifier is required.' });
            return true;
        }
        if (!apiKey || apiKey.length < 4 || apiKey.length > 512) {
            sendJson(res, 400, { error: 'API key must be between 4 and 512 characters.' });
            return true;
        }
        const config = loadConfig();
        const existingKeys = config.providerKeys && typeof config.providerKeys === 'object' && !Array.isArray(config.providerKeys)
            ? { ...config.providerKeys }
            : {};
        existingKeys[provider] = apiKey;
        config.providerKeys = existingKeys;
        if (String(config.provider || '').trim().toLowerCase() === provider || body.activate === true) {
            applyProviderOverrides(config, provider, typeof body.model === 'string' ? body.model.trim() : undefined);
            reconcileConfigVariant(config);
        }
        saveConfig(config);
        auditLog.log({ event: 'skybridge_vault_key_saved', provider });
        sendJson(res, 200, {
            ok: true,
            provider,
            configured: true,
            activeProvider: config.provider || 'unconfigured',
            activeModel: config.model || DEFAULT_MODEL_BY_PROVIDER[String(config.provider || '')] || 'default'
        });
        return true;
    }
    return false;
}
