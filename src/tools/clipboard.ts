import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';
import { getErrorMessage } from './toolPathSafety.js';

export interface ClipboardArgs {
  action?: 'read' | 'write' | string | undefined;
  text?: string | undefined;
}

export interface ClipboardResult {
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
  requiresConsent?: boolean | undefined;
}

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
  async execute(args: ClipboardArgs = {}): Promise<ClipboardResult> {
    try {
      const capability = await ensureCapability('desktop');
      if (!capability.ok) return { success: false, error: capability.reason, requiresConsent: capability.requiresConsent };
      const clipboardy = await loadCapabilityPackage('clipboardy') as {
        read(): Promise<string>;
        write(text: string): Promise<void>;
      };

      if (args.action === 'read') {
        const content = await clipboardy.read();
        return { success: true, output: content };
      } else if (args.action === 'write') {
        if (typeof args.text !== 'string' || !args.text) {
          return { success: false, error: 'Text argument is required for write action' };
        }
        await clipboardy.write(args.text);
        return { success: true, output: `Successfully wrote ${Buffer.byteLength(args.text, 'utf8')} bytes to OS Clipboard.` };
      } else {
        return { success: false, error: 'Invalid clipboard action; expected "read" or "write".' };
      }
    } catch (error: unknown) {
      return { success: false, error: `Clipboard action failed: ${getErrorMessage(error)}` };
    }
  }
};
