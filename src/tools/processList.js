import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';
export const processList = {
  schema: {
    name: 'process.list',
    description: 'List running processes using native OS bindings. Automatically filters out OS noise to protect Context Window.',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Filter by name (e.g. "node")' }
      }
    }
  },
  async execute(args) {
    try {
      // Phase 2 AGI Upgrade: Native OS Bindings
      const capability = await ensureCapability('system');
      if (!capability.ok) return { success: false, error: capability.reason, requiresConsent: capability.requiresConsent };
      const si = await loadCapabilityPackage('systeminformation');

      const processData = await si.processes();
      
      let filtered = processData.list.filter(p => {
        // AGI Optimization: Keep heavy applications (CPU > 5% or RAM > ~100MB depending on OS reporting)
        if (p.cpu > 5 || p.mem > 1) return true;
        
        // Keep common dev tools
        const name = p.name.toLowerCase();
        if (name.includes('node') || name.includes('python') || name.includes('docker') || name.includes('java') || name.includes('git')) return true;
        
        // Keep Causyne processes
        if (p.command && p.command.toLowerCase().includes('causyne')) return true;
        
        return false;
      });
      
      if (args.filter) {
        filtered = filtered.filter(p => p.name.toLowerCase().includes(args.filter.toLowerCase()));
      }
      
      const formatted = filtered.map(p => ({
        pid: p.pid,
        name: p.name,
        cpu_percent: Math.round(p.cpu),
        ram_mb: Math.round(p.memRss / 1024)
      }));
      
      return { success: true, output: JSON.stringify(formatted, null, 2) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
