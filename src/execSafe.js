import { exec, execSync as nodeExecSync } from 'node:child_process';

// Compatibility wrapper, NOT a security boundary. These APIs invoke a shell.
// Callers must enforce approval and validate input; prefer execFile with argv.
export function execSync(command, options) {
  return nodeExecSync(command, options);
}

export function execAsync(command, options = {}) {
  return new Promise((resolve, reject) => {
    exec(command, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(typeof stdout === 'string' ? stdout : String(stdout ?? ''));
    });
  });
}
