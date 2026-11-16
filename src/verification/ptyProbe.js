import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';

const DRIVER = String.raw`
import base64, json, os, pty, select, signal, sys, time
cfg=json.loads(sys.argv[1])
pid,fd=pty.fork()
if pid==0:
    os.chdir(cfg["cwd"])
    os.execvpe(cfg["argv"][0],cfg["argv"],os.environ)
start=time.monotonic()
sent=False
closed=False
done=False
status=None
overflow=False
out=bytearray()
while True:
    elapsed=time.monotonic()-start
    if not sent and elapsed>=cfg["delay"]/1000:
        if cfg["input"]:
            try: os.write(fd,base64.b64decode(cfg["input"]))
            except OSError: pass
        sent=True
    readable,_,_=select.select([fd],[],[],0.04)
    if readable and not closed:
        try: chunk=os.read(fd,8192)
        except OSError: chunk=b""
        if not chunk: closed=True
        else:
            remaining=cfg["limit"]-len(out)
            if len(chunk)>remaining: overflow=True
            out.extend(chunk[:max(0,remaining)])
    if not done:
        got,info=os.waitpid(pid,os.WNOHANG)
        if got:
            done=True
            status=os.waitstatus_to_exitcode(info)
    if done and closed: break
    if elapsed>cfg["timeout"]/1000:
        if not done:
            try: os.killpg(pid,signal.SIGKILL)
            except ProcessLookupError: pass
            got,info=os.waitpid(pid,0)
            status=os.waitstatus_to_exitcode(info)
            done=True
        break
os.write(1,bytes(out))
os.write(2,("PTY_RESULT:"+json.dumps({"exit":status,"timeout":elapsed>cfg["timeout"]/1000,"truncated":overflow,"inputSent":sent})+"\n").encode())
`;

function resolveCommand(workspace, program) {
  const base = realpathSync(workspace);
  if (program === 'node') return process.execPath;
  if (typeof program !== 'string' || !path.isAbsolute(program)) {
    throw new Error('Only node or an absolute workspace executable is permitted');
  }
  const resolved = realpathSync(program);
  const relative = path.relative(base, resolved);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Executable must be inside workspace');
  }
  return resolved;
}

export async function runPtyProbe(options = {}) {
  const { workspace, program = 'node', args = [], input = '', contains = null,
    timeoutMs = 5000, inputDelayMs = 100, outputLimit = 65536,
    expectedExitCode = 0 } = options;
  if (typeof workspace !== 'string' || !Array.isArray(args)
      || !args.every(a => typeof a === 'string') || typeof input !== 'string') {
    throw new TypeError('workspace, argv, and input must be valid strings');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000
      || !Number.isSafeInteger(inputDelayMs) || inputDelayMs < 0 || inputDelayMs >= timeoutMs
      || !Number.isSafeInteger(outputLimit) || outputLimit < 128 || outputLimit > 1048576) {
    throw new RangeError('Invalid PTY probe limits');
  }
  if (!Number.isInteger(expectedExitCode) || expectedExitCode < 0 || expectedExitCode > 255
      || (contains !== null && (typeof contains !== 'string' || contains.length > 1024))) {
    throw new TypeError('Invalid PTY probe assertion');
  }
  const cwd = realpathSync(workspace);
  const executable = resolveCommand(workspace, program);
  if (process.platform === 'win32') {
    return { status: 'unavailable', success: false,
      reason: 'Windows ConPTY adapter is not installed', surface: 'none' };
  }
  const config = { cwd, argv: [executable, ...args],
    input: Buffer.from(input).toString('base64'), delay: inputDelayMs,
    timeout: timeoutMs, limit: outputLimit };
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let spawnedError = null;
    const child = spawn('python3', ['-c', DRIVER, JSON.stringify(config)], {
      cwd, shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CAUSYNE_VERIFY_PROBE: '1' }
    });
    child.stdout.on('data', bytes => { stdout += bytes.toString('utf8'); });
    child.stderr.on('data', bytes => { stderr += bytes.toString('utf8'); });
    child.on('error', error => { spawnedError = String(error.message || error); });
    child.on('close', () => {
      if (spawnedError && /ENOENT/.test(spawnedError)) {
        resolve({ status: 'unavailable', success: false, surface: 'none',
          reason: 'python3 is required for POSIX PTY verification' });
        return;
      }
      const marker = stderr.match(/PTY_RESULT:(\{[^\n]+\})/);
      let detail;
      try { detail = marker ? JSON.parse(marker[1]) : null; } catch { detail = null; }
      const success = Boolean(detail && !detail.timeout && !detail.truncated
        && detail.exit === expectedExitCode && detail.inputSent
        && (contains === null || stdout.includes(contains)));
      resolve({ status: success ? 'observed-pass' : 'observed-fail', success,
        surface: detail ? 'posix-pty' : 'unverified', stdout,
        stderr: stderr.replace(/PTY_RESULT:\{[^\n]+\}\n?/, ''),
        exitCode: detail?.exit ?? null, timedOut: detail?.timeout ?? null,
        truncated: detail?.truncated ?? null, inputSent: detail?.inputSent ?? false,
        reason: detail ? null : (spawnedError || 'PTY driver produced no valid exit evidence'),
        limitation: 'PTY verifies terminal input/output, not desktop pixels or host mouse settings' });
    });
  });
}
