import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeSubprocessEnv } from '../tools/subprocessEnv.js';
import { isBlockedWorkspaceRoot } from '../sandboxPolicy.js';

const DRIVER = String.raw`import base64, fcntl, json, os, pty, select, signal, struct, sys, termios, time
cfg=json.loads(sys.argv[1])
pid,fd=pty.fork()
if pid==0:
    os.chdir(cfg["cwd"])
    os.environ["TERM"]="xterm-256color"
    os.environ["COLUMNS"]=str(cfg["cols"])
    os.environ["LINES"]=str(cfg["rows"])
    os.execv(cfg["exec"],cfg["argv"])
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack("HHHH",cfg["rows"],cfg["cols"],0,0))
started=time.monotonic()
out=bytearray()
observations=[]
cursor=0
since=0
pending_enter=None
done=False
closed=False
timeout=False
overflow=False
exit_code=None
while True:
    elapsed=(time.monotonic()-started)*1000
    if pending_enter is not None and elapsed>=pending_enter[0]:
        try: os.write(fd,pending_enter[1])
        except OSError: pass
        pending_enter=None
    readable,_,_=select.select([fd],[],[],0.025)
    if readable and not closed:
        try: chunk=os.read(fd,16384)
        except OSError: chunk=b""
        if not chunk: closed=True
        else:
            room=max(0,cfg["limit"]-len(out))
            if len(chunk)>room: overflow=True
            out.extend(chunk[:room])
    if cursor<len(cfg["steps"]) and not done and pending_enter is None:
        step=cfg["steps"][cursor]
        match=step["waitFor"]
        segment=bytes(out[since:]).decode("utf-8",errors="replace")
        if match in segment:
            observation={"name":step["name"],"offset":len(out),"expected":step["contains"]}
            observations.append(observation)
            payload=base64.b64decode(step["input"])
            # A real keyboard sends text then Enter. Combining both in one
            # PTY write makes Causyne correctly classify it as a bulk paste.
            if payload.endswith(b"\r") and len(payload)>1:
                try: os.write(fd,payload[:-1])
                except OSError: pass
                pending_enter=((time.monotonic()-started)*1000+65,b"\r")
            else:
                try: os.write(fd,payload)
                except OSError: pass
            since=len(out)
            cursor+=1
    if not done:
        got,status=os.waitpid(pid,os.WNOHANG)
        if got:
            done=True
            exit_code=os.waitstatus_to_exitcode(status)
    if done and closed: break
    if elapsed>cfg["timeout"]:
        timeout=True
        if not done:
            try: os.killpg(pid,signal.SIGKILL)
            except ProcessLookupError: pass
            try:
                got,status=os.waitpid(pid,0)
                exit_code=os.waitstatus_to_exitcode(status)
            except ChildProcessError: pass
        break
for n,item in enumerate(observations):
    end=observations[n+1]["offset"] if n+1<len(observations) else len(out)
    segment=bytes(out[item["offset"]:end]).decode("utf-8",errors="replace")
    item["matched"]=item["expected"] in segment
    item["bytes"]=end-item["offset"]
result={"exit":exit_code,"timeout":timeout,"truncated":overflow,
        "completed":cursor==len(cfg["steps"]),"steps":observations,
        "requested":len(cfg["steps"])}
os.write(1,bytes(out))
os.write(2,(cfg["marker"]+json.dumps(result)+"\n").encode("utf-8"))`;

export interface InteractivePtyStep {
  name: string;
  input: string;
  waitFor: string;
  contains: string;
}

export interface InteractivePtyObservation {
  name: string;
  offset: number;
  expected: string;
  matched: boolean;
  bytes: number;
}

export interface InteractivePtyOptions {
  workspace?: string;
  script?: string;
  steps?: InteractivePtyStep[];
  timeoutMs?: number;
  outputLimit?: number;
  rows?: number;
  columns?: number;
  env?: Record<string, string | undefined>;
}

