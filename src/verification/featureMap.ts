export interface FeatureDefinition {
  surface: string;
  entry: string;
  action: string;
  assertion: string;
  automated: readonly string[];
  liveDriver?: string;
  liveRequired: string;
}

export type SelectedFeature = FeatureDefinition & { id: string };

export const FEATURE_MAP: Readonly<Record<string, FeatureDefinition>> = Object.freeze({
  'tui-usage': {
    surface: 'terminal',
    entry: '/usage and /status',
    action: 'Open the panel, submit a message, switch busy state, close with Escape',
    assertion: 'The panel stays visible until explicitly dismissed',
    automated: ['tests/tuiPinnedUsageStatus.test.ts', 'tests/usageCard.test.ts'],
    liveDriver: 'posix-pty-chat',
    liveRequired: 'Drive ChatPrompt, StageSurface, and chatMode in isolated PTYs; packaged launcher and host mouse pixels remain separate'
  },
  'tui-turn-rail': {
    surface: 'terminal',
    entry: 'Left conversation navigation rail',
    action: 'Hover grouped dots, choose a turn, scroll its timeline preview',
    assertion: 'The selected turn opens without scrolling terminal scrollback',
    automated: ['tests/tuiTurnTimelineVideoParity.test.ts', 'tests/tuiTurnTimelineWheel.test.ts'],
    liveRequired: 'Inspect pointer movement, popup geometry and wheel handling in a real terminal'
  },
  'agent-loop': {
    surface: 'agent',
    entry: 'Submit a task with tool calls and retry conditions',
    action: 'Execute, interrupt, resume, and inspect evidence-gated completion',
    assertion: 'No fabricated completion or unhandled failed tool response',
    automated: ['tests/agentLoopFixes.test.ts', 'tests/agentLoopHookSeams.test.js'],
    liveRequired: 'Run a real task in the selected workspace with explicitly permitted tools'
  },
  'web-preview': {
    surface: 'browser',
    entry: 'browser_act preview, snapshot and screenshot',
    action: 'Open the built page and inspect the DOM and rendered pixels',
    assertion: 'The page is reachable and its actual visual state matches the request',
    automated: ['tests/webVerificationState.test.ts'],
    liveRequired: 'Use the Causyne Browser to capture a fresh screenshot after the latest edit'
  },
  'plugin-safety': {
    surface: 'plugin',
    entry: 'Enabled plugin skills via the plugin manager',
    action: 'Read a permitted skill and reject an unapproved or invalid plugin',
    assertion: 'Digest-pinned plugin permissions remain mandatory',
    automated: ['tests/plugins.test.js', 'tests/skillsReliability.test.js'],
    liveRequired: 'Check a separately approved plugin against the current permission record'
  },
  'terminal-pty': {
    surface: 'terminal',
    entry: 'An explicitly selected interactive program and input sequence',
    action: 'Launch the real program in a pseudo-terminal and capture exit, input and output evidence',
    assertion: 'A PTY pass requires observed terminal output and the expected process exit',
    automated: ['tests/verificationPtyProbe.test.ts'],
    liveRequired: 'The smoke fixture only tests the PTY driver; user-app behavior needs a separate real app session'
  },
  'ui-properties': {
    surface: 'terminal',
    entry: 'Seeded UI interaction and runtime state handlers',
    action: 'Generate bounded action sequences, shrink counterexamples and replay real prompt transitions',
    assertion: 'Panels persist until explicit close; counterexamples retain their original failure identity',
    automated: ['tests/verificationPropertyProbe.test.ts'],
    liveRequired: 'Seeded handler checks do not establish terminal rendering or cross-process races'
  },
  'formal-state': {
    surface: 'model',
    entry: 'verification/formal-verification',
    action: 'Explore bounded state transitions and inject a deliberately broken variant',
    assertion: 'Counterexamples are reproducible and a bounded pass is not claimed as a proof',
    automated: ['tests/boundedExplorer.test.ts', 'tests/cliProbe.test.ts'],
    liveRequired: 'For unbounded guarantees, run a real external model checker or proof assistant'
  }
});

export function selectFeatures(names: readonly unknown[]): SelectedFeature[] {
  if (!Array.isArray(names) || names.length === 0) throw new Error('At least one feature is required');
  const selected = [...new Set(names)];
  for (const name of selected) {
    if (typeof name !== 'string' || !Object.hasOwn(FEATURE_MAP, name)) {
      throw new Error('Unknown feature: ' + String(name));
    }
  }
  return selected.map(name => ({ id: name as string, ...(FEATURE_MAP[name as string]!) }));
}
