import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { causyneHome } from './utils/paths.js';

// Agentic Plan Caching.
//
// THE WASTE THIS ATTACKS. The agent rediscovers the same approach from scratch
// on every task. A real run three days ago spent steps 12 through 16 learning
// that `which ffmpeg` fails on macOS and that Blender links FFmpeg internally —
// a fact it had already learned, in the same directory, hours earlier. It then
// hit the daily token ceiling before finishing. Nothing carried the procedure
// forward, so nothing could.
//
// WHAT THIS IS NOT. The Stanford APC design extracts keywords with a cheap
// model and adapts the retrieved template with a second one. Both are inference
// calls, and this agent's whole token economy is built on not adding calls to
// the hot path. So:
//
//   * Extraction is DETERMINISTIC — stopword-filtered tokens, no model.
//   * Adaptation costs NOTHING — the template is injected as prior art into the
//     per-task static block the request already carries, and the model adapts
//     it inside the step it was going to take anyway.
//   * Distillation is DETERMINISTIC — the executed tool sequence is already
//     known; asking a model to summarise what we watched happen would be
//     paying for a worse copy of a fact we hold.
//
// So the measured saving comes from steps not taken, not from a cheaper way of
// taking them. That is a narrower claim than the paper's and it is the one this
// implementation can actually support.
//
// WHAT IS STORED. Tool names, a short whitelisted action token, and whether the
// step worked. No paths, no arguments, no file contents, no command lines. A
// procedure, not a transcript.

const PLAN_DIR = path.join(causyneHome(), 'plans');
const PLAN_FILE = path.join(PLAN_DIR, 'index.json');

/** Two plans must overlap this much on keywords before one is offered for the other. */
// Tuned against the asymmetry, not for elegance. A false positive costs a few
// tokens of clearly-labelled prior art the model is told to verify. A false
// negative costs re-deriving an entire procedure — which is the failure that
// ended a real run at the daily ceiling. Archetype is already a hard gate, so
// the remaining risk is "same archetype, different task", and that is cheap.
const MATCH_THRESHOLD = 0.38;

/** Ceiling on retained templates. Pruned by usefulness, not by age alone. */
const MAX_PLANS = 200;

/** A plan longer than this is a transcript, not a procedure. */
const MAX_STEPS = 24;

/** Keywords kept per plan. Enough to discriminate, short enough to stay cheap. */
const MAX_KEYWORDS = 12;

/**
 * Words that carry no intent. Deliberately small: an aggressive list throws
 * away the domain nouns that make two tasks comparable.
 * @type {ReadonlySet<string>}
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'to', 'of', 'in', 'on', 'at',
  'is', 'are', 'be', 'was', 'were', 'do', 'does', 'did', 'can', 'could',
  'with', 'from', 'into', 'then', 'this', 'that', 'it', 'its', 'as', 'by',
  'please', 'just', 'now', 'my', 'me', 'you', 'your', 'i',
  // Generic creation verbs. Every task has one, so they inflate the union
  // without discriminating between tasks — the exact shape that made
  // "buat pena 3D di Blender" and "bikin pulpen 3D di blender" score 0.40
  // when they describe the same job. `build`, `fix`, `debug` and `render` are
  // deliberately NOT here: those DO separate tasks inside one archetype.
  'make', 'create', 'creating', 'made', 'generate',
  // Indonesian — the owner writes in both, and a mixed-language prompt must
  // key the same way whichever language framed it.
  'dan', 'atau', 'yang', 'untuk', 'dari', 'ke', 'di', 'itu', 'ini', 'dengan',
  'tolong', 'saya', 'aku', 'kamu', 'adalah', 'pada', 'juga', 'agar', 'jadi',
  'buat', 'bikin', 'membuat', 'lalu', 'kemudian', 'terus', 'dulu', 'saja',
  'sekarang', 'harus', 'bisa', 'sudah', 'belum', 'akan', 'mau', 'coba'
]);

// HONEST LIMIT. Matching is LEXICAL. A task cached in English and re-asked in
// Indonesian (or the reverse) will miss, because Jaccard cannot know that
// "pen" and "pena" are the same object. That is a deliberate trade: this path
// is deterministic, instant, and works on a machine with no embedding model
// provisioned. Cortex is the semantic route and already carries embeddings;
// these two compose rather than compete.

/**
 * One executed step, reduced to what is reusable.
 *
 * Shaped as (action, parameter, outcome, outcome-reason) — the
 * `(observation, action, outcome)` tuple the agent-memory literature uses,
 * minus the observation itself. The observation is where paths, file contents
 * and command lines live, and none of that is procedure.
 *
 * @typedef {Object} PlanStep
 * @property {string}  tool  Registered tool name.
 * @property {string}  note  Short whitelisted action token, or ''.
 * @property {boolean} ok    Whether the step succeeded.
 * @property {string}  [why] Failure CLASS when ok is false. A closed vocabulary,
 *                           never the error text.
 */

