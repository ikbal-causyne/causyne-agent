/**
 * Causyne Peer Agent Tool
 *
 * Delegates a bounded task to an external ACP agent (e.g. OpenCode, Claude Code,
 * Codex, Gemini CLI, Hermes, Cursor, Qwen). The model chooses a profile and writes
 * a prompt; it never chooses the raw executable or unrestricted arguments.
 * Those come from the catalog presets or the user's `~/.causyne/peers.json`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AcpClient } from '../acp/client.js';
import { getPeerProfile, listAllPeers, peerEnvironment } from '../acp/peerProfiles.js';
import { BUILTIN_PEER_PRESETS } from '../acp/agentCatalog.js';
const execFileAsync = promisify(execFile);
const MAX_PROMPT_CHARS = 2_000_000;
const READ_ONLY_KINDS = new Set(['read', 'search', 'fetch', 'think']);
function resolveCanonicalPath(target) {
    const resolved = path.resolve(target);
    try {
        return fs.realpathSync(resolved);
    }
    catch {
        let current = resolved;
        const missing = [];
        for (let depth = 0; depth < 64; depth++) {
            const parent = path.dirname(current);
            if (parent === current)
                break;
            missing.unshift(path.basename(current));
            current = parent;
            try {
                return path.join(fs.realpathSync(current), ...missing);
            }
            catch {
                continue;
            }
        }
        return resolved;
    }
}
function isWithinWorkspaceRoot(workspaceRoot, candidatePath) {
    const canonicalRoot = resolveCanonicalPath(workspaceRoot);
    const canonicalTarget = resolveCanonicalPath(path.resolve(canonicalRoot, candidatePath));
    const rel = path.relative(canonicalRoot, canonicalTarget);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
async function selectPermission(profile, request, workspaceRoot, context) {
    const kind = request.toolCall.kind;
    const readLike = typeof kind === 'string' && READ_ONLY_KINDS.has(kind);
    if (profile.policy === 'read-only') {
        if (!readLike) {
            const reject = request.options.find((option) => option.kind === 'reject_once' || option.kind === 'reject_always');
            return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
        }
        const allow = request.options.find((option) => option.kind === 'allow_once' || option.kind === 'allow_always');
        return allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' };
    }
    if (profile.policy === 'workspace') {
        // If locations are provided, verify canonical realpaths stay inside workspaceRoot
        const locations = request.toolCall.locations || [];
        const isInsideWorkspace = locations.length === 0 || locations.every((loc) => typeof loc?.path === 'string' && loc.path.trim().length > 0 && isWithinWorkspaceRoot(workspaceRoot, loc.path.trim()));
        if (isInsideWorkspace) {
            const allow = request.options.find((option) => option.kind === 'allow_once' || option.kind === 'allow_always');
            return allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' };
        }
        else {
            const reject = request.options.find((option) => option.kind === 'reject_once' || option.kind === 'reject_always');
            return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
        }
    }
    // 'ask' policy: default to rejecting unless read-like or user approval can be obtained
    if (readLike) {
        const allow = request.options.find((option) => option.kind === 'allow_once' || option.kind === 'allow_always');
        return allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' };
    }
    // Mutating requests under 'ask' policy require explicit interactive user approval
    const approver = typeof context?.waitForApproval === 'function'
        ? context
        : typeof context?.parentLoop?.waitForApproval === 'function'
            ? context.parentLoop
            : undefined;
    if (approver?.waitForApproval) {
        const approvalId = `peer_${crypto.randomUUID()}`;
        approver.emitEvent?.({
            type: 'approval_request',
            toolCallId: approvalId,
            tool: `peer_agent:${profile.id}:${request.toolCall.title || request.toolCall.kind || 'action'}`,
            args: {
                peer: profile.id,
                kind: request.toolCall.kind,
                locations: request.toolCall.locations
            },
            risk: 'high'
        });
        const approved = await approver.waitForApproval(approvalId);
        if (approved) {
            const allow = request.options.find((option) => option.kind === 'allow_once');
            return allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' };
        }
    }
    const reject = request.options.find((option) => option.kind === 'reject_once' || option.kind === 'reject_always');
    return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
}
export const peerAgentTool = {
    schema: {
        name: 'peer_agent_delegate',
        description: 'Connect, inspect, or delegate a bounded task to an external ACP peer agent (such as OpenCode, Claude Code, Codex, Gemini CLI, Hermes, Cursor, or Qwen). Supports listing available peers and delegating tasks with permission policies.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['delegate', 'list', 'status'],
                    description: 'Action to perform: "delegate" to execute a task, "list" or "status" to view available peer agents.'
                },
                peer: {
                    type: 'string',
                    description: 'Id of the peer agent (e.g. "opencode", "claude", "codex", "hermes", "cursor", "gemini").'
                },
                prompt: {
                    type: 'string',
                    description: 'Task instructions and context for the peer agent (required when action is delegate).'
                },
                model: {
                    type: 'string',
                    description: 'Optional model to select on the peer agent (e.g. "opencode-free", "claude-3-7-sonnet").'
                },
                mode: {
                    type: 'string',
                    description: 'Optional session mode for the peer agent.'
                },
                timeoutSeconds: {
                    type: 'number',
                    description: 'Optional timeout in seconds (default 120, bounded between 5 and 1800).'
                }
            }
        }
    },
    async execute(args = {}, context = {}) {
        const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
        const action = safeArgs.action || (safeArgs.peer || safeArgs.prompt !== undefined ? 'delegate' : 'list');
        // 1. Action: list
        if (action === 'list' || action === 'status') {
            const allPeers = listAllPeers();
            const peerList = allPeers.map((p) => ({
                id: p.id,
                label: p.label,
                policy: p.policy,
                timeoutSeconds: p.timeoutSeconds
            }));
            const presetIds = Object.keys(BUILTIN_PEER_PRESETS).join(', ');
            return {
                success: true,
                peers: peerList,
                output: `Configured and discovered ACP peer agents:\n${peerList.map((p) => `• ${p.id} (${p.label}) [policy: ${p.policy}, timeout: ${p.timeoutSeconds}s]`).join('\n')}\n\nBuilt-in presets supported: ${presetIds}.`
            };
        }
        // 2. Action: delegate
        const peerId = String(safeArgs.peer || '').trim();
        const prompt = String(safeArgs.prompt || '').trim().slice(0, MAX_PROMPT_CHARS);
        if (!peerId) {
            const available = listAllPeers().map((p) => p.id);
            return {
                success: false,
                error: `A peer id is required for delegation. Available peers: ${available.join(', ')}.`
            };
        }
        if (!prompt) {
            return { success: false, error: 'A prompt is required for peer delegation.' };
        }
        const profile = getPeerProfile(peerId);
        if (!profile) {
            return { success: false, error: `Unknown peer profile: ${peerId}. Run with action "list" to see available peers.` };
        }
        const requestedTimeout = typeof safeArgs.timeoutSeconds === 'number' && Number.isFinite(safeArgs.timeoutSeconds)
            ? Math.round(safeArgs.timeoutSeconds)
            : profile.timeoutSeconds;
        const timeoutSeconds = Math.max(5, Math.min(Math.min(profile.timeoutSeconds, requestedTimeout), 1800));
        const workspaceRoot = profile.cwd
            || context?.parentLoop?.workspaceRoot
            || context?.workspaceRoot
            || context?.workspacePaths?.find((entry) => typeof entry === 'string' && entry.trim().length > 0)
            || process.cwd();
        if (peerId.toLowerCase() === 'antigravity') {
            try {
                const agyArgs = ['--output-format', 'json'];
                if (typeof safeArgs.model === 'string' && safeArgs.model.trim()) {
                    agyArgs.push(`--model=${safeArgs.model.trim()}`);
                }
                agyArgs.push(`-p=${prompt}`);
                const { stdout } = await execFileAsync(profile.command, agyArgs, {
                    cwd: workspaceRoot,
                    env: peerEnvironment(profile),
                    timeout: timeoutSeconds * 1000,
                    maxBuffer: 16 * 1024 * 1024,
                    windowsHide: true,
                    ...(context?.signal ? { signal: context.signal } : {})
                });
                let outputText = stdout.trim();
                try {
                    const parsed = JSON.parse(outputText);
                    if (typeof parsed?.response === 'string')
                        outputText = parsed.response.trim();
                }
                catch {
                    // keep raw stdout
                }
                return {
                    success: true,
                    agent: 'Google Antigravity',
                    output: outputText
                };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { success: false, agent: 'Google Antigravity', error: msg };
            }
        }
        const client = new AcpClient({
            command: profile.command,
            args: profile.args,
            cwd: workspaceRoot,
            env: peerEnvironment(profile),
            promptTimeoutMs: timeoutSeconds * 1000,
            permissionHandler: async (request) => selectPermission(profile, request, workspaceRoot, context)
        });
        try {
            await client.start(context?.signal);
            const sessionId = await client.newSession(workspaceRoot, [], context?.signal);
            // Optional model selection if specified
            if (typeof safeArgs.model === 'string' && safeArgs.model.trim()) {
                try {
                    await client.setSessionModel(sessionId, safeArgs.model.trim(), context?.signal);
                }
                catch {
                    // If model selection fails, continue with default model
                }
            }
            // Optional mode selection if specified
            if (typeof safeArgs.mode === 'string' && safeArgs.mode.trim()) {
                try {
                    await client.setSessionMode(sessionId, safeArgs.mode.trim());
                }
                catch {
                    // If mode selection fails, continue with default mode
                }
            }
            const result = await client.prompt(sessionId, prompt, context?.signal);
            if (result.stopReason === 'cancelled') {
                return { success: false, error: `The peer agent "${peerId}" cancelled the task.` };
            }
            if (result.stopReason === 'refusal') {
                return { success: false, error: `The peer agent "${peerId}" refused the task.` };
            }
            const agentName = client.agentInfo?.name || profile.label;
            return {
                success: true,
                agent: agentName,
                stopReason: result.stopReason,
                output: result.text.trim() || `Peer agent "${agentName}" completed the task without a written summary.`
            };
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            const isAuthError = /auth|login|credentials|unauthorized/i.test(msg);
            const presetKey = peerId.toLowerCase();
            const preset = Object.hasOwn(BUILTIN_PEER_PRESETS, presetKey) ? BUILTIN_PEER_PRESETS[presetKey] : undefined;
            const instruction = preset?.setupInstruction ? `\nGuidance: ${preset.setupInstruction}` : '';
            return {
                success: false,
                error: isAuthError
                    ? `Authentication required for peer "${peerId}": ${msg}.${instruction}`
                    : `Peer agent delegation to "${peerId}" failed: ${msg}.${instruction}`
            };
        }
        finally {
            await client.close();
        }
    }
};
