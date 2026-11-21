import { sendSignal } from '../procSignal.js';
import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';
import { getErrorMessage } from './toolPathSafety.js';

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
      const signal = args.signal || 'SIGTERM';
      let targetPids: number[] = [];

      if (args.pid !== undefined) {
        targetPids.push(Number(args.pid));
      } else if (args.name || args.port !== undefined) {
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
        if (args.name) {
          const wanted = String(args.name).toLowerCase();
          const data = await si.processes();
          results = (data.list || []).filter((proc) =>
            String(proc.name || '').toLowerCase().includes(wanted) ||
            String(proc.command || '').toLowerCase().includes(wanted)
          );
        } else if (args.port !== undefined) {
          const connections = await si.networkConnections();
          const wanted = String(args.port);
          results = (connections || [])
            .filter((conn) => String(conn.localPort) === wanted && conn.pid)
            .map((conn) => ({ pid: Number(conn.pid) }));
        }

        if (results.length === 0) {
          return { success: false, error: `No matching processes found for ${args.name || 'port ' + String(args.port)}` };
        }
        targetPids = [...new Set(results.map((proc) => Number(proc.pid)))].filter(Number.isInteger);
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
      return { success: false, error: getErrorMessage(e) };
    }
  }
};
