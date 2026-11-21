import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';
import { getErrorMessage, sanitizeToolError, sanitizeToolText } from './toolPathSafety.js';

const MAX_CLIPBOARD_BYTES = 256 * 1024;

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

      if (args?.action === 'read') {
        const content = await clipboardy.read();
        const sanitized = sanitizeToolText(content, MAX_CLIPBOARD_BYTES);
        return { success: true, output: sanitized };
      } else if (args?.action === 'write') {
        if (typeof args.text !== 'string' || !args.text) {
          return { success: false, error: 'Text argument is required for write action' };
        }
        const byteLen = Buffer.byteLength(args.text, 'utf8');
        if (byteLen > MAX_CLIPBOARD_BYTES) {
          return { success: false, error: `Clipboard write exceeds maximum limit of ${MAX_CLIPBOARD_BYTES} bytes.` };
        }
        await clipboardy.write(args.text);
        return { success: true, output: `Successfully wrote ${byteLen} bytes to OS Clipboard.` };
      } else {
        return { success: false, error: 'Invalid clipboard action; expected "read" or "write".' };
      }
    } catch (error: unknown) {
      return { success: false, error: `Clipboard action failed: ${sanitizeToolError(error)}` };
    }
  }
};
