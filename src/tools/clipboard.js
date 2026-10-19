import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';
export const clipboard = {
  schema: {
    name: 'clipboard',
    description: 'Read or write to the system clipboard securely without shell execution.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'write'], description: 'Action to perform' },
        text: { type: 'string', description: 'Text to write to the clipboard (required if action is write)' }
      },
      required: ['action']
    }
  },
  async execute(args) {
    try {
      const capability = await ensureCapability('desktop');
      if (!capability.ok) return { success: false, error: capability.reason, requiresConsent: capability.requiresConsent };
      const clipboardy = await loadCapabilityPackage('clipboardy');

      if (args.action === 'read') {
        const content = await clipboardy.read();
        return { success: true, output: content };
      } 
      else if (args.action === 'write') {
        if (!args.text) {
          return { success: false, error: 'Text argument is required for write action' };
        }
        await clipboardy.write(args.text);
        return { success: true, output: `Successfully wrote ${Buffer.byteLength(args.text, 'utf8')} bytes to OS Clipboard.` };
      }
    } catch (error) {
      return { success: false, error: `Clipboard action failed: ${error.message}` };
    }
  }
};
