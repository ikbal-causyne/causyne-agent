import { verifyCausyneTui } from '../src/verification/uiRuntime.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const invalid = args.filter(x => x !== '--json');
if (invalid.length) {
  process.stderr.write('Unexpected arguments: ' + invalid.join(' ') + '\n');
  process.exitCode = 2;
} else {
  let result;
  try {
    result = await verifyCausyneTui();
  } catch (error) {
    result = { status: 'observed-fail', success: false,
      reason: error instanceof Error ? error.message : String(error), observations: [] };
  }
  const report = {
    feature: 'tui-usage', status: result.status, success: Boolean(result.success),
    surface: result.surface || 'unverified', exitCode: result.exitCode ?? null,
    timedOut: result.timedOut ?? null, reason: result.reason || null,
    observations: (result.observations || []).map(item => ({
      name: item.name, matched: item.matched, bytes: item.bytes
    })),
    limitation: result.limitation || null
  };
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write('Causyne interactive TUI verification: ' + report.status + '\n');
    for (const item of report.observations) {
      process.stdout.write('  ' + item.name + ': ' + (item.matched ? 'observed' : 'missing') + '\n');
    }
    if (report.reason) process.stderr.write(report.reason + '\n');
    process.stdout.write('This validates actual TUI components in POSIX PTY, not desktop pixels or the published launcher.\n');
  }
  if (!report.success) process.exitCode = 1;
}
