/**
 * Causyne Peer Agent Tool
 *
 * Delegates a bounded task to an external ACP agent that the user configured
 * in `~/.causyne/peers.json`. The model chooses a profile and writes a prompt;
 * it never chooses the executable, arguments, working directory, or
 * environment. Those come from the user's file and nowhere else.
 */

import { AcpClient } from '../acp/client.js';
import type { RequestPermissionRequest, RequestPermissionResponse } from '../acp/protocol.js';
import { getPeerProfile, loadPeerProfiles, peerEnvironment } from '../acp/peerProfiles.js';
import type { PeerProfile } from '../acp/peerProfiles.js';

export interface PeerAgentArgs {
  peer?: string;
  prompt: string;
  timeoutSeconds?: number;
}

const MAX_PROMPT_CHARS = 100_000;
const READ_ONLY_KINDS = new Set(['read', 'search', 'fetch', 'think']);

function selectPermission(profile: PeerProfile, request: RequestPermissionRequest): RequestPermissionResponse['outcome'] {
  const kind = request.toolCall.kind;
  const readLike = typeof kind === 'string' && READ_ONLY_KINDS.has(kind);
  if (profile.policy === 'read-only' && !readLike) {
    const reject = request.options.find((option) => option.kind === 'reject_once' || option.kind === 'reject_always');
    return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
  }
  const allow = request.options.find((option) => option.kind === 'allow_once' || option.kind === 'allow_always');
  return allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' };
}

export const peerAgentTool = {
  schema: {
    name: 'peer_agent_delegate',
    description: 'Delegate a bounded task to a peer ACP agent that the user configured in the peers file. The model supplies the peer id and the prompt only; the executable, arguments, working directory, environment, and permission policy come from the user configuration. Peers default to rejecting mutating permission requests; the external agent decides how to honor that policy.',
    parameters: {
      type: 'object',
      properties: {
        peer: {
          type: 'string',
          description: 'Id of a configured peer profile from the peers file.'
        },
        prompt: {
          type: 'string',
          description: 'Task instructions and context for the peer agent.'
        },
        timeoutSeconds: {
          type: 'number',
          description: 'Optional shorter timeout in seconds, bounded by the profile timeout.'
        }
      },
      required: ['peer', 'prompt']
    }
  },
  async execute(args: PeerAgentArgs): Promise<{ success: boolean; output?: string; error?: string }> {
    const peerId = String(args.peer || '').trim();
    const prompt = String(args.prompt || '').trim().slice(0, MAX_PROMPT_CHARS);
    if (!peerId) {
      const configured = loadPeerProfiles().map((profile) => profile.id);
      return {
        success: false,
        error: configured.length > 0
          ? `A peer id is required. Configured peers: ${configured.join(', ')}.`
          : 'No peer profiles are configured. Add one to the peers file first.'
      };
    }
    if (!prompt) {
      return { success: false, error: 'A prompt is required for peer delegation.' };
    }

    const profile = getPeerProfile(peerId);
    if (!profile) {
      return { success: false, error: `Unknown peer profile: ${peerId}.` };
    }

    const requested = typeof args.timeoutSeconds === 'number' && Number.isFinite(args.timeoutSeconds)
      ? Math.round(args.timeoutSeconds)
      : profile.timeoutSeconds;
    const timeoutSeconds = Math.max(5, Math.min(Math.min(profile.timeoutSeconds, requested), 1800));

    const client = new AcpClient({
      command: profile.command,
      args: profile.args,
      cwd: profile.cwd ?? process.cwd(),
      env: peerEnvironment(profile),
      promptTimeoutMs: timeoutSeconds * 1000,
      permissionHandler: async (request) => selectPermission(profile, request)
    });

    try {
      await client.start();
      const sessionId = await client.newSession(profile.cwd ?? process.cwd());
      const result = await client.prompt(sessionId, prompt);
      if (result.stopReason === 'cancelled') {
        return { success: false, error: 'The peer agent cancelled the task.' };
      }
      if (result.stopReason === 'refusal') {
        return { success: false, error: 'The peer agent refused the task.' };
      }
      return {
        success: true,
        output: result.text.trim() || 'Peer agent completed the task without a written summary.'
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Peer agent delegation failed.'
      };
    } finally {
      await client.close();
    }
  }
};
