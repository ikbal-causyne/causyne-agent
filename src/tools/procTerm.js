import { sendSignal } from '../procSignal.js';
import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';

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
  async execute(args) {
    try {
      const signal = args.signal || 'SIGTERM';
      let targetPids = [];
      
      if (args.pid) {
        targetPids.push(args.pid);
      } 
      else if (args.name || args.port) {
        // D-2 resolved: `find-process` was referenced but was in neither
        // dependencies nor node_modules, so this branch had never once worked.
        // Adding it would have meant a new static dependency (ZM-06); instead
        // the resolution reuses systeminformation, which the "system"
        // capability group already provisions for process_list. One package,
        // one consent prompt, two tools.
        const capability = await ensureCapability('system');
        if (!capability.ok) {
          return {
            success: false,
            error: capability.reason + ' Until then, pass an explicit numeric pid.',
            requiresConsent: capability.requiresConsent
          };
        }
        const si = await loadCapabilityPackage('systeminformation');

        let results = [];
        if (args.name) {
          const wanted = String(args.name).toLowerCase();
          const data = await si.processes();
          results = (data.list || []).filter(proc =>
            String(proc.name || '').toLowerCase().includes(wanted) ||
            String(proc.command || '').toLowerCase().includes(wanted)
          );
        } else if (args.port) {
          // Port ownership is a separate table; map it back to the pid.
          const connections = await si.networkConnections();
          const wanted = String(args.port);
          results = (connections || [])
            .filter(conn => String(conn.localPort) === wanted && conn.pid)
            .map(conn => ({ pid: Number(conn.pid) }));
        }

        if (results.length === 0) {
          return { success: false, error: `No matching processes found for ${args.name || 'port ' + args.port}` };
        }
        targetPids = [...new Set(results.map(proc => proc.pid))].filter(Number.isInteger);
      } 
      else {
        return { success: false, error: 'Must provide pid, name, or port' };
      }
      
      // Phase 6 AGI Upgrade: Graceful Native POSIX Signal Delivery
      let killedCount = 0;
      let failedCount = 0;
      
      for (const pid of targetPids) {
        try {
          sendSignal(pid, signal);
          killedCount++;
        } catch (e) {
          failedCount++;
        }
      }
      
      if (killedCount === 0 && failedCount > 0) {
        return { success: false, error: `Failed to deliver ${signal} to ${failedCount} processes. They may be immune or require elevated privileges.` };
      }
      
      return { success: true, output: `Successfully dispatched native ${signal} signal to ${killedCount} processes.` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
