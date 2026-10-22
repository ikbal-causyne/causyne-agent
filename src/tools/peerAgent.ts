/**
 * Causyne Peer Agent Tool
 *
 * Delegates a bounded task to an external ACP agent (e.g. OpenCode, Claude Code,
 * Codex, Gemini CLI, Hermes, Cursor, Qwen). The model chooses a profile and writes
 * a prompt; it never chooses the raw executable or unrestricted arguments.
 * Those come from the catalog presets or the user's `~/.causyne/peers.json`.
 */

import path from 'node:path';
import { AcpClient } from '../acp/client.js';
import type { RequestPermissionRequest, RequestPermissionResponse } from '../acp/protocol.js';
import { getPeerProfile, listAllPeers, peerEnvironment } from '../acp/peerProfiles.js';
import type { PeerProfile } from '../acp/peerProfiles.js';
import { BUILTIN_PEER_PRESETS } from '../acp/agentCatalog.js';

export interface PeerAgentArgs {
  action?: 'delegate' | 'list' | 'status';
  peer?: string;
  prompt?: string;
  timeoutSeconds?: number;
  model?: string;
  mode?: string;
}

const MAX_PROMPT_CHARS = 100_000;
const READ_ONLY_KINDS = new Set(['read', 'search', 'fetch', 'think']);

function selectPermission(
  profile: PeerProfile,
  request: RequestPermissionRequest,
  workspaceRoot: string
): RequestPermissionResponse['outcome'] {
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
    // If locations are provided, verify they are inside workspaceRoot
    const locations = request.toolCall.locations || [];
    const isInsideWorkspace = locations.length === 0 || locations.every((loc) => {
      const resolved = path.resolve(workspaceRoot, loc.path);
      return !path.relative(workspaceRoot, resolved).startsWith('..') && !path.isAbsolute(path.relative(workspaceRoot, resolved));
    });

    if (isInsideWorkspace) {
      const allow = request.options.find((option) => option.kind === 'allow_once' || option.kind === 'allow_always');
      return allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' };
    } else {
      const reject = request.options.find((option) => option.kind === 'reject_once' || option.kind === 'reject_always');
      return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
    }
  }

  // 'ask' policy: default to rejecting unless read-like or user approval can be obtained
  if (readLike) {
    const allow = request.options.find((option) => option.kind === 'allow_once' || option.kind === 'allow_always');
    return allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' };
  }

  // Mutating requests under 'ask' policy default to requiring confirmation
  const allow = request.options.find((option) => option.kind === 'allow_once');
  return allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' };
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
  async execute(args: PeerAgentArgs = {}): Promise<{
    success: boolean;
    output?: string;
    error?: string;
    peers?: Array<{ id: string; label: string; policy: string; timeoutSeconds: number }>;
    agent?: string;
    stopReason?: string;
  }> {
    const action = args.action || (args.peer || args.prompt !== undefined ? 'delegate' : 'list');

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
    const peerId = String(args.peer || '').trim();
    const prompt = String(args.prompt || '').trim().slice(0, MAX_PROMPT_CHARS);

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

    const requestedTimeout = typeof args.timeoutSeconds === 'number' && Number.isFinite(args.timeoutSeconds)
      ? Math.round(args.timeoutSeconds)
      : profile.timeoutSeconds;
    const timeoutSeconds = Math.max(5, Math.min(Math.min(profile.timeoutSeconds, requestedTimeout), 1800));

    const workspaceRoot = profile.cwd || process.cwd();

    const client = new AcpClient({
      command: profile.command,
      args: profile.args,
      cwd: workspaceRoot,
      env: peerEnvironment(profile),
      promptTimeoutMs: timeoutSeconds * 1000,
      permissionHandler: async (request) => selectPermission(profile, request, workspaceRoot)
    });

    try {
      await client.start();
      const sessionId = await client.newSession(workspaceRoot);

      // Optional model selection if specified
      if (args.model && client.agentCapabilities?.promptCapabilities) {
        try {
          await client.setSessionModel(sessionId, args.model);
        } catch {
          // If model selection fails, continue with default model
        }
      }

      // Optional mode selection if specified
      if (args.mode) {
        try {
          await client.setSessionMode(sessionId, args.mode);
        } catch {
          // If mode selection fails, continue with default mode
        }
      }

      const result = await client.prompt(sessionId, prompt);
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
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const isAuthError = /auth|login|credentials|unauthorized/i.test(msg);
      const preset = BUILTIN_PEER_PRESETS[peerId.toLowerCase()];
      const instruction = preset?.setupInstruction ? `\nGuidance: ${preset.setupInstruction}` : '';

      return {
        success: false,
        error: isAuthError
          ? `Authentication required for peer "${peerId}": ${msg}.${instruction}`
          : `Peer agent delegation to "${peerId}" failed: ${msg}.${instruction}`
      };
    } finally {
      await client.close();
    }
  }
};
