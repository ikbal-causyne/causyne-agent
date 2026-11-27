import { createSession, getSession, saveSessionMessages } from '../../sessionJournal.js';
import { auditLog } from '../../auditLog.js';
import { redactProviderSecrets } from '../../providers/byokHttp.js';
import { DAILY_LIMIT_SUPPORT_MESSAGE, EntitlementAccessError } from '../../licensing/entitlements.js';
import { getSessionPermissionPreset, normalizePermissionPreset, presetToAutonomyMode, setSessionPermissionPreset } from '../../permissionPresets.js';
import { SAFE_MODEL_RE, SAFE_PROVIDER_RE, SAFE_SESSION_ID_RE, readJsonBody, sendJson } from './security.js';
import { buildWorkspacePromptWithAttachments, workspaceMatchesSession } from './workspaceFiles.js';
import { MUTATING_FILE_TOOLS } from './sessionTranscript.js';
export async function handleChatRoutes(req, res, parsedUrl, ctx) {
    const pathname = parsedUrl.pathname;
    const { workspaceRoot } = ctx;
    if (req.method === 'POST' && pathname === '/api/approve') {
        const body = await readJsonBody(req);
        const toolCallId = typeof body.toolCallId === 'string' ? body.toolCallId.trim() : '';
        const sessionId = typeof body.sessionId === 'string' && SAFE_SESSION_ID_RE.test(body.sessionId.trim())
            ? body.sessionId.trim()
            : '';
        const approved = body.approved === true;
        const remember = body.remember === true;
        const toolName = typeof body.tool === 'string' ? body.tool.trim().slice(0, 80) : '';
        const targetRun = ctx.findActiveRun(sessionId || null);
        if (!toolCallId || !targetRun?.loop.resolveApproval) {
            sendJson(res, 400, { error: 'No active pending approval matches that toolCallId.' });
            return true;
        }
        if (approved && remember && toolName && targetRun.loop.grantAlways) {
            targetRun.loop.grantAlways(toolName);
            auditLog.log({ event: 'skybridge_approval_grant_always', tool: toolName });
        }
        targetRun.status = 'running';
        targetRun.loop.resolveApproval(toolCallId, approved);
        sendJson(res, 200, { ok: true, toolCallId, approved, remembered: Boolean(approved && remember && toolName) });
        return true;
    }
    if (req.method === 'POST' && pathname === '/api/decision') {
        const body = await readJsonBody(req);
        const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
        const sessionId = typeof body.sessionId === 'string' && SAFE_SESSION_ID_RE.test(body.sessionId.trim())
            ? body.sessionId.trim()
            : '';
        const label = typeof body.label === 'string' ? body.label.trim().slice(0, 400) : '';
        const optionId = typeof body.optionId === 'string' ? body.optionId.trim().slice(0, 120) : null;
        const custom = body.custom === true;
        const targetRun = ctx.findActiveRun(sessionId || null);
        if (!requestId || !targetRun?.loop.resolveDecision) {
            sendJson(res, 400, { error: 'No active pending decision matches that requestId.' });
            return true;
        }
        targetRun.status = 'running';
        targetRun.loop.resolveDecision(requestId, label ? { optionId, label, custom } : null);
        sendJson(res, 200, { ok: true, requestId, label });
        return true;
    }
    if (req.method === 'POST' && pathname === '/api/stop') {
        let stopSessionId = '';
        try {
            const body = await readJsonBody(req);
            if (typeof body.sessionId === 'string' && SAFE_SESSION_ID_RE.test(body.sessionId.trim())) {
                stopSessionId = body.sessionId.trim();
            }
        }
        catch {
            // Empty body is valid for /api/stop.
        }
        if (stopSessionId) {
            const run = ctx.activeRuns.get(stopSessionId);
            if (run) {
                run.userStopped = true;
                run.loop.abort?.();
            }
        }
        else {
            for (const run of ctx.activeRuns.values()) {
                run.userStopped = true;
                run.loop.abort?.();
            }
        }
        sendJson(res, 200, { ok: true });
        return true;
    }
    if (req.method === 'POST' && pathname === '/api/chat') {
        const body = await readJsonBody(req);
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        const requestedSessionId = typeof body.sessionId === 'string' && SAFE_SESSION_ID_RE.test(body.sessionId.trim())
            ? body.sessionId.trim()
            : '';
        const explicitPreset = normalizePermissionPreset(body.permissionPreset)
            ?? normalizePermissionPreset(body.mode);
        const resolvedPreset = explicitPreset ?? getSessionPermissionPreset(requestedSessionId || null);
        const mode = presetToAutonomyMode(resolvedPreset);
        const providerOverride = typeof body.provider === 'string' && SAFE_PROVIDER_RE.test(body.provider.trim())
            ? body.provider.trim()
            : undefined;
        const modelOverride = typeof body.model === 'string' && SAFE_MODEL_RE.test(body.model.trim())
            ? body.model.trim()
            : undefined;
        if (!prompt) {
            sendJson(res, 400, { error: 'Prompt text is required.' });
            return true;
        }
        let boundSession = requestedSessionId ? getSession(requestedSessionId) : null;
        if (boundSession && !workspaceMatchesSession(boundSession.workspace, workspaceRoot)) {
            boundSession = null;
        }
        if (!boundSession && !ctx.hasCustomFactory) {
            boundSession = createSession(workspaceRoot, prompt.slice(0, 60), false);
        }
        if (boundSession && explicitPreset) {
            setSessionPermissionPreset(boundSession.id, resolvedPreset);
        }
        const runKey = boundSession?.id || '__ephemeral__';
        const existingRun = ctx.activeRuns.get(runKey);
        if (existingRun && (existingRun.status === 'running' || existingRun.status === 'awaiting_client')) {
            sendJson(res, 409, {
                error: 'This conversation already has a task running. Stop it or wait for completion.'
            });
            return true;
        }
        const { effectivePrompt, attachedPaths } = buildWorkspacePromptWithAttachments(workspaceRoot, prompt, body.attachments);
        const taskId = ctx.nextTaskId();
        let collectedAssistantText = '';
        let runRef = null;
        const emitFrame = (raw) => {
            const clean = raw.replace(/\r?\n/g, ' ');
            try {
                const parsed = JSON.parse(clean);
                if (parsed.type === 'agent_chunk' && typeof parsed.delta === 'string') {
                    collectedAssistantText += parsed.delta;
                }
                else if (parsed.type === 'agent_message' && typeof parsed.content === 'string' && !collectedAssistantText) {
                    collectedAssistantText = parsed.content;
                }
                if (runRef && (parsed.type === 'approval_request' || parsed.type === 'decision_request')) {
                    runRef.status = 'awaiting_client';
                }
                const toolLower = typeof parsed.tool === 'string' ? parsed.tool.toLowerCase() : '';
                const actionLower = typeof parsed.actionName === 'string' ? parsed.actionName.toLowerCase() : '';
                if (boundSession?.id) {
                    if (parsed.type === 'code_progress' && typeof parsed.path === 'string') {
                        ctx.recordSessionTouchedFile(boundSession.id, parsed.path);
                    }
                    else if ((parsed.type === 'step_complete' || parsed.type === 'tool_result')
                        && MUTATING_FILE_TOOLS.has(toolLower)
                        && parsed.args) {
                        for (const key of ['path', 'filePath', 'file_path', 'targetFile', 'filename', 'file', 'destination']) {
                            ctx.recordSessionTouchedFile(boundSession.id, parsed.args[key]);
                        }
                    }
                    else if (parsed.type === 'notice' && MUTATING_FILE_TOOLS.has(actionLower) && parsed.detail) {
                        ctx.recordSessionTouchedFile(boundSession.id, parsed.detail);
                    }
                }
                const isBrowserTool = toolLower.includes('browser');
                const isComputerTool = toolLower.includes('computer_use') || toolLower.includes('desktop_act');
                if ((parsed.type === 'step_start' || parsed.type === 'tool_start') && (isBrowserTool || isComputerTool)) {
                    if (isBrowserTool)
                        ctx.setBrowserControlOwner('agent');
                    const detail = isBrowserTool && Array.isArray(parsed.args?.actions) && parsed.args.actions[0]
                        ? String(parsed.args.actions[0].type || 'browser.act')
                        : String(parsed.args?.action || parsed.tool || '');
                    ctx.setBrowserAgentActivity({
                        active: true,
                        tool: parsed.tool || 'browser.act',
                        detail: detail.slice(0, 80),
                        updatedAt: Date.now()
                    });
                    ctx.broadcastBrowserNotice({
                        type: 'agent_activity',
                        controlOwner: ctx.getBrowserControlOwner(),
                        agentActivity: ctx.getBrowserAgentActivity()
                    });
                }
                else if ((parsed.type === 'step_complete' || parsed.type === 'step_error' || parsed.type === 'tool_complete')
                    && (isBrowserTool || isComputerTool)) {
                    ctx.setBrowserAgentActivity({ active: false, tool: '', detail: '', updatedAt: Date.now() });
                    ctx.broadcastBrowserNotice({
                        type: 'agent_activity',
                        controlOwner: ctx.getBrowserControlOwner(),
                        agentActivity: ctx.getBrowserAgentActivity()
                    });
                }
            }
            catch {
                // pass raw frame through untouched
            }
            if (runRef)
                ctx.pushRunFrame(runRef, clean);
        };
        const wrappedSink = { readyState: 1, send: emitFrame };
        const loop = ctx.loopFactory(wrappedSink, taskId, effectivePrompt, {
            workspaceRoot,
            mode,
            permissionPreset: resolvedPreset,
            sessionId: boundSession?.id,
            provider: providerOverride,
            model: modelOverride
        });
        const run = {
            key: runKey,
            sessionId: boundSession?.id || null,
            taskId,
            prompt,
            startedAt: Date.now(),
            status: 'running',
            userStopped: false,
            loop,
            frames: [],
            bufferedBytes: 0,
            subscribers: new Set(),
            doneSubscribers: new Set()
        };
        runRef = run;
        ctx.activeRuns.set(runKey, run);
        if (boundSession) {
            ctx.pushRunFrame(run, JSON.stringify({
                type: 'session_bound',
                sessionId: boundSession.id,
                title: boundSession.title,
                attachments: attachedPaths
            }));
        }
        ctx.attachRunStream(req, res, run, true);
        void (async () => {
            try {
                await loop.run();
                if (boundSession && ctx.hasCustomFactory && collectedAssistantText.trim()) {
                    const latest = getSession(boundSession.id);
                    if (latest) {
                        const nextMessages = [
                            ...latest.messages,
                            { role: 'user', content: prompt },
                            { role: 'assistant', content: collectedAssistantText.trim() }
                        ];
                        saveSessionMessages(boundSession.id, nextMessages);
                    }
                }
                const refreshed = boundSession ? getSession(boundSession.id) : null;
                if (run.userStopped) {
                    run.status = 'stopped';
                    ctx.pushRunFrame(run, JSON.stringify({
                        type: 'stopped',
                        taskId,
                        sessionId: boundSession?.id || null,
                        title: refreshed?.title || boundSession?.title || null,
                        userStopped: true
                    }));
                }
                else {
                    run.status = 'completed';
                    ctx.pushRunFrame(run, JSON.stringify({
                        type: 'done',
                        taskId,
                        sessionId: boundSession?.id || null,
                        title: refreshed?.title || boundSession?.title || null
                    }));
                }
            }
            catch (err) {
                run.status = run.userStopped ? 'stopped' : 'errored';
                if (run.userStopped) {
                    ctx.pushRunFrame(run, JSON.stringify({
                        type: 'stopped',
                        taskId,
                        sessionId: boundSession?.id || null,
                        userStopped: true
                    }));
                }
                else if (err instanceof EntitlementAccessError && err.code === 'DAILY_LIMIT_REACHED') {
                    ctx.pushRunFrame(run, JSON.stringify({
                        type: 'error',
                        code: 'DAILY_LIMIT_REACHED',
                        message: err.message || DAILY_LIMIT_SUPPORT_MESSAGE
                    }));
                }
                else {
                    auditLog.log({
                        event: 'skybridge_chat_error',
                        taskId,
                        detail: redactProviderSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300)
                    });
                    ctx.pushRunFrame(run, JSON.stringify({
                        type: 'error',
                        message: 'Task failed. Inspect local audit log or run `/doctor --report` for sanitized details.'
                    }));
                }
            }
            finally {
                for (const doneCb of [...run.doneSubscribers]) {
                    try {
                        doneCb();
                    }
                    catch { /* ignore */ }
                }
                run.subscribers.clear();
                run.doneSubscribers.clear();
                if (ctx.activeRuns.get(runKey) === run) {
                    ctx.activeRuns.delete(runKey);
                }
            }
        })();
        return true;
    }
    return false;
}
