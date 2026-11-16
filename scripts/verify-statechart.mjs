import { buildBoundedStatechart } from '../src/verification/statechart.js';

const flags = new Set(process.argv.slice(2));
const valid = new Set(['--json', '--broken']);
if ([...flags].some(flag => !valid.has(flag))) {
  process.stderr.write('Usage: npm run verify:statechart -- [--json] [--broken]\n');
  process.exitCode = 2;
} else {
  const broken = flags.has('--broken');
  const report = buildBoundedStatechart({
    initial: { panel: 'none', busy: false, interrupted: false },
    actions: ['open-usage', 'open-status', 'submit', 'begin', 'finish', 'escape'],
    transition: (state, event) => {
      const next = { ...state };
      if (event === 'open-usage') next.panel = 'usage';
      if (event === 'open-status') next.panel = 'status';
      if (event === 'begin') next.busy = true;
      if (event === 'finish') next.busy = false;
      if (event === 'escape') {
        if (next.panel !== 'none') {
          next.panel = 'none';
          if (broken) next.interrupted = true;
        } else if (next.busy) next.interrupted = true;
      }
      next.event = event;
      next.previousPanel = state.panel;
      next.previousInterrupted = state.interrupted;
      return next;
    },
    invariant: state => {
      if (['submit', 'begin', 'finish'].includes(state.event)
          && state.panel !== state.previousPanel) return 'pinned panel unexpectedly changed';
      if (state.event === 'escape' && state.previousPanel !== 'none'
          && state.interrupted !== state.previousInterrupted) return 'escape interrupted through open panel';
      return true;
    },
    maxDepth: 6, maxStates: 256,
    stateLabel: s => s.panel + ' panel, ' + (s.busy ? 'running' : 'idle')
      + ', interrupt=' + s.interrupted + ', event=' + (s.event || 'init')
  });
  if (flags.has('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(report.diagram);
    process.stderr.write(report.status + ': ' + report.stateCount + ' states, '
      + report.transitionCount + ' transitions; ' + report.evidence + '\n');
    if (report.counterexamples.length) {
      process.stderr.write(JSON.stringify(report.counterexamples) + '\n');
    }
  }
  if (broken ? report.status !== 'counterexample' : report.status !== 'bounded-pass') {
    process.exitCode = 1;
  }
}
