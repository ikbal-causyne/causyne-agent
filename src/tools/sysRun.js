import { spawn } from 'child_process';
import os from 'os';

// Phase 1 AGI Upgrade: ANSI Stripper
function stripAnsi(string) {
  const pattern = [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))'
  ].join('|');
  return string.replace(new RegExp(pattern, 'g'), '');
}

export const sysRun = {
  schema: {
    name: 'sysRun',
    description: 'Execute a shell command. CRITICAL CONSTRAINTS: 1. NEVER use interactive flags (like git rebase -i). 2. Always use non-interactive flags (--yes, -y). 3. If running git commit, always run git status, git diff, and git log first.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run' },
        cwd: { type: 'string', description: 'Working directory' },
        timeout: { type: 'number', description: 'Timeout in ms (default 60000)' }
      },
      required: ['command'],
      additionalProperties: false
    }
  },
  async execute(args, context = {}) {
    const cwd = args.cwd ? args.cwd.replace(/^~\//, os.homedir() + '/') : process.cwd();
    const timeoutMs = args.timeout || 60000;
    const signal = context.signal;
    
    return new Promise((resolve) => {
      // Phase 1 AGI Upgrade: Spawn instead of Exec
      const shell = os.platform() === 'win32' ? 'cmd.exe' : '/bin/bash';
      const shellArgs = os.platform() === 'win32' ? ['/c', args.command] : ['-c', args.command];
      
      const child = spawn(shell, shellArgs, { cwd, signal });
      
      // Phase 1 AGI Upgrade: 50KB Ring Buffer (FIFO)
      const MAX_LENGTH = 50000;
      let outputBuffer = '';
      
      const appendToBuffer = (data) => {
        outputBuffer += data.toString();
        if (outputBuffer.length > MAX_LENGTH) {
          // Truncate from the start (keep the most recent 50KB)
          outputBuffer = '...[OUTPUT TRUNCATED]...\n' + outputBuffer.slice(outputBuffer.length - MAX_LENGTH);
        }
      };

      child.stdout.on('data', appendToBuffer);
      child.stderr.on('data', appendToBuffer);

      let timeoutId;
      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          child.kill('SIGKILL');
          resolve({ success: false, output: stripAnsi(outputBuffer), error: `Process timed out after ${timeoutMs}ms`, exitCode: 124 });
        }, timeoutMs);
      }

      child.on('error', (err) => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve({ success: false, output: stripAnsi(outputBuffer), error: err.message, exitCode: 1 });
      });

      child.on('close', (code) => {
        if (timeoutId) clearTimeout(timeoutId);
        const cleanOutput = stripAnsi(outputBuffer);
        
        if (code === 0) {
          resolve({ success: true, output: cleanOutput, exitCode: 0 });
        } else {
          if (signal && signal.aborted) {
             resolve({ success: false, output: cleanOutput, error: 'Process killed by user.', exitCode: 1 });
          } else {
             resolve({ success: false, output: cleanOutput, error: `Command exited with code ${code}`, exitCode: code });
          }
        }
      });
    });
  }
};

export const sysRunBg = {
  schema: {
    name: 'sysRunBg',
    description: 'Start a long-running process in background (dev servers, watchers)',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        label: { type: 'string' },
        maxDuration: { type: 'number' }
      },
      required: ['command', 'label']
    }
  },
  async execute(args) {
    // Phase 1 AGI Upgrade: Real Detached Process Implementation
    try {
      const cwd = args.cwd ? args.cwd.replace(/^~\//, os.homedir() + '/') : process.cwd();
      const shell = os.platform() === 'win32' ? 'cmd.exe' : '/bin/bash';
      const shellArgs = os.platform() === 'win32' ? ['/c', args.command] : ['-c', args.command];
      
      const child = spawn(shell, shellArgs, { 
        cwd, 
        detached: true, 
        stdio: 'ignore' // We don't track output for background tasks currently
      });
      
      child.unref(); // Allow Node to exit even if this child is running
      
      return { 
        success: true, 
        output: `Successfully started background task [${args.label}]: ${args.command}`,
        pid: child.pid
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
