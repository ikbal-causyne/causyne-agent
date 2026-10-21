import {
  exec,
  execSync as nodeExecSync,
  type ExecOptions,
  type ExecSyncOptions
} from 'node:child_process';

// Compatibility wrapper, NOT a security boundary. These APIs invoke a shell.
// Callers must enforce approval and validate input; prefer execFile with argv.
export function execSync(command: string, options?: ExecSyncOptions): Buffer | string {
  return nodeExecSync(command, options);
}

export function execAsync(command: string, options: ExecOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, options, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
        return;
      }
      resolve(typeof stdout === 'string' ? stdout : String(stdout ?? ''));
    });
  });
}