/**
 * @typedef {Object} PlanTemplate
 * @property {string}     id
 * @property {string}     archetype   Task archetype this plan belongs to.
 * @property {string[]}   keywords
 * @property {PlanStep[]} steps
 * @property {number}     uses        Times offered.
 * @property {number}     wins        Times the task it was offered to succeeded.
 * @property {number}     createdAt
 * @property {number}     updatedAt
 */

/**
 * @typedef {Object} PlanMatch
 * @property {PlanTemplate} template
 * @property {number}       similarity
 */

function ensureDir() {
  if (!fs.existsSync(PLAN_DIR)) fs.mkdirSync(PLAN_DIR, { recursive: true, mode: 0o700 });
}

/**
 * @returns {PlanTemplate[]}
 */
function readAll() {
  try {
    if (!fs.existsSync(PLAN_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return []; // a corrupt cache degrades to a cold one, never to a failed task
  }
}

/**
 * @param {PlanTemplate[]} plans
 * @returns {boolean}
 */
function writeAll(plans) {
  try {
    ensureDir();
    const temp = `${PLAN_FILE}.tmp_${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(plans, null, 2), { mode: 0o600 });
    fs.renameSync(temp, PLAN_FILE); // atomic: a torn write would erase the cache
    return true;
  } catch (e) {
    return false; // losing the cache must never fail the task
  }
}

/**
 * Intent keywords, computed without a model.
 *
 * @param   {string} text
 * @returns {string[]} unique, lowercase, order not significant
 */
export function extractKeywords(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && w.length <= 24 && !STOPWORDS.has(w) && !/^\d+$/.test(w));

  return [...new Set(words)].slice(0, MAX_KEYWORDS);
}

/**
 * Jaccard overlap. Symmetric, bounded 0..1, and cheap enough to run against
 * every stored plan without anyone noticing.
 *
 * @param   {string[]} a
 * @param   {string[]} b
 * @returns {number}
 */
export function similarity(a, b) {
  const left = new Set(a || []);
  const right = new Set(b || []);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

/**
 * Reduce a tool call to a reusable step.
 *
 * Only a whitelist of argument keys is read, and only a short slug of the value
 * survives. An argument is where paths, prompts and command lines live; none of
 * that is procedure and none of it belongs in a shared cache.
 *
 * @param   {string} tool
 * @param   {Record<string, any>} args
 * @param   {boolean} ok
 * @returns {PlanStep}
 */
export function toStep(tool, args, ok, result) {
  const SAFE_KEYS = ['action', 'verb', 'mode', 'operation', 'kind', 'type'];
  let note = '';

  for (const key of SAFE_KEYS) {
    const value = args && args[key];
    if (typeof value === 'string' && value) {
      note = value.toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 32);
      if (note) break;
    }
  }

  /** @type {PlanStep} */
  const step = { tool: String(tool || '').slice(0, 64), note, ok: Boolean(ok) };
  if (!step.ok) {
    const why = failureClass(result);
    if (why) step.why = why;
  }
  return step;
}

/**
 * Why a step failed, as a CLASS rather than as a message.
 *
 * `ok: false` alone says a route did not work; it does not say whether the
 * route was wrong or the moment was. "The command is not on PATH" and "the
 * network was down" call for opposite responses, and a cached plan that cannot
 * tell them apart teaches the wrong lesson half the time.
 *
 * The error TEXT is never stored — it carries paths, hostnames, keys and user
 * content. Only a token from this closed list survives, so the vocabulary is
 * auditable by reading this function.
 *
 * @param   {any} result
 * @returns {string} one of the classes below, or '' when nothing matched
 */
export function failureClass(result) {
  if (!result) return '';
  const text = [result.error, result.message, result.stderr, result.reason]
    .filter((v) => typeof v === 'string')
    .join(' ')
    .toLowerCase()
    .slice(0, 500);
  if (!text) return typeof result.exitCode === 'number' && result.exitCode !== 0 ? 'exit_nonzero' : '';

  if (/not found|no such file|enoent|command not found|cannot find/.test(text)) return 'not_found';
  if (/permission|denied|eacces|eperm|unauthor|forbidden/.test(text)) return 'permission';
  if (/timed? ?out|etimedout|deadline/.test(text)) return 'timeout';
  if (/econnrefused|enotfound|network|dns|socket|offline/.test(text)) return 'network';
  if (/rate limit|429|quota|budget/.test(text)) return 'rate_limited';
  if (/invalid|malformed|schema|required (property|field)|bad request|400/.test(text)) return 'invalid_args';
  if (/syntax ?error|parse error|unexpected token/.test(text)) return 'syntax';
  if (/exit code|non-?zero|exited with/.test(text)) return 'exit_nonzero';
  return 'failed';
}

/**
 * The best stored plan for this request, if one is close enough.
 *
 * @param   {{prompt: string, archetype?: string}} query
 * @returns {PlanMatch|null}
 */
export function lookupPlan(query) {
  const keywords = extractKeywords(query?.prompt);
  if (keywords.length === 0) return null;

  const archetype = String(query?.archetype || '');
  let best = null;

  for (const template of readAll()) {
    // Archetype is a hard gate, not a score. A "build a 3D scene" plan sharing
    // three words with "debug the build" is not a plan for it.
    if (archetype && template.archetype && template.archetype !== archetype) continue;

    const score = similarity(keywords, template.keywords);
    if (score < MATCH_THRESHOLD) continue;

    // Ties break on demonstrated usefulness, so a plan that has actually worked
    // outranks one that merely matched before.
    const winRate = template.uses > 0 ? template.wins / template.uses : 0;
    const ranked = score + winRate * 0.1;
    if (!best || ranked > best.ranked) best = { template, similarity: score, ranked };
  }

  if (!best) return null;
  return { template: best.template, similarity: best.similarity };
}

/**
 * Store or reinforce the procedure a task actually followed.
 *
 * @param   {{prompt: string, archetype?: string, steps: PlanStep[]}} outcome
 * @returns {PlanTemplate|null} the stored template, or null when there was nothing worth storing
 */
export function recordPlan(outcome) {
  const steps = Array.isArray(outcome?.steps) ? outcome.steps.slice(0, MAX_STEPS) : [];
  // A one-step task teaches nothing a fresh model would not do anyway.
  if (steps.length < 2) return null;

  const keywords = extractKeywords(outcome?.prompt);
  if (keywords.length === 0) return null;

  const plans = readAll();
  const archetype = String(outcome?.archetype || '');

  const existing = plans.find(
    (t) => t.archetype === archetype && similarity(keywords, t.keywords) >= 0.8
  );

  if (existing) {
    existing.steps = steps;              // the newest working route wins
    existing.uses += 1;
    existing.wins += 1;
    existing.updatedAt = Date.now();
    writeAll(prune(plans));
    return existing;
  }

  /** @type {PlanTemplate} */
  const template = {
    id: `p_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
    archetype,
    keywords,
    steps,
    uses: 1,
    wins: 1,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  plans.push(template);
  writeAll(prune(plans));
  return template;
}

/**
 * Record that an offered plan did NOT lead anywhere, so a bad template loses
 * its rank instead of being offered forever.
 *
 * @param   {string} id
 * @returns {boolean}
 */
export function recordMiss(id) {
  const plans = readAll();
  const template = plans.find((t) => t.id === id);
  if (!template) return false;
  template.uses += 1;
  template.updatedAt = Date.now();
  return writeAll(plans);
}

/**
 * Keep the cache bounded by usefulness rather than by age alone: a plan used
 * ten times last month is worth more than one stored yesterday and never hit.
 *
 * @param   {PlanTemplate[]} plans
 * @returns {PlanTemplate[]}
 */
export function prune(plans) {
  if (plans.length <= MAX_PLANS) return plans;
  const now = Date.now();
  const MONTH = 30 * 24 * 60 * 60 * 1000;

  return [...plans]
    .sort((a, b) => {
      const value = (t) =>
        (t.uses > 0 ? t.wins / t.uses : 0) * Math.pow(2, -(now - t.updatedAt) / MONTH) * Math.log2(1 + t.uses);
      return value(b) - value(a);
    })
    .slice(0, MAX_PLANS);
}

/**
 * The prompt fragment offered to the model on a hit.
 *
 * Phrased as PRIOR ART, never as an instruction. A cached plan is evidence
 * about what worked before, not a script — the workspace may have changed, and
 * a model told to follow a stale plan will follow it off a cliff. Failed steps
 * are included on purpose: knowing which route was a dead end is most of the
 * saving.
 *
 * @param   {PlanMatch|null} match
 * @returns {string} '' when there is no usable match
 */
export function renderPlanHint(match) {
  if (!match || !match.template || !Array.isArray(match.template.steps)) return '';
  const { template, similarity: score } = match;
  if (template.steps.length === 0) return '';

  const lines = [
    '# PRIOR ART — a similar task on this machine went like this',
    `(match ${(score * 100).toFixed(0)}%, worked ${template.wins} of ${template.uses} time(s). `
      + 'Evidence, not instructions. Verify before reusing; the workspace may have moved on.)'
  ];

  template.steps.forEach((step, index) => {
    const label = step.note ? `${step.tool} → ${step.note}` : step.tool;
    // The failure CLASS, not just the fact of failure. "not_found" invites a
    // different response from "network": one means the route is wrong, the
    // other means the moment was.
    const failed = step.ok
      ? ''
      : `   ← FAILED last time (${step.why || 'failed'}); do not repeat blindly`;
    lines.push(`${index + 1}. ${label}${failed}`);
  });

  const failureWarnings = template.steps
    .map((step, idx) => ({ step, idx: idx + 1 }))
    .filter(({ step }) => !step.ok);

  if (failureWarnings.length > 0) {
    lines.push('');
    lines.push('⚠️ FAILURE ROUTE WARNINGS (learned from previous attempts — plan alternatives):');
    failureWarnings.forEach(({ step, idx }) => {
      lines.push(`- Step ${idx} (${step.tool}${step.note ? ' → ' + step.note : ''}) FAILED with reason: ${step.why || 'failed'}. Consider an alternative approach.`);
    });
  }

  return lines.join('\n');
}

/** @returns {{count: number, file: string}} */
export function planStats() {
  return { count: readAll().length, file: PLAN_FILE };
}

/**
 * Remove every stored plan. Used by `/cortex --forget` style operations and by
 * tests; never called automatically.
 * @returns {number} how many were removed
 */
export function forgetPlans() {
  const count = readAll().length;
  writeAll([]);
  return count;
}

export { PLAN_FILE, PLAN_DIR, MATCH_THRESHOLD, MAX_PLANS };
