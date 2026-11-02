import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  computeObservationStrength,
  rankObservationsByStrength
} from '../src/memory/actrRanker.js';
import {
  buildCorpusIdfMap,
  decideNearDuplicate,
  normalizeTitleForExactMatch
} from '../src/memory/nearDuplicate.js';
import {
  fitEpisodicContextToBudget,
  renderEpisodicContext
} from '../src/memory/contextBudget.js';
import {
  foldSourceContentOutline,
  foldSourceFileOutline
} from '../src/memory/symbolFolder.js';
import {
  EpisodicMemoryStore,
  compileToolObservation,
  redactPrivateAndSecrets
} from '../src/memory/episodicStore.js';
import { memoryRecall } from '../src/tools/memoryRecall.js';
import { buildToolsList } from '../src/toolsList.js';
import { decideTools } from '../src/decideTools.js';
import { resolveTool } from '../src/tools/registry.js';
import type { EpisodicObservation, EpisodicSessionSummary } from '../src/memory/episodicTypes.js';

function makeObs(overrides: Partial<EpisodicObservation> & { id: number }): EpisodicObservation {
  return {
    id: overrides.id,
    taskId: overrides.taskId ?? 'task-1',
    workspace: overrides.workspace ?? '/tmp/demo-project',
    project: overrides.project ?? 'demo-project',
    type: overrides.type ?? 'feature',
    title: overrides.title ?? `Observation #${overrides.id}`,
    subtitle: overrides.subtitle ?? 'subtitle',
    narrative: overrides.narrative ?? `Detailed narrative for observation ${overrides.id}`,
    facts: overrides.facts ?? [`Fact ${overrides.id}`],
    concepts: overrides.concepts ?? ['feature'],
    filesRead: overrides.filesRead ?? [],
    filesModified: overrides.filesModified ?? [],
    toolName: overrides.toolName ?? 'fs_write',
    createdAtEpochMs: overrides.createdAtEpochMs ?? 1_000_000,
    reinforcedAtEpochsMs: overrides.reinforcedAtEpochsMs ?? [],
    reinforcementCount: overrides.reinforcementCount ?? (overrides.reinforcedAtEpochsMs?.length ?? 0)
  };
}

test('ACT-R ranker preserves recency head and promotes reinforced older observations', () => {
  const now = 100 * 3_600_000;
  // Create 8 observations at descending timestamps
  const pool: EpisodicObservation[] = [
    makeObs({ id: 8, createdAtEpochMs: now - 1 * 3_600_000 }), // newest (head)
    makeObs({ id: 7, createdAtEpochMs: now - 2 * 3_600_000 }),
    makeObs({ id: 6, createdAtEpochMs: now - 3 * 3_600_000 }),
    makeObs({ id: 5, createdAtEpochMs: now - 4 * 3_600_000 }),
    makeObs({ id: 4, createdAtEpochMs: now - 5 * 3_600_000 }),
    makeObs({ id: 3, createdAtEpochMs: now - 6 * 3_600_000 }),
    makeObs({ id: 2, createdAtEpochMs: now - 20 * 3_600_000 }),
    // Observation #1 is the oldest (48h ago), but heavily reinforced recently
    makeObs({
      id: 1,
      createdAtEpochMs: now - 48 * 3_600_000,
      reinforcedAtEpochsMs: [
        now - 30 * 60_000,
        now - 20 * 60_000,
        now - 10 * 60_000,
        now - 5 * 60_000
      ],
      reinforcementCount: 4
    })
  ];

  const ranked = rankObservationsByStrength(pool, 4, now);
  assert.equal(ranked.length, 4);
  // ceil(4 / 4) = 1 recency head -> #8 must be first
  assert.equal(ranked[0]?.id, 8);
  // Heavily reinforced #1 must climb into the top 4 despite being the oldest
  assert.ok(ranked.some((o) => o.id === 1), 'Reinforced older observation #1 should be promoted by ACT-R');

  const baseStrength = computeObservationStrength(now - 48 * 3_600_000, [], now);
  const reinforcedStrength = computeObservationStrength(
    now - 48 * 3_600_000,
    [now - 10 * 60_000, now - 5 * 60_000],
    now
  );
  assert.ok(reinforcedStrength > baseStrength);
});