export interface InteractivePtyResult {
  status: 'unavailable' | 'observed-pass' | 'observed-fail';
  success: boolean;
  surface: 'none' | 'posix-pty' | 'unverified';
  reason: string | null;
  exitCode?: number | null;
  timedOut?: boolean | null;
  truncated?: boolean | null;
  completed?: boolean;
  observations?: InteractivePtyObservation[];
  stdout?: string;
  stderr?: string;
  limitation?: string;
}

interface InteractiveDriverDetail {
  exit?: number | null;
  timeout?: boolean | null;
  truncated?: boolean | null;
  completed?: boolean;
  steps?: InteractivePtyObservation[];
  requested?: number;
}

function bounded(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError('Invalid ' + label);
  }
  return value;
}

export async function runInteractivePty(options: InteractivePtyOptions = {}): Promise<InteractivePtyResult> {
  const safeOptions = options && typeof options === 'object' ? options : {};
  const {
    workspace,
    script,
    steps,
    timeoutMs = 15000,
    outputLimit = 1048576,
    rows = 42,
    columns = 126,
    env = {}
  } = safeOptions;
  if (typeof workspace !== 'string' || workspace.includes('\0')
      || typeof script !== 'string' || script.includes('\0')
      || !Array.isArray(steps) || steps.length < 1 || steps.length > 12) {
    throw new TypeError('workspace, script, and 1..12 interaction steps are required');
  }
  bounded(timeoutMs, 1000, 60000, 'timeoutMs');
  bounded(outputLimit, 1024, 2097152, 'outputLimit');
  bounded(rows, 20, 100, 'rows');
  bounded(columns, 48, 240, 'columns');
  for (const step of steps) {
    if (!step || typeof step.name !== 'string' || !/^[\w-]{1,50}$/.test(step.name)
        || typeof step.input !== 'string' || step.input.length > 2048
        || typeof step.waitFor !== 'string' || !step.waitFor
        || step.waitFor.length > 200 || typeof step.contains !== 'string'
        || step.contains.length > 200) {
      throw new TypeError('Each step requires bounded name, input, waitFor and contains strings');
    }
  }
  if (!env || typeof env !== 'object' || Array.isArray(env)
      || Object.keys(env).some(key => !['CAUSYNE_HOME'].includes(key))) {
    throw new TypeError('Only an isolated CAUSYNE_HOME environment override is permitted');
  }
  if (typeof env.CAUSYNE_HOME !== 'string' || env.CAUSYNE_HOME.includes('\0') || !path.isAbsolute(env.CAUSYNE_HOME)) {
    throw new TypeError('An explicit isolated CAUSYNE_HOME path is required');
  }
  const tempRoot = realpathSync(os.tmpdir());
  const isolatedHome = realpathSync(env.CAUSYNE_HOME);
  const relativeHome = path.relative(tempRoot, isolatedHome);
  if (!relativeHome || relativeHome === '..' || relativeHome.startsWith('..' + path.sep)
      || path.isAbsolute(relativeHome) || !statSync(isolatedHome).isDirectory()) {
    throw new Error('Verification CAUSYNE_HOME must be an isolated temporary directory');
  }
  const cwd = realpathSync(workspace);
  if (isBlockedWorkspaceRoot(cwd)) {
    throw new Error('Verification workspace cannot be a protected system root');
  }
  const target = realpathSync(path.resolve(cwd, script));
  const relative = path.relative(cwd, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep)
      || path.isAbsolute(relative) || !/\.[cm]?js$/.test(target) || !statSync(target).isFile()) {
    throw new Error('Interactive verification target must be a workspace JavaScript file');
  }
  if (process.platform === 'win32') {
    return {
      status: 'unavailable',
      success: false,
      surface: 'none',
      reason: 'A Windows ConPTY adapter has not been implemented'
    };
  }
  const markerPrefix = `CAUSYNE_UI_PTY_RESULT:${crypto.randomBytes(12).toString('hex')}:`;
  const cfg = {
    cwd,
    marker: markerPrefix,
    exec: process.execPath,
    argv: [process.execPath, target],
    rows,
    cols: columns,
    timeout: timeoutMs,
    limit: outputLimit,
    steps: steps.map(step => ({
      name: step.name,
      input: Buffer.from(step.input, 'utf8').toString('base64'),
      waitFor: step.waitFor,
      contains: step.contains
    }))
  };
  return new Promise<InteractivePtyResult>(resolve => {
    const maxNodeStdout = outputLimit + 16384;
    let stdout = '';
    let nodeStdoutTruncated = false;
    let stderr = '';
    let spawnError: NodeJS.ErrnoException | null = null;
    let hardTimedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const child = spawn('python3', ['-c', DRIVER, JSON.stringify(cfg)], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...sanitizeSubprocessEnv(process.env),
        ...env,
        TERM: 'xterm-256color',
        COLUMNS: String(columns),
        LINES: String(rows),
        CAUSYNE_VERIFY_PROBE: '1'
      }
    });
    child.stdout.on('data', (data: Buffer) => {
      const remaining = maxNodeStdout - stdout.length;
      if (remaining <= 0) {
        nodeStdoutTruncated = true;
        return;
      }
      const text = data.toString('utf8');
      if (text.length > remaining) {
        stdout += text.slice(0, remaining);
        nodeStdoutTruncated = true;
      } else {
        stdout += text;
      }
    });
    const MAX_NODE_STDERR = 262144;
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString('utf8');
      if (stderr.length > MAX_NODE_STDERR) {
        stderr = stderr.slice(-MAX_NODE_STDERR);
      }
    });
    const hardTimer = setTimeout(() => {
      hardTimedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 1500);
      killTimer.unref();
    }, timeoutMs + 5000);
    hardTimer.unref();
    const clearTimers = (): void => {
      clearTimeout(hardTimer);
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };
    child.on('error', (e: NodeJS.ErrnoException) => { spawnError = e; clearTimers(); });
    child.on('close', () => {
      clearTimers();
      if (spawnError?.code === 'ENOENT') {
        resolve({
          status: 'unavailable',
          success: false,
          surface: 'none',
          reason: 'python3 is required for POSIX terminal verification'
        });
        return;
      }
      const markerIdx = stderr.lastIndexOf(markerPrefix);
      let detail: InteractiveDriverDetail | null = null;
      let cleanedStderr = stderr;
      if (markerIdx !== -1) {
        const jsonStart = markerIdx + markerPrefix.length;
        const lineEnd = stderr.indexOf('\n', jsonStart);
        const rawJson = (lineEnd === -1 ? stderr.slice(jsonStart) : stderr.slice(jsonStart, lineEnd)).replace(/\r$/, '');
        try { detail = JSON.parse(rawJson) as InteractiveDriverDetail; } catch { detail = null; }
        const afterLine = lineEnd === -1 ? '' : stderr.slice(lineEnd + 1);
        cleanedStderr = stderr.slice(0, markerIdx) + afterLine;
      }
      const observations: InteractivePtyObservation[] = Array.isArray(detail?.steps) ? detail.steps : [];
      const truncated = Boolean(detail?.truncated || nodeStdoutTruncated);
      const timedOut = Boolean(detail?.timeout || hardTimedOut);
      const success = Boolean(detail && !timedOut && !truncated
        && detail.completed && detail.exit === 0
        && observations.length === steps.length
        && observations.every(item => item.matched));
      resolve({
        status: success ? 'observed-pass' : 'observed-fail',
        success,
        surface: detail ? 'posix-pty' : 'unverified',
        exitCode: detail?.exit ?? null,
        timedOut: detail ? timedOut : (hardTimedOut ? true : null),
        truncated: detail ? truncated : (nodeStdoutTruncated ? true : null),
        completed: detail?.completed ?? false,
        observations,
        stdout,
        stderr: cleanedStderr,
        reason: detail ? null : (spawnError?.message || 'No valid PTY evidence'),
        limitation: 'Actual TUI components run in a PTY; host screenshots, mouse forwarding, and the full CLI launch are separate checks'
      });
    });
  });
}
