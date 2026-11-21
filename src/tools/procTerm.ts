import { sendSignal } from '../procSignal.js';
import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';
import { getErrorMessage, sanitizeToolError, sanitizeToolText } from './toolPathSafety.js';

const ALLOWED_SIGNALS = new Set(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGKILL', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2']);
const MAX_SIGNAL_TARGETS = 16;

export interface ProcTermArgs {
  pid?: number | undefined;
  name?: string | undefined;
  port?: number | undefined;
  signal?: string | undefined;
}

export interface ProcTermResult {
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
  requiresConsent?: boolean | undefined;
}

export const procTerm = {
  schema: {
    name: 'proc.term',
    description: 'Gracefully terminate a running process via native POSIX signals without shell execution vulnerabilities.',
    parameters: {
      type: 'object',
      properties: {
        pid: { type: 'number' },
        name: { type: 'string' },
        port: { type: 'number' },
        signal: { type: 'string', description: 'Signal name (e.g. SIGTERM, SIGKILL). Defaults to SIGTERM.' }
      }
    }
  },
  async execute(args: ProcTermArgs = {}): Promise<ProcTermResult> {
    try {
      const safeArgs = args && typeof args === 'object' ? args : {};
      const signal = typeof safeArgs.signal === 'string' && safeArgs.signal.trim()
        ? safeArgs.signal.trim().toUpperCase()
        : 'SIGTERM';
      if (!ALLOWED_SIGNALS.has(signal)) {
        return { success: false, error: `Unsupported signal "${sanitizeToolText(signal, 32)}". Allowed: ${[...ALLOWED_SIGNALS].join(', ')}` };
      }
      const protectedPids = new Set<number>([process.pid, process.ppid].filter((p) => Number.isInteger(p) && p > 0));
      let targetPids: number[] = [];

      if (safeArgs.pid !== undefined) {
        const numericPid = Number(safeArgs.pid);
        if (!Number.isInteger(numericPid) || numericPid <= 1) {
          return { success: false, error: 'pid must be a positive integer greater than 1.' };
        }
        if (protectedPids.has(numericPid)) {
          return { success: false, error: 'Refusing to terminate the active Causyne process or its parent shell.' };
        }
        targetPids.push(numericPid);
      } else if (safeArgs.name || safeArgs.port !== undefined) {
        const capability = await ensureCapability('system');
        if (!capability.ok) {
          return {
            success: false,
            error: capability.reason + ' Until then, pass an explicit numeric pid.',
            requiresConsent: capability.requiresConsent
          };
        }
        const si = await loadCapabilityPackage('systeminformation') as {
          processes(): Promise<{ list?: Array<{ pid?: number; name?: string; command?: string }> }>;
          networkConnections(): Promise<Array<{ localPort?: string | number; pid?: string | number }>>;
        };

        let results: Array<{ pid?: number }> = [];
        if (safeArgs.name !== undefined) {
          if (typeof safeArgs.name !== 'string' || safeArgs.name.trim().length < 2) {
            return { success: false, error: 'Process name filter must be at least 2 characters to prevent mass termination.' };
          }
          const wanted = safeArgs.name.trim().toLowerCase();
          const data = await si.processes();
          results = (data.list || []).filter((proc) =>
            String(proc.name || '').toLowerCase().includes(wanted) ||
            String(proc.command || '').toLowerCase().includes(wanted)
          );
        } else if (safeArgs.port !== undefined) {
          const portNum = Number(safeArgs.port);
          if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
            return { success: false, error: 'port must be an integer between 1 and 65535.' };
          }
          const connections = await si.networkConnections();
          const wanted = String(portNum);
          results = (connections || [])
            .filter((conn) => String(conn.localPort) === wanted && conn.pid)
            .map((conn) => ({ pid: Number(conn.pid) }));
        }

        targetPids = [...new Set(results.map((proc) => Number(proc.pid)))]
          .filter((pid) => Number.isInteger(pid) && pid > 1 && !protectedPids.has(pid));
        if (targetPids.length === 0) {
          return { success: false, error: `No matching safe processes found for ${sanitizeToolText(safeArgs.name || 'port ' + String(safeArgs.port), 80)}` };
        }
        if (targetPids.length > MAX_SIGNAL_TARGETS) {
          return { success: false, error: `Filter matched ${targetPids.length} processes (max ${MAX_SIGNAL_TARGETS}); narrow your target or pass an explicit pid.` };
        }
      } else {
        return { success: false, error: 'Must provide pid, name, or port' };
      }

      let killedCount = 0;
      let failedCount = 0;

      for (const pid of targetPids) {
        try {
          sendSignal(pid, signal);
          killedCount++;
        } catch {
          failedCount++;
        }
      }

      if (killedCount === 0 && failedCount > 0) {
        return { success: false, error: `Failed to deliver ${signal} to ${failedCount} processes. They may be immune or require elevated privileges.` };
      }

      return { success: true, output: `Successfully dispatched native ${signal} signal to ${killedCount} processes.` };
    } catch (e: unknown) {
      return { success: false, error: sanitizeToolError(e) };
    }
  }
};
