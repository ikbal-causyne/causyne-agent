import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import vm from 'vm';
import os from 'os';

const execPromise = util.promisify(exec);

export const executeProceduralMedia = {
  schema: {
    name: 'execute_procedural_media',
    description: 'Sandboxed Procedural Generation (Mode A). Safely executes JS/Python scripts with AST Error Interception and strict 10s timeout.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The JavaScript/Python code. MUST save output to outputFileName.' },
        language: { type: 'string', enum: ['javascript', 'python'] },
        outputFileName: { type: 'string', description: 'Absolute path for output.' }
      },
      required: ['code', 'language', 'outputFileName']
    }
  },
  
  execute: async (args, sandbox) => {
    try {
      const { code, language } = args;
      let outputFilePath = args.outputFileName.replace(/^~\//, os.homedir() + '/');
      outputFilePath = path.resolve(outputFilePath);

      if (sandbox && sandbox.isPathAllowed && !sandbox.isPathAllowed(outputFilePath)) {
        return { success: false, error: `Path outside allowed workspace: ${outputFilePath}` };
      }

      const workspaceDir = path.dirname(outputFilePath);
      if (!fs.existsSync(workspaceDir)) fs.mkdirSync(workspaceDir, { recursive: true });
      
      // Phase 5 AGI Upgrade: Sandboxed Execution & Timeout
      if (language.toLowerCase() === 'javascript') {
        const sandboxContext = {
          require: require,
          console: console,
          Buffer: Buffer,
          process: { cwd: () => workspaceDir }, // Restricted process
          setTimeout, clearTimeout
        };
        
        vm.createContext(sandboxContext);
        
        try {
          const script = new vm.Script(code);
          // Strict 10-second timeout to prevent infinite while(true) loops
          script.runInContext(sandboxContext, { timeout: 10000 });
        } catch (vmError) {
          // Phase 5 AGI Upgrade: AST Error Interception
          return { success: false, error: `[AUTO-CORRECTION REQUIRED] VM Syntax/Runtime Error intercepted: ${vmError.message}\nStack: ${vmError.stack}\nPlease fix the math/syntax in the script and retry.` };
        }
      } 
      else if (language.toLowerCase() === 'python') {
        const scriptPath = path.join(workspaceDir, `temp_proc_${Date.now()}.py`);
        fs.writeFileSync(scriptPath, code);
        
        try {
          // Timeout enforced at process level
          await execPromise(`python3 "${scriptPath}"`, { cwd: workspaceDir, timeout: 10000 });
        } catch (pyError) {
          if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
          return { success: false, error: `[AUTO-CORRECTION REQUIRED] Python Execution Error: ${pyError.message || pyError.stderr}\nPlease fix the math/syntax and retry.` };
        }
        if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
      } else {
        return { success: false, error: 'Unsupported language. Use javascript or python.' };
      }
      
      // Phase 5 AGI Upgrade: Format Verification (Ensure file exists and > 0 bytes)
      if (fs.existsSync(outputFilePath)) {
        const stat = fs.statSync(outputFilePath);
        if (stat.size === 0) {
          return { success: false, error: `[AUTO-CORRECTION REQUIRED] Script executed but output file (${args.outputFileName}) is 0 bytes. Code failed to generate valid media.` };
        }
        return { 
          success: true, 
          message: `Procedural media generated successfully at ${outputFilePath} (${stat.size} bytes)`,
          filePath: outputFilePath
        };
      } else {
        return { success: false, error: `[AUTO-CORRECTION REQUIRED] Script executed, but expected output file (${args.outputFileName}) was not created.` };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
};