test('2-Tier Near-Duplicate Detector: Tier-0 exact title, Tier-1 TF-IDF cosine, and rare-token IDF veto', () => {
  assert.equal(
    normalizeTitleForExactMatch('  Updated src/agentLoop.ts!! \n'),
    'updated src/agentloop.ts'
  );

  const corpus = [
    { title: 'Updated database connection pool timeout', narrative: 'Adjusted connection pool timeout in db config' },
    { title: 'Added retry handler for network requests', narrative: 'Implemented exponential backoff in client' },
    { title: 'Configured strict typescript compiler flags', narrative: 'Enabled strict null checks in tsconfig' },
    { title: 'Refactored terminal layout renderer', narrative: 'Cleaned up sidebar rendering logic' }
  ];
  const idfMap = buildCorpusIdfMap(corpus);

  // Tier-0: Exact normalized title match
  const exactRes = decideNearDuplicate(
    { title: 'Updated database connection pool timeout!', narrative: 'Different body text' },
    { title: 'updated database connection pool timeout', narrative: 'Original body text' },
    idfMap,
    corpus.length
  );
  assert.equal(exactRes.tier, 'exact');

  // Tier-1: Candidate match (same semantic words without conflicting file paths)
  const candidateRes = decideNearDuplicate(
    {
      title: 'Adjusted database connection pool timeout configuration',
      narrative: 'Updated database connection pool timeout setting'
    },
    {
      title: 'Updated database connection pool timeout setting',
      narrative: 'Adjusted database connection pool timeout configuration'
    },
    idfMap,
    corpus.length
  );
  assert.equal(candidateRes.tier, 'candidate');

  // IDF Veto: High overlap in words, but distinct file paths in symmetric difference
  const vetoRes = decideNearDuplicate(
    {
      title: 'Fixed null pointer exception in src/auth/login.ts',
      narrative: 'Added guard clause for null user session in src/auth/login.ts'
    },
    {
      title: 'Fixed null pointer exception in src/billing/invoice.ts',
      narrative: 'Added guard clause for null user session in src/billing/invoice.ts'
    },
    idfMap,
    corpus.length
  );
  assert.equal(vetoRes.tier, 'distinct');
  assert.equal(vetoRes.vetoed, true);
});

test('fitEpisodicContextToBudget progressively sheds detail to fit strict character limit', () => {
  const observations: EpisodicObservation[] = Array.from({ length: 12 }, (_, idx) =>
    makeObs({
      id: idx + 1,
      title: `Implemented feature module #${idx + 1} for cross-session memory`,
      narrative: 'A'.repeat(240),
      facts: ['Fact alpha', 'Fact beta', 'Fact gamma'],
      filesModified: [`src/module${idx + 1}.ts`]
    })
  );
  const summaries: EpisodicSessionSummary[] = Array.from({ length: 4 }, (_, idx) => ({
    id: idx + 1,
    taskId: `task-${idx + 1}`,
    workspace: '/tmp/demo',
    project: 'demo',
    request: `Build subsystem ${idx + 1}`,
    investigated: `Inspected files for subsystem ${idx + 1}`,
    learned: `Learned architecture constraints for subsystem ${idx + 1}`,
    completed: `Completed implementation and tests for subsystem ${idx + 1}`,
    nextSteps: `Monitor telemetry for subsystem ${idx + 1}`,
    createdAtEpochMs: 1_700_000_000_000
  }));

  const fullIds = new Set<number>([1, 2, 3, 4, 5]);
  const unbudgeted = renderEpisodicContext({
    project: 'demo',
    observations,
    summaries,
    fullObservationIds: fullIds,
    showLastSummaryDetails: true,
    priorTrailingNote: 'Trailing note from prior run'
  });
  assert.ok(unbudgeted.length > 2000);

  const strictBudget = 900;
  const budgeted = fitEpisodicContextToBudget(
    {
      project: 'demo',
      observations,
      summaries,
      fullObservationIds: fullIds,
      showLastSummaryDetails: true,
      priorTrailingNote: 'Trailing note from prior run'
    },
    strictBudget
  );

  assert.ok(
    budgeted.length <= strictBudget,
    `Expected budgeted context (${budgeted.length} chars) to be <= ${strictBudget}`
  );
  assert.ok(budgeted.includes('# EPISODIC WORKSPACE MEMORY (demo)'));
  assert.ok(!budgeted.includes('Narrative: AAAA'), 'Expanded narratives should be shed first under tight budget');
});

