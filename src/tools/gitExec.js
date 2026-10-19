import { exec } from 'child_process';
import os from 'os';

export const gitExec = {
  schema: {
    name: 'gitOp',
    description: 'Execute a git command securely. Features autonomous conflict detection and HitL interception for destructive commands.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Git subcommand (e.g., "status", "commit -m init")' },
        cwd: { type: 'string' }
      },
      required: ['command']
    }
  },
  async execute(args) {
    const cwd = (args.cwd || process.cwd()).replace(/^~\//, os.homedir() + '/');
    let cmdString = args.command;
    
    // Phase 5 AGI Upgrade: Boundary Conditions
    if (cmdString.includes('-i') || cmdString.includes('interactive')) {
      return { success: false, error: 'Interactive workflows (e.g., rebase -i) are strictly forbidden in AGI automation. Use precise non-interactive commands.' };
    }
    
    if (cmdString.includes('push -f') || cmdString.includes('push --force') || cmdString.includes('branch -D')) {
      return { success: false, error: '[HITL_APPROVAL_REQUIRED] Destructive Git action detected. You must ask the user for explicit permission before running this.' };
    }

    const command = `git ${cmdString}`;
    
    return new Promise((resolve) => {
      exec(command, { cwd, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
        const fullOutput = (stdout || '') + '\n' + (stderr || '');
        
        // Phase 5 AGI Upgrade: Autonomous Conflict Detection
        if (fullOutput.includes('CONFLICT (content): Merge conflict')) {
          resolve({ 
            success: false, 
            error: `[AUTONOMOUS CONFLICT DETECTED]\nGit merge conflict occurred. DO NOT PANIC.\n1. Use fs.read to read the conflicted files.\n2. Analyze the <<<<<<< HEAD markers.\n3. Use fs.edit to surgically resolve the conflict.\n4. Run git add and git commit.`, 
            output: fullOutput 
          });
          return;
        }

        if (error) {
          resolve({ success: false, output: stdout, error: stderr || error.message, exitCode: error.code });
        } else {
          resolve({ success: true, output: stdout || stderr, exitCode: 0 }); 
        }
      });
    });
  }
};
