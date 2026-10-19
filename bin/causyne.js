#!/usr/bin/env node
// Execute the readable modules reviewers receive in the package.
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('Causyne Agent requires Node.js 24 or newer.');
  process.exit(1);
}
try {
  const { startUpdateChecker } = await import('../src/autoUpdate.js');
  const update = await startUpdateChecker();
  if (update && update.updated) {
    process.stderr.write(`Causyne updated to ${update.latest}. Starting the new version.\n`);
  }
  await import('../src/entrypoint.js');
} catch (error) {
  if (process.stdout.isTTY) process.stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?2004l\x1b[?25h');
  console.error('Causyne Agent failed:', error);
  process.exitCode = 1;
}
