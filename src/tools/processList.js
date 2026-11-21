import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';
import { getErrorMessage, sanitizeToolError, sanitizeToolText } from './toolPathSafety.js';
const MAX_PROCESS_ROWS = 200;
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
    async execute(args = {}) {
        try {
            const capability = await ensureCapability('system');
            if (!capability.ok)
                return { success: false, error: capability.reason, requiresConsent: capability.requiresConsent };
            const si = await loadCapabilityPackage('systeminformation');
            const processData = await si.processes();
            const rawList = Array.isArray(processData?.list) ? processData.list : [];
            let filtered = rawList.filter((p) => {
                if ((p.cpu ?? 0) > 5 || (p.mem ?? 0) > 1)
                    return true;
                const name = String(p.name || '').toLowerCase();
                if (name.includes('node') || name.includes('python') || name.includes('docker') || name.includes('java') || name.includes('git'))
                    return true;
                if (p.command && String(p.command).toLowerCase().includes('causyne'))
                    return true;
                return false;
            });
            if (typeof args?.filter === 'string' && args.filter) {
                const needle = args.filter.toLowerCase();
                filtered = filtered.filter((p) => String(p.name || '').toLowerCase().includes(needle));
            }
            const formatted = filtered.slice(0, MAX_PROCESS_ROWS).map((p) => ({
                pid: p.pid ?? 0,
                name: sanitizeToolText(p.name || '', 160),
                cpu_percent: Math.round(p.cpu ?? 0),
                ram_mb: Math.round((p.memRss ?? 0) / 1024)
            }));
            return { success: true, output: JSON.stringify(formatted, null, 2) };
        }
        catch (e) {
            return { success: false, error: getErrorMessage(e) };
        }
    }
};
