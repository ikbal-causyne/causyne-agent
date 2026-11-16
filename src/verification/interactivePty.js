import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
os.write(2,("CAUSYNE_UI_PTY_RESULT:"+json.dumps(result)+"\n").encode("utf-8"))`;

function bounded(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError('Invalid ' + label);
  }
  return value;
}

export async function runInteractivePty(options = {}) {
  const {
    workspace, script, steps, timeoutMs = 15000,
    outputLimit = 1048576, rows = 42, columns = 126, env = {}
  } = options;
  if (typeof workspace !== 'string' || typeof script !== 'string'
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
  if (typeof env.CAUSYNE_HOME !== 'string' || !path.isAbsolute(env.CAUSYNE_HOME)) {
    throw new TypeError('An explicit isolated CAUSYNE_HOME path is required');
  }
  const tempRoot = realpathSync(os.tmpdir());
  const isolatedHome = realpathSync(env.CAUSYNE_HOME);
  const relativeHome = path.relative(tempRoot, isolatedHome);
  if (!relativeHome || relativeHome === '..' || relativeHome.startsWith('..' + path.sep)
      || path.isAbsolute(relativeHome)) {
    throw new Error('Verification CAUSYNE_HOME must be an isolated temporary directory');
  }
  const cwd = realpathSync(workspace);
  const target = realpathSync(path.resolve(cwd, script));
  const relative = path.relative(cwd, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep)
      || path.isAbsolute(relative) || !/\.[cm]?js$/.test(target)) {
    throw new Error('Interactive verification target must be a workspace JavaScript file');
  }
  if (process.platform === 'win32') {
    return { status: 'unavailable', success: false, surface: 'none',
      reason: 'A Windows ConPTY adapter has not been implemented' };
  }
  const cfg = {
    cwd, exec: process.execPath, argv: [process.execPath, target],
    rows, cols: columns, timeout: timeoutMs, limit: outputLimit,
    steps: steps.map(step => ({
      name: step.name, input: Buffer.from(step.input, 'utf8').toString('base64'),
      waitFor: step.waitFor, contains: step.contains
    }))
  };
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let spawnError = null;
    const child = spawn('python3', ['-c', DRIVER, JSON.stringify(cfg)], {
      cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env, TERM: 'xterm-256color',
        COLUMNS: String(columns), LINES: String(rows), CAUSYNE_VERIFY_PROBE: '1' }
    });
    child.stdout.on('data', data => { stdout += data.toString('utf8'); });
    child.stderr.on('data', data => { stderr += data.toString('utf8'); });
    child.on('error', e => { spawnError = e; });
    child.on('close', () => {
      if (spawnError?.code === 'ENOENT') {
        resolve({ status: 'unavailable', success: false, surface: 'none',
          reason: 'python3 is required for POSIX terminal verification' });
        return;
      }
      const marker = stderr.match(/CAUSYNE_UI_PTY_RESULT:(\{[^\r\n]+\})/);
      let detail = null;
      try { if (marker) detail = JSON.parse(marker[1]); } catch {}
      const observations = Array.isArray(detail?.steps) ? detail.steps : [];
      const success = Boolean(detail && !detail.timeout && !detail.truncated
        && detail.completed && detail.exit === 0
        && observations.length === steps.length
        && observations.every(item => item.matched));
      resolve({
        status: success ? 'observed-pass' : 'observed-fail', success,
        surface: detail ? 'posix-pty' : 'unverified',
        exitCode: detail?.exit ?? null, timedOut: detail?.timeout ?? null,
        truncated: detail?.truncated ?? null,
        completed: detail?.completed ?? false, observations,
        stdout, stderr: stderr.replace(/CAUSYNE_UI_PTY_RESULT:\{[^\r\n]+\}\r?\n?/, ''),
        reason: detail ? null : (spawnError?.message || 'No valid PTY evidence'),
        limitation: 'Actual TUI components run in a PTY; host screenshots, mouse forwarding, and the full CLI launch are separate checks'
      });
    });
  });
}
