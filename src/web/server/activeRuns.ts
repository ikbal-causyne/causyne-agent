import type http from 'node:http';
import { AgentLoop } from '../../agentLoop.js';
import type { createApprovalScope } from '../../approvalGrants.js';
import type { McpServer } from '../../acp/protocol.js';
import { CAUSYNE_BROWSER_MCP_NAME } from '../skybridgeBrowserMcp.js';
import type {
  SessionActiveRun,
  SkybridgeDecisionAnswer,
  SkybridgeLoopFactory
} from './types.js';

const MAX_RUN_BUFFERED_FRAMES = 2400;
const MAX_RUN_BUFFERED_BYTES = 2 * 1024 * 1024;
const STREAM_HEARTBEAT_MS = 15_000;

export function createDefaultLoopFactory(
  serverApprovalScope: ReturnType<typeof createApprovalScope>,
  getBoundPort: () => number,
  token: string
): SkybridgeLoopFactory {
  const buildSharedBrowserPeerMcp = (): McpServer[] => {
    const port = getBoundPort();
    if (!port) return [];
    return [{
      type: 'http',
      name: CAUSYNE_BROWSER_MCP_NAME,
      url: `http://127.0.0.1:${port}/api/mcp/browser`,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }]
    }];
  };

  return (sink, taskId, prompt, opts) => {
    const loopOptions: {
      workspaceRoot: string;
      memorySessionId?: string | null;
      provider?: string;
      model?: string;
      approvalScope?: ReturnType<typeof createApprovalScope>;
      peerMcpServers?: McpServer[];
    } = {
      workspaceRoot: opts.workspaceRoot,
      approvalScope: serverApprovalScope,
      peerMcpServers: buildSharedBrowserPeerMcp()
    };
    if (opts.sessionId) loopOptions.memorySessionId = opts.sessionId;
    if (opts.provider) loopOptions.provider = opts.provider;
    if (opts.model) loopOptions.model = opts.model;

    const loop = new AgentLoop(sink, taskId, prompt, loopOptions);
    if (typeof opts.permissionPreset === 'string' && opts.permissionPreset) {
      try {
        loop.setPermissionPreset(opts.permissionPreset);
      } catch {
        // Fallback to mode normalization below.
      }
    } else if (opts.mode === 'A' || opts.mode === 'B' || opts.mode === 'C') {
      try {
        loop.setAutonomyMode(opts.mode);
      } catch {
        // Fallback when custom mode normalization differs.
      }
    }

    const pendingDecisions = new Map<string, (answer: SkybridgeDecisionAnswer | null) => void>();
    loop.waitForDecision = (request: any) => {
      const reqId = typeof request?.id === 'string' && request.id ? request.id : `dec_${Date.now()}`;
      return new Promise<SkybridgeDecisionAnswer | null>((resolve) => {
        pendingDecisions.set(reqId, resolve);
      });
    };

    return {
      run: () => loop.run(),
      abort: () => {
        for (const [, resolve] of pendingDecisions) {
          try { resolve(null); } catch { /* ignore */ }
        }
        pendingDecisions.clear();
        loop.abort();
      },
      resolveApproval: (toolCallId: string, approved: boolean) => {
        const resolver = loop.pendingApprovals.get(toolCallId);
        if (resolver) resolver(approved);
      },
      resolveDecision: (requestId: string, answer: SkybridgeDecisionAnswer | null) => {
        const resolver = pendingDecisions.get(requestId);
        if (resolver) {
          pendingDecisions.delete(requestId);
          resolver(answer);
        }
      },
      grantAlways: (toolName: string) => {
        serverApprovalScope.grantAlways(toolName);
      }
    };
  };
}

export function pushRunFrame(run: SessionActiveRun, raw: string): void {
  const clean = raw.replace(/\r?\n/g, ' ');
  const frameBytes = Buffer.byteLength(clean, 'utf8');
  if (run.frames.length < MAX_RUN_BUFFERED_FRAMES && run.bufferedBytes + frameBytes <= MAX_RUN_BUFFERED_BYTES) {
    run.frames.push(clean);
    run.bufferedBytes += frameBytes;
  }
  for (const send of run.subscribers) {
    try {
      send(clean);
    } catch {
      // Isolate subscriber write failures so detached runs continue uninterrupted.
    }
  }
}

export function attachRunStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  run: SessionActiveRun,
  replayBuffered: boolean
): void {
  req.setTimeout(0);
  res.setTimeout(0);
  try { req.socket?.setKeepAlive(true, STREAM_HEARTBEAT_MS); } catch { /* ignore */ }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const writeLine = (cleanFrame: string): void => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`${cleanFrame}\n`);
  };

  const heartbeatTimer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    writeLine(JSON.stringify({ type: 'heartbeat', ts: Date.now() }));
  }, STREAM_HEARTBEAT_MS);
  heartbeatTimer.unref?.();

  let detached = false;
  const detach = (): void => {
    if (detached) return;
    detached = true;
    clearInterval(heartbeatTimer);
    run.subscribers.delete(writeLine);
    run.doneSubscribers.delete(finishResponse);
  };

  const finishResponse = (): void => {
    detach();
    if (!res.writableEnded && !res.destroyed) res.end();
  };

  // Disconnecting a tab only unsubscribes this HTTP response; POST /api/stop cancels the run.
  res.on('close', detach);

  if (replayBuffered) {
    for (const frame of run.frames) {
      writeLine(frame);
    }
  }

  if (run.status === 'running' || run.status === 'awaiting_client') {
    run.subscribers.add(writeLine);
    run.doneSubscribers.add(finishResponse);
  } else {
    finishResponse();
  }
}
