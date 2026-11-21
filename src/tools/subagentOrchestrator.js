import crypto from 'node:crypto';
import { TokenTracker } from '../tokenTracker.js';
import { listAgentProfiles, loadAgentProfile } from '../agentProfiles.js';
import { completeSubagentJournal, failSubagentJournal, startSubagentJournal } from '../subagentJournal.js';
import { getErrorMessage, sanitizeToolError, sanitizeToolText } from './toolPathSafety.js';
const activeSubagents = new Map();
const MAX_CONCURRENT_SUBAGENTS = 4;
const SUBAGENT_TOOL_NAME = 'agent.subagent_orchestrate';
const NORMALIZED_SUBAGENT_TOOL_NAME = 'agent_subagent_orchestrate';
const MAX_RETAINED_SUBAGENTS = 32;
const DEFAULT_TOOL_SCOPE = ['fs_read', 'fs_find', 'fs_search', 'fs_list', 'code_search_ast'];
function childTransport(parentLoop, subagentId, name) {
    return {
        get readyState() {
            return parentLoop && parentLoop.eventSink ? parentLoop.eventSink.readyState : 3;
        },
        send(raw) {
            if (!parentLoop || typeof parentLoop.emitEvent !== 'function')
                return;
            let frame;
            try {
                frame = JSON.parse(raw);
            }
            catch {
                return;
            }
            if (!frame || typeof frame !== 'object' || Array.isArray(frame))
                return;
            parentLoop.emitEvent({ ...frame, subagentId, subagentName: name });
        }
    };
}
async function executeSubagent(record, parentLoop) {
    const { AgentLoop } = await import('../agentLoop.js');
    const transport = childTransport(parentLoop, record.subagentId, record.name);
    const child = new AgentLoop(transport, record.subagentId, record.prompt);
    child.maxStepsCeiling = record.maxSteps;
    child.taskTokenLimit = record.maxTokens;
    child.maxSteps = Math.min(child.maxSteps || 25, record.maxSteps);
    child.maxCircuitBreaker = child.maxSteps;
    child.messages = [];
    child.toolScope = new Set(record.toolScope.filter((n) => n !== SUBAGENT_TOOL_NAME && n !== NORMALIZED_SUBAGENT_TOOL_NAME));
    child.currentTaskPrompt = record.prompt;
    child.subagentDepth = record.depth;
    record.loop = child;
    record.startedAtMs = Date.now();
    record.journalStarted = startSubagentJournal(record);
    try {
        await child.run();
    }
    catch (error) {
        if (record.journalStarted) {
            failSubagentJournal(record.subagentId, getErrorMessage(error));
        }
        throw error;
    }
    const messages = Array.isArray(child.messages) ? child.messages : [];
    const finalAssistant = [...messages].reverse()
        .find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
    const toolCalls = messages.filter((m) => m.role === 'tool');
    const failures = toolCalls.filter((m) => {
        try {
            return JSON.parse(String(m.content)).success === false;
        }
        catch {
            return false;
        }
    });
    const result = {
        subagentId: record.subagentId,
        name: record.name,
        stepsCompleted: child.stepsCompleted,
        toolCallsMade: toolCalls.length,
        toolFailures: failures.length,
        elapsedMs: Date.now() - (record.startedAtMs ?? Date.now()),
        summary: finalAssistant && typeof finalAssistant.content === 'string' ? finalAssistant.content : null,
        stoppedEarly: child.stepsCompleted >= child.maxSteps
    };
    if (record.journalStarted)
        completeSubagentJournal(record.subagentId, messages, result);
    return result;
}
export const subagentOrchestrator = {
    schema: {
        name: SUBAGENT_TOOL_NAME,
        description: 'Delegate a bounded sub-task to an independent agent loop with its own context, step budget and restricted tool scope. Use it to parallelise genuinely independent work (research several files, audit separate modules). The subagent runs a real agent loop and returns its actual result; it cannot delegate further.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['spawn', 'list', 'list_profiles', 'kill', 'delegate_and_wait'],
                    description: 'spawn (start in the background), list (show active subagents), list_profiles (show static user-defined agent profiles), kill (stop one), or delegate_and_wait (run and return the result).'
                },
                name: { type: 'string', description: 'A short name for the subagent, e.g. Audit_Worker.' },
                prompt: { type: 'string', description: 'The complete instruction for the subagent. It has no memory of this conversation, so it must be self-contained.' },
                profile: { type: 'string', description: 'Optional profile name from ~/.causyne/agents/<name>.json. Its tool and budget limits cannot be widened by the call.' },
                subagentId: { type: 'string', description: 'Target subagent for the kill action.' },
                toolScope: { type: 'array', items: { type: 'string' }, description: 'Catalogue tool names the subagent may use. Defaults to read-only inspection tools. It can never receive the delegation tool itself.' },
                maxSteps: { type: 'integer', description: 'Hard step ceiling for the subagent. Defaults to 25.' },
                maxTokens: { type: 'integer', description: 'Hard per-task token ceiling for the subagent. Defaults to 50000.' },
                depth: { type: 'integer', description: 'Hierarchy depth. 0 = master, 1 = worker. Subagents cannot spawn subagents.' }
            },
            required: ['action']
        }
    },
    async execute(args = {}, context = {}) {
        try {
            const action = args?.action;
            const parentLoop = context?.parentLoop || null;
            if (action === 'list') {
                const list = [...activeSubagents.values()].map((worker) => ({
                    subagentId: worker.subagentId,
                    name: worker.name,
                    status: worker.status,
                    depth: worker.depth,
                    toolScope: worker.toolScope,
                    startTime: worker.startTime,
                    stepsCompleted: worker.loop ? worker.loop.stepsCompleted : 0,
                    summary: worker.summary,
                    error: worker.error
                }));
                return {
                    success: true,
                    output: JSON.stringify({
                        active_workers: list.filter((w) => w.status === 'running').length,
                        max_concurrent_allowed: MAX_CONCURRENT_SUBAGENTS,
                        workers: list
                    }, null, 2)
                };
            }
            if (action === 'list_profiles') {
                const { profiles, problems } = listAgentProfiles();
                return {
                    success: true,
                    output: JSON.stringify({
                        profiles: profiles.map((profile) => ({
                            name: profile.name,
                            description: profile.description,
                            toolScope: profile.toolScope,
                            maxSteps: profile.maxSteps,
                            maxTokens: profile.maxTokens
                        })),
                        problems
                    }, null, 2)
                };
            }
            if (action === 'kill') {
                const id = args.subagentId || args.name;
                if (!id)
                    return { success: false, error: 'subagentId or name is required to stop a subagent.' };
                for (const [key, worker] of activeSubagents.entries()) {
                    if (key === id || worker.name === id) {
                        try {
                            if (worker.loop)
                                worker.loop.abort();
                        }
                        catch { /* ignore */ }
                        if (worker.journalStarted) {
                            try {
                                failSubagentJournal(worker.subagentId, 'Stopped by kill action');
                            }
                            catch { /* ignore */ }
                        }
                        worker.status = 'killed';
                        worker.loop = null;
                        activeSubagents.delete(key);
                        return { success: true, output: `Subagent ${sanitizeToolText(key, 64)} (${sanitizeToolText(worker.name, 64)}) stopped.` };
                    }
                }
                return { success: false, error: `Subagent ${id} not found.` };
            }
            if (action !== 'spawn' && action !== 'delegate_and_wait') {
                return { success: false, error: `Unknown action: ${String(action ?? '')}` };
            }
            let profile = null;
            if (args.profile !== undefined) {
                const loaded = loadAgentProfile(args.profile);
                if (!loaded.ok)
                    return { success: false, error: `Agent profile ${JSON.stringify(args.profile)}: ${loaded.error}` };
                profile = loaded.profile;
            }
            const requestedPrompt = args.prompt;
            const prompt = profile
                ? `${profile.instructions}\n\nDelegated task:\n${String(requestedPrompt || '')}`
                : requestedPrompt;
            if (typeof prompt !== 'string' || !prompt)
                return { success: false, error: 'A prompt is required to delegate a task.' };
            const depth = args.depth !== undefined ? args.depth : 1;
            if (depth > 1) {
                return {
                    success: false,
                    error: `Subagent hierarchy depth violation: depth ${depth} exceeds the 2-tier boundary (master -> worker). Subagents cannot delegate further.`
                };
            }
            if (parentLoop && parentLoop.subagentDepth !== undefined) {
                return { success: false, error: 'A subagent cannot delegate to another subagent.' };
            }
            const running = [...activeSubagents.values()].filter((w) => w.status === 'running').length;
            if (running >= MAX_CONCURRENT_SUBAGENTS) {
                return {
                    success: false,
                    error: `Subagent concurrency limit reached (${MAX_CONCURRENT_SUBAGENTS} running). Stop one, or wait for it to finish.`
                };
            }
            const name = args.name || profile?.name || `Worker_${crypto.randomBytes(3).toString('hex')}`;
            const subagentId = `sub_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
            let requestedScope = Array.isArray(args.toolScope) && args.toolScope.length > 0
                ? args.toolScope
                : profile?.toolScope || DEFAULT_TOOL_SCOPE;
            if (profile) {
                const ceiling = new Set(profile.toolScope);
                requestedScope = requestedScope.filter((tool) => ceiling.has(String(tool).replace(/\./g, '_')));
                if (requestedScope.length === 0) {
                    return { success: false, error: `Agent profile ${profile.name} permits none of the requested tools.` };
                }
            }
            requestedScope = [...new Set(requestedScope.map((tool) => String(tool).replace(/\./g, '_')))];
            const { TOOL_DEFINITIONS } = await import('./registry.js');
            const catalogue = new Set(TOOL_DEFINITIONS.map((t) => t.name));
            const unknown = requestedScope.filter((n) => !catalogue.has(n) && n !== SUBAGENT_TOOL_NAME);
            if (unknown.length > 0) {
                return { success: false, error: `Unknown tools in toolScope: ${unknown.join(', ')}.` };
            }
            const requestedMaxSteps = typeof args.maxSteps === 'number' && Number.isInteger(args.maxSteps)
                ? Math.max(1, Math.min(args.maxSteps, 100))
                : profile?.maxSteps || 25;
            const requestedMaxTokens = typeof args.maxTokens === 'number' && Number.isInteger(args.maxTokens)
                ? Math.max(1_000, Math.min(args.maxTokens, 200_000))
                : profile?.maxTokens || 50_000;
            const record = {
                subagentId,
                name,
                prompt,
                toolScope: requestedScope,
                depth,
                maxSteps: Math.min(requestedMaxSteps, profile?.maxSteps || 100),
                maxTokens: Math.min(requestedMaxTokens, profile?.maxTokens || 200_000),
                profile: profile?.name || null,
                status: 'running',
                startTime: new Date().toISOString(),
                summary: null,
                error: null,
                loop: null
            };
            const tracker = new TokenTracker();
            const estimated = Math.ceil(prompt.length / 4) + 1500;
            const check = await tracker.trackUsage(estimated, 0);
            if (!check.allowed) {
                return {
                    success: false,
                    error: `Token budget block: ${check.reason || 'the budget threshold would be exceeded by this subagent.'}`
                };
            }
            activeSubagents.set(subagentId, record);
            const pruneCompleted = () => {
                if (activeSubagents.size <= MAX_RETAINED_SUBAGENTS)
                    return;
                for (const [k, v] of activeSubagents.entries()) {
                    if (activeSubagents.size <= MAX_RETAINED_SUBAGENTS)
                        break;
                    if (v.status !== 'running')
                        activeSubagents.delete(k);
                }
            };
            const work = executeSubagent(record, parentLoop)
                .then((result) => {
                record.status = 'completed';
                record.summary = result.summary;
                record.loop = null;
                pruneCompleted();
                return result;
            })
                .catch((error) => {
                record.status = 'failed';
                record.error = sanitizeToolError(error);
                record.loop = null;
                pruneCompleted();
                throw error;
            });
            if (action === 'delegate_and_wait') {
                try {
                    const result = await work;
                    activeSubagents.delete(subagentId);
                    if (!result.summary) {
                        return {
                            success: false,
                            error: `Subagent [${name}] finished without producing a result after ${result.stepsCompleted} steps.`,
                            output: JSON.stringify(result, null, 2)
                        };
                    }
                    return { success: true, output: JSON.stringify(result, null, 2) };
                }
                catch (error) {
                    activeSubagents.delete(subagentId);
                    return { success: false, error: `Subagent [${name}] failed: ${getErrorMessage(error)}` };
                }
            }
            work
                .then((result) => {
                if (parentLoop && typeof parentLoop.emitEvent === 'function') {
                    parentLoop.emitEvent({
                        type: 'notice', subagentId, subagentName: name,
                        message: `Subagent [${name}] finished in ${result.stepsCompleted} steps.`
                    });
                }
            })
                .catch((error) => {
                if (parentLoop && typeof parentLoop.emitEvent === 'function') {
                    parentLoop.emitEvent({
                        type: 'notice', tone: 'error', subagentId, subagentName: name,
                        message: `Subagent [${name}] failed: ${getErrorMessage(error)}`
                    });
                }
            });
            return {
                success: true,
                output: JSON.stringify({
                    subagentId,
                    name,
                    status: 'running',
                    toolScope: requestedScope,
                    maxSteps: record.maxSteps,
                    message: `Subagent [${name}] is running. Poll it with action "list"; the result appears there when it finishes.`
                }, null, 2)
            };
        }
        catch (e) {
            return { success: false, error: getErrorMessage(e) };
        }
    }
};
