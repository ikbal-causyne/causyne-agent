#!/usr/bin/env node
// Execute the readable modules reviewers receive in the package.
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('Causyne Agent requires Node.js 24 or newer.');
  process.exit(1);
}
// A previously interrupted version may leave terminal mouse reporting active.
// Reset on the next launch and on every exit, including errors before the TUI starts.
const { writeSync } = await import('node:fs');
const terminalReset = '\x1b[?1006l\x1b[?1000l\x1b[?1003l\x1b[?2004l\x1b[?25h';
const restoreTerminal = () => {
  const stream = process.stdout.isTTY ? process.stdout : (process.stderr.isTTY ? process.stderr : null);
  if (!stream) return;
  try { writeSync(stream.fd, terminalReset); } catch { /* disconnected terminal */ }
};
restoreTerminal();
process.once('exit', restoreTerminal);

try {
  const { startUpdateChecker } = await import('../src/autoUpdate.js');
  // A bare "causyne" checks the registry and installs a newer published version.
  // Never silently hide update errors while showing an old version in the banner.
  const update = await startUpdateChecker();
  if (update?.reason === 'failed' && process.stderr.isTTY) {
    process.stderr.write(`Causyne automatic update unavailable: ${update.error}. Starting installed version.\n`);
  }
  if (update && update.updated) {
    process.stderr.write(`Causyne Agent updated to ${update.latest}. Restarting...\n`);
    const { spawnSync } = await import('node:child_process');
    const child = spawnSync(process.execPath, process.argv.slice(1), {
      stdio: 'inherit',
      env: process.env
    });
    process.exit(child.status ?? 0);
  }
  await import('../src/entrypoint.js');
} catch (error) {
  restoreTerminal();
  console.error('Causyne Agent failed:', error);
  process.exitCode = 1;
}
