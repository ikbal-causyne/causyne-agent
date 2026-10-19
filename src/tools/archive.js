import fs from 'fs/promises';
import { resolveUserPath } from '../utils/paths.js';
import { createReadStream, createWriteStream } from 'fs';
import path from 'path';
import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';

export const archive = {
  schema: {
    name: 'archive',
    description: 'Compress or extract archives securely using native Node streams (No Shell Tar).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['compress', 'extract'], description: 'Action to perform' },
        source: { type: 'string', description: 'Absolute path of the file/directory to compress or extract' },
        destination: { type: 'string', description: 'Absolute path for the output' }
      },
      required: ['action', 'source', 'destination']
    }
  },
  async execute(args) {
    try {
      const source = resolveUserPath(args.source);
      const dest = resolveUserPath(args.destination);
      
      if (args.action === 'compress') {
        const capability = await ensureCapability('archive');
        if (!capability.ok) return { success: false, error: capability.reason, requiresConsent: capability.requiresConsent };
        const archiver = await loadCapabilityPackage('archiver');
        
        return new Promise(async (resolve) => {
          const output = createWriteStream(dest);
          const archive = archiver('zip', { zlib: { level: 9 } });
          
          output.on('close', () => resolve({ success: true, output: `Compressed ${archive.pointer()} total bytes to ${dest}` }));
          archive.on('error', (err) => resolve({ success: false, error: err.message }));
          
          archive.pipe(output);
          
          const stat = await fs.stat(source);
          if (stat.isDirectory()) {
            archive.directory(source, false);
          } else {
            archive.file(source, { name: path.basename(source) });
          }
          await archive.finalize();
        });
      } 
      else if (args.action === 'extract') {
        const capability = await ensureCapability('archive');
        if (!capability.ok) return { success: false, error: capability.reason, requiresConsent: capability.requiresConsent };
        const extract = await loadCapabilityPackage('extract-zip');
        
        await fs.mkdir(dest, { recursive: true });
        await extract(source, { dir: dest });
        
        return { success: true, output: `Extracted successfully to ${dest}` };
      }
    } catch (error) {
      return { success: false, error: `Archive action failed: ${error.message}` };
    }
  }
};
