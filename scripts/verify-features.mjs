import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURE_MAP, selectFeatures } from '../src/verification/featureMap.js';
import { runCliProbe } from '../src/verification/cliProbe.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const argv = process.argv.slice(2);
const json = argv.includes('--json');
const listOnly = argv.includes('--list');
const ids = argv.filter(a => a !== '--json' && a !== '--list');
const report = { source: 'Causyne built-in feature verification',
  evidenceLevel: 'automated regression tests, not live GUI or PTY verification',
  selected: [], success: false, results: [] };
if (listOnly) {
  process.stdout.write(JSON.stringify(FEATURE_MAP, null, 2) + '\n');
} else {
  try {
    const targets = selectFeatures(ids);
    report.selected = targets.map(f => f.id);
    const files = [...new Set(targets.flatMap(f => f.automated))];
    const probe = await runCliProbe({
      workspace: root, program: 'node',
      args: ['--test', '--import', './tests/helpers/isolateState.js', ...files],
      timeoutMs: 60_000, outputLimit: 131_072,
      contains: null
    });
    report.results = [{ ...probe, testedFiles: files }];
    report.success = probe.success;
    report.liveRequired = targets.map(f => ({ feature: f.id, condition: f.liveRequired }));
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else {
    process.stdout.write(report.success ? 'Automated checks passed.\n' : 'Automated checks failed or could not run.\n');
    for (const item of report.results) process.stdout.write(item.stdout + item.stderr);
    if (report.error) process.stderr.write(report.error + '\n');
    process.stdout.write('Live PTY/desktop/browser verification is still separate.\n');
  }
  if (!report.success) process.exitCode = 1;
}
