import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURE_MAP, selectFeatures } from '../src/verification/featureMap.js';
import { runCliProbe } from '../src/verification/cliProbe.js';
import { verifyCausyneTui } from '../src/verification/uiRuntime.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const argv = process.argv.slice(2);
const json = argv.includes('--json');
const listOnly = argv.includes('--list');
const live = argv.includes('--live');
const ids = argv.filter(a => a !== '--json' && a !== '--list' && a !== '--live');
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
    if (live) {
      report.evidenceLevel = 'automated tests plus explicit PTY evidence for supported surfaces';
      for (const feature of targets) {
        if (feature.liveDriver !== 'posix-pty-component') {
          report.results.push({ feature: feature.id, status: 'unavailable', success: false,
            reason: 'No real interaction driver implemented for this surface' });
          report.success = false;
          continue;
        }
        const evidence = await verifyCausyneTui({ workspace: root });
        report.results.push({
          feature: feature.id, status: evidence.status, success: evidence.success,
          surface: evidence.surface, observations: evidence.observations || [],
          exitCode: evidence.exitCode, timedOut: evidence.timedOut,
          reason: evidence.reason, limitation: evidence.limitation
        });
        report.success &&= evidence.success;
      }
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else {
    process.stdout.write(report.success ? 'Automated checks passed.\n' : 'Automated checks failed or could not run.\n');
    for (const item of report.results) {
      if (typeof item.stdout === 'string') {
        process.stdout.write(item.stdout + (item.stderr || ''));
      } else {
        process.stdout.write(item.feature + ': ' + item.status + '\n');
        if (item.reason) process.stderr.write(item.reason + '\n');
      }
    }
    if (report.error) process.stderr.write(report.error + '\n');
    process.stdout.write(live
      ? 'PTY component checks do not prove full CLI, desktop pixels, or host mouse behavior.\n'
      : 'Live PTY/desktop/browser verification is still separate.\n');
  }
  if (!report.success) process.exitCode = 1;
}