test('EpisodicMemoryStore: 3-Layer Progressive Disclosure (search -> timeline -> get) + <private> redaction', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-episodic-test-'));
  const storeFile = path.join(tmpDir, 'episodic-memory.json');
  const store = new EpisodicMemoryStore(storeFile);
  const workspace = '/tmp/causyne-workspace';

  // Verify <private> and secret redaction
  const testKeyToken = ['s', 'k', '-'].join('') + '1234567890abcdefghijklmnop';
  const redacted = redactPrivateAndSecrets(
    `Saved config <private>my secret diary</private> with key ${testKeyToken}`
  );
  assert.ok(!redacted.includes('my secret diary'));
  assert.ok(redacted.includes('[REDACTED_PRIVATE]'));
  assert.ok(redacted.includes('[REDACTED_KEY]'));

  // Insert 5 distinct observations
  const obs1 = store.recordObservation({
    taskId: 't1',
    workspace,
    type: 'decision',
    title: 'Selected SQLite WAL mode for local persistence',
    narrative: 'Configured WAL journal mode to prevent locking across concurrent readers.',
    facts: ['WAL mode enabled'],
    filesModified: ['src/db.ts'],
    toolName: 'fs_edit',
    createdAtEpochMs: 1000
  });
  assert.equal(obs1.dedupTier, 'distinct');

  // Insert exact duplicate title -> should reinforce #1 instead of creating a new ID
  const obs1Dup = store.recordObservation({
    taskId: 't1',
    workspace,
    type: 'decision',
    title: 'Selected SQLite WAL mode for local persistence',
    narrative: 'Re-confirmed WAL mode configuration.',
    facts: ['Zero lock contention'],
    filesModified: ['src/db.ts'],
    toolName: 'fs_edit',
    createdAtEpochMs: 2000
  });
  assert.equal(obs1Dup.dedupTier, 'exact');
  assert.equal(obs1Dup.reinforcedId, obs1.observation.id);
  assert.equal(obs1Dup.observation.reinforcementCount, 1);

  const obs2 = store.recordObservation({
    taskId: 't1',
    workspace,
    type: 'bugfix',
    title: 'Fixed race condition in WebSocket reconnection handler',
    narrative: 'Added exponential backoff and state guard in socket client.',
    filesModified: ['src/ws.ts'],
    toolName: 'fs_edit',
    createdAtEpochMs: 3000
  });

  const obs3 = store.recordObservation({
    taskId: 't1',
    workspace,
    type: 'verification',
    title: 'Succeeded: npm test websocket suite',
    narrative: 'All 42 unit tests in websocket suite passed.',
    toolName: 'sysRun',
    createdAtEpochMs: 4000
  });

  // Layer 1: Progressive Search Index
  const searchRes = store.searchIndex({ query: 'WebSocket reconnection', workspace });
  assert.ok(searchRes.totalMatches >= 1);
  assert.equal(searchRes.results[0]?.numericId, obs2.observation.id);

  // Layer 2: Chronological Timeline Window around obs2
  const timeline = store.getTimelineWindow({
    anchorId: `#${obs2.observation.id}`,
    workspace,
    depthBefore: 2,
    depthAfter: 2
  });
  assert.equal(timeline.anchor?.numericId, obs2.observation.id);
  assert.equal(timeline.before[0]?.numericId, obs1.observation.id);
  assert.equal(timeline.after[0]?.numericId, obs3.observation.id);

  // Layer 3: Full Observation Fetch (with ACT-R retrieval reinforcement)
  const batch = store.getObservationsByIds([`#${obs1.observation.id}`, `#${obs2.observation.id}`]);
  assert.equal(batch.observations.length, 2);
  assert.equal(batch.truncatedByByteLimit, false);
  assert.ok(batch.observations[0]?.facts.includes('Zero lock contention'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('compileToolObservation filters low-signal reads and captures mutations & verifications', () => {
  const ignored = compileToolObservation({
    taskId: 't1',
    workspace: '/workspace/app',
    toolName: 'fs_list',
    args: { path: '/workspace/app' },
    result: { success: true }
  });
  assert.equal(ignored, null);

  const ignoredLs = compileToolObservation({
    taskId: 't1',
    workspace: '/workspace/app',
    toolName: 'sysRun',
    args: { command: 'ls -la' },
    result: { success: true, output: 'total 0' }
  });
  assert.equal(ignoredLs, null);

  const ignoredGrep = compileToolObservation({
    taskId: 't1',
    workspace: '/workspace/app',
    toolName: 'sysRun',
    args: { command: 'grep -n "compileToolObservation" src/memory/episodicStore.ts' },
    result: { success: true, output: '108:export function compileToolObservation' }
  });
  assert.equal(ignoredGrep, null);

  const ignoredNodeOneLiner = compileToolObservation({
    taskId: 't1',
    workspace: '/workspace/app',
    toolName: 'sysRun',
    args: { command: 'node -e "console.log(1)"' },
    result: { success: true, output: '1' }
  });
  assert.equal(ignoredNodeOneLiner, null);

  const writeObs = compileToolObservation({
    taskId: 't1',
    workspace: '/workspace/app',
    toolName: 'fs_write',
    args: { path: '/workspace/app/src/index.ts', content: 'export const x = 1;' },
    result: { success: true }
  });
  assert.ok(writeObs);
  assert.equal(writeObs.type, 'feature');
  assert.deepEqual(writeObs.filesModified, ['src/index.ts']);

  const testObs = compileToolObservation({
    taskId: 't1',
    workspace: '/workspace/app',
    toolName: 'sysRun',
    args: { command: 'npm run test' },
    result: { success: true, output: '128 passing' }
  });
  assert.ok(testObs);
  assert.equal(testObs.type, 'verification');
});

test('foldSourceContentOutline and memory_recall tool execute end-to-end', async () => {
  const sampleTs = [
    'import fs from "node:fs";',
    '',
    '/**',
    ' * Computes the Fibonacci number at position n.',
    ' */',
    'export function computeFibonacci(n: number): number {',
    '  if (n <= 1) return n;',
    '  return computeFibonacci(n - 1) + computeFibonacci(n - 2);',
    '}',
    '',
    'export interface CalculatorConfig {',
    '  readonly precision: number;',
    '}'
  ].join('\n');

  const outline = foldSourceContentOutline(sampleTs, '/tmp/math.ts');
  assert.equal(outline.language, 'typescript');
  assert.equal(outline.importCount, 1);
  assert.equal(outline.symbols.length, 2);
  assert.equal(outline.symbols[0]?.name, 'computeFibonacci');
  assert.equal(outline.symbols[0]?.lineStart, 6);
  assert.equal(outline.symbols[0]?.lineEnd, 9);
  assert.equal(outline.symbols[0]?.docComment, 'Computes the Fibonacci number at position n.');

  // Verify pipeline registration in ToolsList, decideTools, and registry
  const list = buildToolsList();
  assert.ok(list.some((entry) => entry.name === 'memory_recall'));
  const decision = decideTools({
    source: 'plan',
    list,
    text: 'Recall the earlier fix from the previous session and inspect the file symbol outline'
  });
  assert.ok(decision.tools.includes('memory_recall'));
  assert.ok(resolveTool('memory_recall'));

  // Execute memory_recall action="outline" on a real temporary file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-outline-test-'));
  const tmpFile = path.join(tmpDir, 'sample.ts');
  fs.writeFileSync(tmpFile, sampleTs, 'utf8');

  const toolRes = await memoryRecall.execute(
    { action: 'outline', filePath: tmpFile },
    { workspaceRoot: tmpDir }
  );
  assert.equal(toolRes.success, true);
  assert.ok(String(toolRes.output).includes('[6-9] export function computeFibonacci'));

  // Verify multi-line function signature extraction on real src/memory/episodicStore.ts
  const realOutlineRes = await memoryRecall.execute(
    { path: 'src/memory/episodicStore.ts' },
    { workspaceRoot: process.cwd() }
  );
  assert.equal(realOutlineRes.success, true);
  assert.equal(realOutlineRes.action, 'outline');
  assert.ok(
    String(realOutlineRes.output).includes('export function compileToolObservation'),
    'Multi-line function compileToolObservation must be included in outline'
  );
  assert.ok(
    JSON.stringify(realOutlineRes).length < 2500,
    `Expected serialized outline response (${JSON.stringify(realOutlineRes).length} chars) to stay under 2500-char spill limit`
  );

  // Verify intent-stage pre-admission in decideTools
  const intentDecision = decideTools({
    source: 'intent',
    list,
    prompt: 'Call memory_recall with action="outline" and memory_write to test episodic memory'
  });
  assert.ok(intentDecision.tools.includes('memory_recall'));
  assert.ok(intentDecision.tools.includes('memory_write'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

