import { verifyCausyneTui, verifyCausyneChatMode } from '../src/verification/uiRuntime.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const invalid = args.filter(x => x !== '--json');
if (invalid.length) {
  process.stderr.write('Unexpected arguments: ' + invalid.join(' ') + '\n');
  process.exitCode = 2;
} else {
  const checks = [];
  for (const [name, verify] of [
    ['tui-components', verifyCausyneTui],
    ['real-chat-mode', verifyCausyneChatMode]
  ]) {
    try {
      const result = await verify();
      checks.push({
        name, status: result.status, success: Boolean(result.success),
        surface: result.surface || 'unverified',
        exitCode: result.exitCode ?? null, timedOut: result.timedOut ?? null,
        reason: result.reason || null,
        observations: (result.observations || []).map(item => ({
          name: item.name, matched: item.matched, bytes: item.bytes
        }))
      });
    } catch (error) {
      checks.push({ name, status: 'observed-fail', success: false,
        reason: error instanceof Error ? error.message : String(error), observations: [] });
    }
  }
  const success = checks.every(x => x.success);
  const report = {
    feature: 'tui-usage', status: success ? 'observed-pass' : 'observed-fail',
    success, checks,
    limitation: 'PTY verifies actual Causyne chat interactions, not desktop pixels or host mouse forwarding'
  };
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write('Causyne interactive TUI verification: ' + report.status + '\n');
    for (const check of checks) {
      process.stdout.write(check.name + ': ' + check.status + '\n');
      for (const item of check.observations) {
        process.stdout.write('  ' + item.name + ': ' + (item.matched ? 'observed' : 'missing') + '\n');
      }
      if (check.reason) process.stderr.write(check.reason + '\n');
    }
    process.stdout.write(report.limitation + '\n');
  }
  if (!success) process.exitCode = 1;
}
