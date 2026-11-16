import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatPrompt } from '../src/tui/prompt.js';
import { handlePromptEscape } from '../src/tui/composerControls.js';
import { exploreStateMachine } from '../src/verification/boundedExplorer.js';

const initial = { panel: 'usage', busy: false, queue: 0, action: 'init', previousPanel: 'usage' };
const actions = ['submit', 'begin', 'finish', 'escape'];

function realTransition(state, action, corrupt = false) {
  const prompt = {
    usageCard: state.panel === 'usage' ? { id: 'usage' } : null,
    usageCardLoading: false,
    statusCard: null,
    busy: state.busy,
    queue: Array.from({ length: state.queue }, () => 'queued'),
    waiter: () => {},
    editor: {
      isEmpty: false, getText: () => 'run checks', clear() {}
    },
    history: { add() {} },
    completion: null,
    isCommand: () => false,
    erase() {},
    refreshCompletion() {},
    scheduleDraw() {},
    draw() {},
    startTick() {},
    stopTick() {},
    refreshUsageCard: async () => false,
    restoreUnconsumedAttachments() {},
    takeSubmissionAttachments: () => [],
    renderSubmittedUserMessage() {},
    enqueueSubmission(value) { this.queue.push(value); },
    closeUsageCard() { this.usageCard = null; return true; },
    commit() {},
    onInterrupt() {}
  };
  if (action === 'submit') {
    ChatPrompt.prototype.submit.call(prompt);
    if (corrupt) prompt.usageCard = null;
  } else if (action === 'begin') {
    ChatPrompt.prototype.setBusy.call(prompt, true);
  } else if (action === 'finish') {
    ChatPrompt.prototype.setBusy.call(prompt, false);
  } else if (action === 'escape') {
    handlePromptEscape(prompt, () => ['interrupted']);
  }
  return {
    panel: prompt.usageCard ? 'usage' : 'none',
    busy: prompt.busy,
    queue: prompt.queue.length,
    action,
    previousPanel: state.panel
  };
}

const invariant = state => {
  if (['submit', 'begin', 'finish'].includes(state.action) && state.previousPanel !== state.panel) {
    return 'Agent work silently dismissed the usage panel';
  }
  if (state.action === 'escape' && state.previousPanel === 'usage' && state.panel !== 'none') {
    return 'Escape did not close the visible usage panel';
  }
  return true;
};

test('bounded sequences exercise actual production submit, busy, and Escape handlers', () => {
  const report = exploreStateMachine({
    initial, actions, transition: realTransition, invariant,
    maxDepth: 6, maxStates: 2000
  });
  assert.equal(report.status, 'bounded-pass', JSON.stringify(report));
  assert.ok(report.transitionsExplored > 10);
});

test('negative control proves a one-line reintroduction of the dismissal is caught', () => {
  const result = exploreStateMachine({
    initial, actions, transition: (state, action) => realTransition(state, action, true),
    invariant, maxDepth: 6
  });
  assert.equal(result.status, 'counterexample');
  assert.deepEqual(result.trace, ['submit']);
  assert.match(result.reason, /silently dismissed/);
});
