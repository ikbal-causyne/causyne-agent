import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';
export const desktopOpen = {
  schema: {
    name: 'desktop.open',
    description: 'Securely open files, URLs, or applications using native OS handlers without shell execution.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'File path, URL, or app name' },
        app: { type: 'string', description: 'Specific app to open with (e.g., "Google Chrome")' }
      },
      required: ['target']
    }
  },
  async execute(args) {
    try {
      const capability = await ensureCapability('desktop');
      if (!capability.ok) return { success: false, error: capability.reason, requiresConsent: capability.requiresConsent };
      const open = await loadCapabilityPackage('open');

      const options = {};
      if (args.app) {
        options.app = { name: args.app };
      }

      // Phase 6 AGI Upgrade: Native Cross-Platform OS Handler
      await open(args.target, options);
      
      return { success: true, output: `Successfully dispatched native OS open event for: ${args.target}` };
    } catch (e) {
      return { success: false, error: `Failed to open: ${e.message}` };
    }
  }
};
