import { readFileSync } from 'node:fs';
import os from 'os';
import { spawn } from 'child_process';


const MAC_RESOLVE_API = "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting";
const MAC_RESOLVE_LIB = "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so";


const PYTHON_SCRIPT = readFileSync(new URL('../tool-scripts/resolve_automator.py', import.meta.url), 'utf8');

export const resolveAutomator = {
  schema: {
    name: 'resolve.act',
    description: 'Automate DaVinci Resolve Studio for native Cinema Workflows. Requires Resolve to be running with External Scripting: Local enabled.',
    parameters: {
      type: 'object',
      properties: {
        action: { 
          type: 'string', 
          enum: ['checkConnection', 'setupColorManagement', 'importAndAssemble'] 
        },
        mediaPath: { 
          type: 'string', 
          description: 'Absolute path to media directory to import' 
        },
        color_space_mode: {
          type: 'string',
          enum: ['automatic', 'custom'],
          description: 'Use automatic (Resolve auto-detects based on metadata) or custom.'
        },
        fps: { 
          type: 'string', 
          description: 'Timeline framerate (e.g. 23.976) or "auto" to detect from clip metadata' 
        },
        resolution_x: { 
          type: 'string', 
          description: 'Timeline width or "auto"' 
        },
        resolution_y: { 
          type: 'string', 
          description: 'Timeline height or "auto"' 
        }
      },
      required: ['action']
    }
  },
  async execute(args) {
    if (os.platform() !== 'darwin') {
      return { success: false, error: "Currently, only macOS is fully supported for this Resolve script pipeline." };
    }

    const payload = JSON.stringify(args);

    return new Promise((resolvePromise) => {
      const env = {
        ...process.env,
        RESOLVE_SCRIPT_API: MAC_RESOLVE_API,
        RESOLVE_SCRIPT_LIB: MAC_RESOLVE_LIB,
        PYTHONPATH: `${process.env.PYTHONPATH || ''}:${MAC_RESOLVE_API}/Modules/`
      };

      
      const pyBin = "python3";

      
      const child = spawn(pyBin, ['-', payload], { env });

      let outputData = '';
      let errorData = '';

      child.stdout.on('data', (data) => {
        outputData += data.toString();
      });

      child.stderr.on('data', (data) => {
        errorData += data.toString();
      });

      child.on('close', (code) => {
        if (outputData.trim()) {
          try {
            const lines = outputData.trim().split('\n');
            const jsonLine = lines.find(l => l.trim().startsWith('{') && l.trim().endsWith('}'));
            if (jsonLine) {
              resolvePromise(JSON.parse(jsonLine));
              return;
            }
          } catch (e) {}
        }
        resolvePromise({
          success: false,
          error: errorData.trim() || outputData.trim() || `Python process exited with code ${code}`
        });
      });

      const decodedScript = PYTHON_SCRIPT;
      child.stdin.write(decodedScript);
      child.stdin.end();
    });
  }
};
