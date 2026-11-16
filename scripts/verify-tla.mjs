import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const spec = path.join(root, 'formal', 'CausynePinnedPanels.tla');
const cfg = path.join(root, 'formal', 'CausynePinnedPanels.cfg');
const jar = process.env.CAUSYNE_TLC_JAR;
if (!jar || !existsSync(jar)) {
  process.stderr.write('TLC not executed: set CAUSYNE_TLC_JAR to an installed tla2tools.jar.\n');
  process.exitCode = 2;
} else {
  const args = ['-jar', path.resolve(jar), '-config', cfg, spec, '-workers', '1'];
  const child = spawn('java', args, { cwd: root, stdio: 'inherit', shell: false });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 45_000);
  const status = await new Promise(resolve => {
    child.on('error', error => { process.stderr.write(String(error) + '\n'); resolve(2); });
    child.on('close', code => resolve(code ?? 2));
  });
  clearTimeout(timeout);
  process.exitCode = status;
}
