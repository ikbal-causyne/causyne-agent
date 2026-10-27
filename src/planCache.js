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
const METRICS_FILE = path.join(PLAN_DIR, 'metrics.json');
/** Two plans must overlap this much on keywords before one is offered for the other. */
// Tuned against the asymmetry, not for elegance. A false positive costs a few
// tokens of clearly-labelled prior art the model is told to verify. A false
// negative costs re-deriving an entire procedure — which is the failure that
// ended a real run at the daily ceiling. Archetype is already a hard gate, so
// the remaining risk is "same archetype, different task", and that is cheap.
const MATCH_THRESHOLD = 0.38;
/** Default high-confidence fuzzy threshold matching Table 6 in Stanford APC paper (80% similarity). */
const DEFAULT_FUZZY_THRESHOLD = 0.80;
/** Ceiling on retained templates. Evaluated across 10, 20, 50, 100 in APC Table 4 (diminishing returns plateau at ~100). */
const DEFAULT_CAPACITY = 100;
const MAX_PLANS = 200;
/** A plan longer than this is a transcript, not a procedure. */
const MAX_STEPS = 24;
/** Keywords kept per plan. Enough to discriminate, short enough to stay cheap. */
const MAX_KEYWORDS = 12;
/** Exact keyword-set hits stay O(1); fuzzy matching is a bounded fallback. */
const RECENT_LOOKUP_WINDOW = 32;
const MIN_LOOKUPS_BEFORE_DISABLE = 20;
const MIN_PLANS_BEFORE_DISABLE = 10;
const MIN_HEALTHY_HIT_RATE = 0.10;
const DISABLE_COOLDOWN_MS = 5 * 60 * 1000;
const SEED_FAILURE_CLASSES = new Set([
    'not_found', 'permission', 'timeout', 'network', 'rate_limited',
    'invalid_args', 'syntax', 'exit_nonzero', 'failed'
]);
const METRICS_FLUSH_INTERVAL = 10;
let plansCache = null;
let plansMtimeMs = -1;
let exactIndex = new Map();
let metricsCache = null;
let dirtyMetricEvents = 0;
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
    // without discriminating between tasks. `build`, `fix`, `debug` and `render` are
    // deliberately NOT here: those DO separate tasks inside one archetype.
    'make', 'create', 'creating', 'made', 'generate'
]);
// HONEST LIMIT. Matching is LEXICAL.
// This path is deterministic, instant, and works on a machine with no embedding model
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
 * @property {'exact'|'fuzzy'} matchType
 * @property {{keywordCount: number, lookupMs: number}} telemetry
 */
function ensureDir() {
    if (!fs.existsSync(PLAN_DIR))
        fs.mkdirSync(PLAN_DIR, { recursive: true, mode: 0o700 });
}
/** @returns {string} */
function planSignature(archetype, keywords) {
    return `${String(archetype || '')}\u0000${[...new Set(keywords || [])].sort().join('\u0001')}`;
}
function rebuildIndex(plans) {
    exactIndex = new Map();
    for (const template of plans) {
        const signature = planSignature(template.archetype, template.keywords);
        const current = exactIndex.get(signature);
        if (!current || (template.wins || 0) > (current.wins || 0)) {
            exactIndex.set(signature, template);
        }
    }
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isPlanStep(value) {
    if (!isRecord(value))
        return false;
    return typeof value.tool === 'string'
        && typeof value.note === 'string'
        && typeof value.ok === 'boolean'
        && (value.why === undefined
            || (typeof value.why === 'string' && SEED_FAILURE_CLASSES.has(value.why)));
}
function isPlanTemplate(value) {
    if (!isRecord(value))
        return false;
    return typeof value.id === 'string'
        && typeof value.archetype === 'string'
        && Array.isArray(value.keywords)
        && value.keywords.every((keyword) => typeof keyword === 'string')
        && Array.isArray(value.steps)
        && value.steps.every(isPlanStep)
        && typeof value.uses === 'number'
        && Number.isFinite(value.uses)
        && typeof value.wins === 'number'
        && Number.isFinite(value.wins)
        && typeof value.createdAt === 'number'
        && Number.isFinite(value.createdAt)
        && typeof value.updatedAt === 'number'
        && Number.isFinite(value.updatedAt);
}
function readAll() {
    try {
        if (!fs.existsSync(PLAN_FILE)) {
            plansCache = [];
            plansMtimeMs = -1;
            rebuildIndex(plansCache);
            return plansCache;
        }
        const mtimeMs = fs.statSync(PLAN_FILE).mtimeMs;
        if (plansCache && mtimeMs === plansMtimeMs)
            return plansCache;
        const parsed = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
        plansCache = Array.isArray(parsed) ? parsed.filter(isPlanTemplate) : [];
        plansMtimeMs = mtimeMs;
        rebuildIndex(plansCache);
        return plansCache;
    }
    catch (e) {
        plansCache = [];
        plansMtimeMs = -1;
        rebuildIndex(plansCache);
        return plansCache; // a corrupt cache degrades to a cold one, never to a failed task
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
        plansCache = plans;
        plansMtimeMs = fs.statSync(PLAN_FILE).mtimeMs;
        rebuildIndex(plans);
        return true;
    }
    catch (e) {
        return false; // losing the cache must never fail the task
    }
}
function defaultPipelineMetrics() {
    return {
        totalPlanMs: 0,
        totalActMs: 0,
        totalKeywordExtractionMs: 0,
        totalCacheLookupMs: 0,
        totalCacheGenerationMs: 0,
        totalTaskWallClockMs: 0,
        taskCount: 0
    };
}
function defaultCostMetrics() {
    return {
        totalLargePlannerCost: 0,
        totalSmallPlannerCost: 0,
        totalActorCost: 0,
        totalKeywordExtractionCost: 0,
        totalCacheGenerationCost: 0,
        totalCost: 0
    };
}
function defaultMetrics() {
    return {
        version: 2,
        lookups: 0,
        hits: 0,
        exactHits: 0,
        fuzzyHits: 0,
        misses: 0,
        bypassed: 0,
        records: 0,
        totalLookupMs: 0,
        maxLookupMs: 0,
        totalRecordMs: 0,
        recent: [],
        disabledUntil: 0,
        lastLookupAt: 0,
        lastRecordAt: 0,
        apcPipeline: defaultPipelineMetrics(),
        apcCost: defaultCostMetrics(),
        exactLookupTimesUs: [],
        fuzzyLookupTimesUs: []
    };
}
const METRIC_NUMBER_FIELDS = [
    'lookups', 'hits', 'exactHits', 'fuzzyHits', 'misses', 'bypassed', 'records',
    'totalLookupMs', 'maxLookupMs', 'totalRecordMs', 'disabledUntil',
    'lastLookupAt', 'lastRecordAt'
];
function normalizeMetrics(value) {
    const metrics = defaultMetrics();
    if (!isRecord(value))
        return metrics;
    for (const key of METRIC_NUMBER_FIELDS) {
        const candidate = value[key];
        if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
            metrics[key] = candidate;
        }
    }
    if (Array.isArray(value.recent)) {
        metrics.recent = value.recent
            .filter((entry) => entry === 0 || entry === 1)
            .slice(-RECENT_LOOKUP_WINDOW);
    }
    if (isRecord(value.apcPipeline)) {
        const pipeline = value.apcPipeline;
        metrics.apcPipeline = {
            totalPlanMs: typeof pipeline.totalPlanMs === 'number' && Number.isFinite(pipeline.totalPlanMs) ? pipeline.totalPlanMs : 0,
            totalActMs: typeof pipeline.totalActMs === 'number' && Number.isFinite(pipeline.totalActMs) ? pipeline.totalActMs : 0,
            totalKeywordExtractionMs: typeof pipeline.totalKeywordExtractionMs === 'number' && Number.isFinite(pipeline.totalKeywordExtractionMs) ? pipeline.totalKeywordExtractionMs : 0,
            totalCacheLookupMs: typeof pipeline.totalCacheLookupMs === 'number' && Number.isFinite(pipeline.totalCacheLookupMs) ? pipeline.totalCacheLookupMs : 0,
            totalCacheGenerationMs: typeof pipeline.totalCacheGenerationMs === 'number' && Number.isFinite(pipeline.totalCacheGenerationMs) ? pipeline.totalCacheGenerationMs : 0,
            totalTaskWallClockMs: typeof pipeline.totalTaskWallClockMs === 'number' && Number.isFinite(pipeline.totalTaskWallClockMs) ? pipeline.totalTaskWallClockMs : 0,
            taskCount: typeof pipeline.taskCount === 'number' && Number.isFinite(pipeline.taskCount) ? pipeline.taskCount : 0
        };
    }
    if (isRecord(value.apcCost)) {
        const cost = value.apcCost;
        metrics.apcCost = {
            totalLargePlannerCost: typeof cost.totalLargePlannerCost === 'number' && Number.isFinite(cost.totalLargePlannerCost) ? cost.totalLargePlannerCost : 0,
            totalSmallPlannerCost: typeof cost.totalSmallPlannerCost === 'number' && Number.isFinite(cost.totalSmallPlannerCost) ? cost.totalSmallPlannerCost : 0,
            totalActorCost: typeof cost.totalActorCost === 'number' && Number.isFinite(cost.totalActorCost) ? cost.totalActorCost : 0,
            totalKeywordExtractionCost: typeof cost.totalKeywordExtractionCost === 'number' && Number.isFinite(cost.totalKeywordExtractionCost) ? cost.totalKeywordExtractionCost : 0,
            totalCacheGenerationCost: typeof cost.totalCacheGenerationCost === 'number' && Number.isFinite(cost.totalCacheGenerationCost) ? cost.totalCacheGenerationCost : 0,
            totalCost: typeof cost.totalCost === 'number' && Number.isFinite(cost.totalCost) ? cost.totalCost : 0
        };
    }
    if (Array.isArray(value.exactLookupTimesUs)) {
        metrics.exactLookupTimesUs = value.exactLookupTimesUs
            .filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
            .slice(-100);
    }
    if (Array.isArray(value.fuzzyLookupTimesUs)) {
        metrics.fuzzyLookupTimesUs = value.fuzzyLookupTimesUs
            .filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
            .slice(-100);
    }
    return metrics;
}
function readMetrics() {
    if (metricsCache)
        return metricsCache;
    try {
        if (!fs.existsSync(METRICS_FILE)) {
            metricsCache = defaultMetrics();
            return metricsCache;
        }
        const parsed = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));
        metricsCache = normalizeMetrics(parsed);
    }
    catch (e) {
        metricsCache = defaultMetrics();
    }
    return metricsCache;
}
function writeMetrics(force = false) {
    if (!metricsCache || (!force && dirtyMetricEvents < METRICS_FLUSH_INTERVAL))
        return false;
    try {
        ensureDir();
        const temp = `${METRICS_FILE}.tmp_${process.pid}`;
        fs.writeFileSync(temp, JSON.stringify(metricsCache, null, 2), { mode: 0o600 });
        fs.renameSync(temp, METRICS_FILE);
        dirtyMetricEvents = 0;
        return true;
    }
    catch (e) {
        return false;
    }
}
function recentHitRate(metrics) {
    if (!metrics.recent.length)
        return 0;
    return metrics.recent.reduce((sum, value) => sum + value, 0) / metrics.recent.length;
}
function shouldTemporarilyDisable(metrics, planCount, now) {
    if (metrics.disabledUntil > now)
        return true;
    if (metrics.disabledUntil > 0 && metrics.disabledUntil <= now) {
        metrics.disabledUntil = 0;
        metrics.recent = [];
    }
    if (planCount < MIN_PLANS_BEFORE_DISABLE || metrics.recent.length < MIN_LOOKUPS_BEFORE_DISABLE) {
        return false;
    }
    if (recentHitRate(metrics) >= MIN_HEALTHY_HIT_RATE)
        return false;
    metrics.disabledUntil = now + DISABLE_COOLDOWN_MS;
    writeMetrics(true);
    return true;
}
function recordLookupTelemetry({ hit, matchType = null, durationMs, bypassed = false }) {
    const metrics = readMetrics();
    const now = Date.now();
    metrics.lastLookupAt = now;
    if (bypassed) {
        metrics.bypassed += 1;
    }
    else {
        metrics.lookups += 1;
        metrics.totalLookupMs += durationMs;
        metrics.maxLookupMs = Math.max(metrics.maxLookupMs, durationMs);
        metrics.recent.push(hit ? 1 : 0);
        if (metrics.recent.length > RECENT_LOOKUP_WINDOW)
            metrics.recent.shift();
        const durationUs = Math.max(1, Math.round(durationMs * 1000));
        if (hit) {
            metrics.hits += 1;
            if (matchType === 'exact') {
                metrics.exactHits += 1;
                metrics.exactLookupTimesUs.push(durationUs);
                if (metrics.exactLookupTimesUs.length > 100)
                    metrics.exactLookupTimesUs.shift();
            }
            if (matchType === 'fuzzy') {
                metrics.fuzzyHits += 1;
                metrics.fuzzyLookupTimesUs.push(durationUs);
                if (metrics.fuzzyLookupTimesUs.length > 100)
                    metrics.fuzzyLookupTimesUs.shift();
            }
        }
        else {
            metrics.misses += 1;
            metrics.exactLookupTimesUs.push(durationUs);
            if (metrics.exactLookupTimesUs.length > 100)
                metrics.exactLookupTimesUs.shift();
        }
    }
    dirtyMetricEvents += 1;
    writeMetrics(false);
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
    if (left.size === 0 || right.size === 0)
        return 0;
    let shared = 0;
    for (const word of left)
        if (right.has(word))
            shared++;
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
        const value = isRecord(args) ? args[key] : undefined;
        if (typeof value === 'string' && value) {
            note = value.toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 32);
            if (note)
                break;
        }
    }
    const step = { tool: String(tool || '').slice(0, 64), note, ok: Boolean(ok) };
    if (!step.ok) {
        const why = failureClass(result);
        if (why)
            step.why = why;
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
    if (!result)
        return '';
    const source = isRecord(result) ? result : {};
    const text = [source.error, source.message, source.stderr, source.reason]
        .filter((v) => typeof v === 'string')
        .join(' ')
        .toLowerCase()
        .slice(0, 500);
    if (!text)
        return typeof source.exitCode === 'number' && source.exitCode !== 0 ? 'exit_nonzero' : '';
    if (/not found|no such file|enoent|command not found|cannot find/.test(text))
        return 'not_found';
    if (/permission|denied|eacces|eperm|unauthor|forbidden/.test(text))
        return 'permission';
    if (/timed? ?out|etimedout|deadline/.test(text))
        return 'timeout';
    if (/econnrefused|enotfound|network|dns|socket|offline/.test(text))
        return 'network';
    if (/rate limit|429|quota|budget/.test(text))
        return 'rate_limited';
    if (/invalid|malformed|schema|required (property|field)|bad request|400/.test(text))
        return 'invalid_args';
    if (/syntax ?error|parse error|unexpected token/.test(text))
        return 'syntax';
    if (/exit code|non-?zero|exited with/.test(text))
        return 'exit_nonzero';
    return 'failed';
}
/**
 * The best stored plan for this request, if one is close enough.
 *
 * @param   {{prompt: string, archetype?: string, allowFuzzy?: boolean}} query
 * @returns {PlanMatch|null}
 */
export function lookupPlan(query) {
    const startedAt = performance.now();
    const keywords = extractKeywords(query?.prompt);
    if (keywords.length === 0) {
        recordLookupTelemetry({ hit: false, durationMs: performance.now() - startedAt });
        return null;
    }
    const archetype = String(query?.archetype || '');
    const plans = readAll();
    const now = Date.now();
    if (shouldTemporarilyDisable(readMetrics(), plans.length, now)) {
        recordLookupTelemetry({ hit: false, durationMs: performance.now() - startedAt, bypassed: true });
        return null;
    }
    // Tier 1: Exact signature matching (O(1) hash index, Table 5 in APC paper)
    const exact = exactIndex.get(planSignature(archetype, keywords));
    if (exact) {
        const durationMs = performance.now() - startedAt;
        recordLookupTelemetry({ hit: true, matchType: 'exact', durationMs });
        return {
            template: exact,
            similarity: 1,
            matchType: 'exact',
            telemetry: { keywordCount: keywords.length, lookupMs: durationMs }
        };
    }
    // Low-confidence task classification is not enough evidence for fuzzy reuse.
    // Exact matches remain safe; broader reuse waits until the task shape is at
    // least medium confidence, avoiding the accuracy loss reported for aggressive
    // fuzzy thresholds in APC Table 6.
    if (query?.allowFuzzy === false) {
        const durationMs = performance.now() - startedAt;
        recordLookupTelemetry({ hit: false, durationMs });
        return null;
    }
    // Tier 2: Bounded Fuzzy Matching with calibrated similarity threshold (Table 6)
    const threshold = typeof query?.similarityThreshold === 'number' && Number.isFinite(query.similarityThreshold)
        ? Math.max(0.38, Math.min(1.0, query.similarityThreshold))
        : MATCH_THRESHOLD;
    let best = null;
    for (const template of plans) {
        // Archetype is a hard gate, not a score. A "build a 3D scene" plan sharing
        // three words with "debug the build" is not a plan for it.
        if (archetype && template.archetype && template.archetype !== archetype)
            continue;
        const score = similarity(keywords, template.keywords);
        if (score < threshold)
            continue;
        // Ties break on demonstrated usefulness, so a plan that has actually worked
        // outranks one that merely matched before.
        const winRate = template.uses > 0 ? template.wins / template.uses : 0;
        const ranked = score + winRate * 0.1;
        if (!best || ranked > best.ranked)
            best = { template, similarity: score, ranked };
    }
    const durationMs = performance.now() - startedAt;
    if (!best) {
        recordLookupTelemetry({ hit: false, durationMs });
        return null;
    }
    recordLookupTelemetry({ hit: true, matchType: 'fuzzy', durationMs });
    return {
        template: best.template,
        similarity: best.similarity,
        matchType: 'fuzzy',
        telemetry: { keywordCount: keywords.length, lookupMs: durationMs }
    };
}
/**
 * Store or reinforce the procedure a task actually followed.
 *
 * @param   {{prompt: string, archetype?: string, steps: PlanStep[]}} outcome
 * @returns {PlanTemplate|null} the stored template, or null when there was nothing worth storing
 */
export function recordPlan(outcome) {
    const startedAt = performance.now();
    const steps = Array.isArray(outcome?.steps)
        ? outcome.steps.filter(isPlanStep).slice(0, MAX_STEPS)
        : [];
    // A one-step task teaches nothing a fresh model would not do anyway.
    if (steps.length < 2)
        return null;
    const keywords = extractKeywords(outcome?.prompt);
    if (keywords.length === 0)
        return null;
    const plans = readAll();
    const archetype = String(outcome?.archetype || '');
    const existing = plans.find((t) => t.archetype === archetype && similarity(keywords, t.keywords) >= 0.8);
    if (existing) {
        existing.steps = steps; // the newest working route wins
        existing.uses += 1;
        existing.wins += 1;
        existing.updatedAt = Date.now();
        writeAll(prune(plans));
        const metrics = readMetrics();
        metrics.records += 1;
        metrics.totalRecordMs += performance.now() - startedAt;
        metrics.lastRecordAt = Date.now();
        dirtyMetricEvents += 1;
        writeMetrics(false);
        return existing;
    }
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
    const metrics = readMetrics();
    metrics.records += 1;
    metrics.totalRecordMs += performance.now() - startedAt;
    metrics.lastRecordAt = Date.now();
    dirtyMetricEvents += 1;
    writeMetrics(false);
    return template;
}
/**
 * Asynchronous, non-blocking cache generation matching Stanford APC Section 4.3.
 * Detaches log distillation and index persistence to background execution,
 * eliminating the ~3.99s critical-path latency penalty reported in Table 3.
 */
export function recordPlanAsync(outcome) {
    return new Promise((resolve) => {
        setImmediate(() => {
            try {
                const stored = recordPlan(outcome);
                resolve(stored);
            }
            catch {
                resolve(null);
            }
        });
    });
}
/**
 * Re-planning Phase Template Reuse (Stanford APC Page 8, Section 4.3).
 * Identifies alternative steps and workarounds when a tool execution fails.
 */
export function lookupAlternativeStep(query) {
    const plans = readAll();
    const archetype = String(query.archetype || '');
    const failedTool = String(query.failedTool || '').toLowerCase();
    const why = String(query.why || '');
    for (const template of plans) {
        if (archetype && template.archetype && template.archetype !== archetype)
            continue;
        const failedIdx = template.steps.findIndex((s) => s.tool.toLowerCase() === failedTool);
        if (failedIdx !== -1) {
            const step = template.steps[failedIdx];
            if (step && !step.ok && (!why || step.why === why)) {
                const nextStep = template.steps.slice(failedIdx + 1).find((s) => s.ok);
                if (nextStep) {
                    return {
                        suggestedTool: nextStep.tool,
                        suggestedNote: nextStep.note,
                        confidence: template.uses > 0 ? template.wins / template.uses : 0.8,
                        sourcePlanId: template.id,
                        reason: `Prior task worked around ${failedTool} (${step.why || 'failure'}) using ${nextStep.tool}`
                    };
                }
            }
        }
    }
    return null;
}
/**
 * Built-in canonical offline plan samples matching Stanford APC Section 4.5 & Table 7.
 * Pre-populating the cache mitigates cold-start overhead and delivers immediate hit rates.
 */
export const BUILTIN_OFFLINE_PREWARM_SEEDS = [
    {
        prompt: 'compile and verify project build artifacts with test suite',
        archetype: 'code',
        steps: [
            { tool: 'fs_read', action: 'inspect', ok: true },
            { tool: 'sys_run', action: 'build', ok: true },
            { tool: 'sys_run', action: 'test', ok: true }
        ]
    },
    {
        prompt: 'review git changes stage files create commit and push branch',
        archetype: 'git',
        steps: [
            { tool: 'sys_run', action: 'status', ok: true },
            { tool: 'sys_run', action: 'diff', ok: true },
            { tool: 'sys_run', action: 'commit', ok: true },
            { tool: 'sys_run', action: 'push', ok: true }
        ]
    },
    {
        prompt: 'inspect render output and encode video frames to playable container',
        archetype: 'media',
        steps: [
            { tool: 'sys_run', action: 'probe', ok: false, why: 'not_found' },
            { tool: 'blender_act', action: 'render', ok: true },
            { tool: 'sys_run', action: 'encode', ok: true }
        ]
    },
    {
        prompt: 'deep web search extract domain research data and synthesize report',
        archetype: 'research',
        steps: [
            { tool: 'web_search', action: 'query', ok: true },
            { tool: 'read_url_content', action: 'extract', ok: true },
            { tool: 'fs_write', action: 'synthesize', ok: true }
        ]
    },
    {
        prompt: 'diagnostic audit of system specifications environment memory and disk',
        archetype: 'system',
        steps: [
            { tool: 'check_system_specs', action: 'hardware', ok: true },
            { tool: 'sys_run', action: 'diagnostic', ok: true }
        ]
    }
];
/**
 * Automatically seeds the plan cache if empty to avoid cold start latency (Table 7).
 */
export function autoPrewarmIfCold() {
    const plans = readAll();
    if (plans.length > 0) {
        return { accepted: 0, rejected: 0, errors: [] };
    }
    return prewarmPlans(BUILTIN_OFFLINE_PREWARM_SEEDS);
}
/**
 * Pre-populate a cold cache from user-supplied, argument-free plan samples.
 * Only tool names, short action labels and closed-vocabulary outcomes survive;
 * paths, prompts passed to tools and command lines have no field to enter.
 */
export function prewarmPlans(samples) {
    if (!Array.isArray(samples))
        return { accepted: 0, rejected: 1, errors: ['Expected a JSON array'] };
    const errors = [];
    let accepted = 0;
    for (const [index, sample] of samples.slice(0, 100).entries()) {
        const sampleRecord = isRecord(sample) ? sample : {};
        const prompt = typeof sampleRecord.prompt === 'string' ? sampleRecord.prompt.trim() : '';
        const archetype = typeof sampleRecord.archetype === 'string' ? sampleRecord.archetype.trim().slice(0, 64) : '';
        const rawSteps = Array.isArray(sampleRecord.steps) ? sampleRecord.steps : [];
        if (!prompt || rawSteps.length < 2) {
            errors.push(`Sample ${index + 1}: prompt and at least two steps are required`);
            continue;
        }
        const steps = [];
        let invalid = false;
        for (const rawStep of rawSteps.slice(0, MAX_STEPS)) {
            const source = typeof rawStep === 'string'
                ? { tool: rawStep }
                : isRecord(rawStep) ? rawStep : {};
            const tool = typeof source.tool === 'string' ? source.tool.trim() : '';
            if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(tool)) {
                invalid = true;
                break;
            }
            const note = typeof source.action === 'string'
                ? source.action.toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 32)
                : '';
            const step = { tool, note, ok: source.ok !== false };
            if (!step.ok) {
                step.why = typeof source.why === 'string'
                    && SEED_FAILURE_CLASSES.has(source.why)
                    ? source.why
                    : 'failed';
            }
            steps.push(step);
        }
        if (invalid) {
            errors.push(`Sample ${index + 1}: invalid tool name`);
            continue;
        }
        if (recordPlan({ prompt, archetype, steps }))
            accepted++;
        else
            errors.push(`Sample ${index + 1}: could not be stored`);
    }
    if (samples.length > 100)
        errors.push(`Only the first 100 of ${samples.length} samples were considered`);
    return { accepted, rejected: errors.length, errors: errors.slice(0, 20) };
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
    if (!template)
        return false;
    template.uses += 1;
    template.updatedAt = Date.now();
    return writeAll(plans);
}
/**
 * Keep the cache bounded by usefulness rather than by age alone: a plan used
 * ten times last month is worth more than one stored yesterday and never hit.
 * Capacity defaults to 100 entries per Stanford APC Table 4 plateau analysis.
 *
 * @param   {PlanTemplate[]} plans
 * @param   {number} [capacity=MAX_PLANS]
 * @returns {PlanTemplate[]}
 */
export function prune(plans, capacity = MAX_PLANS) {
    const max = Math.max(1, capacity);
    if (plans.length <= max)
        return plans;
    const now = Date.now();
    const MONTH = 30 * 24 * 60 * 60 * 1000;
    return [...plans]
        .sort((a, b) => {
        const value = (t) => (t.uses > 0 ? t.wins / t.uses : 0) * Math.pow(2, -(now - t.updatedAt) / MONTH) * Math.log2(1 + t.uses);
        return value(b) - value(a);
    })
        .slice(0, max);
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
    if (!match || !match.template || !Array.isArray(match.template.steps))
        return '';
    const { template, similarity: score } = match;
    if (template.steps.length === 0)
        return '';
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
function computeMedian(values) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
/**
 * Record wall-clock latency for the 5 APC pipeline components matching Table 3 (Page 9).
 */
export function recordAPCPipelineLatency(latency) {
    const metrics = readMetrics();
    metrics.apcPipeline.taskCount += 1;
    metrics.apcPipeline.totalPlanMs += Math.max(0, latency.planMs || 0);
    metrics.apcPipeline.totalActMs += Math.max(0, latency.actMs || 0);
    metrics.apcPipeline.totalKeywordExtractionMs += Math.max(0, latency.keywordExtractionMs || 0);
    metrics.apcPipeline.totalCacheLookupMs += Math.max(0, latency.cacheLookupMs || 0);
    metrics.apcPipeline.totalCacheGenerationMs += Math.max(0, latency.cacheGenerationMs || 0);
    metrics.apcPipeline.totalTaskWallClockMs += Math.max(0, latency.totalMs || 0);
    dirtyMetricEvents += 1;
    writeMetrics(false);
}
/**
 * Record cost breakdown across planner LM, actor LM, and cache overhead matching Table 2 (Page 9).
 */
export function recordAPCCostBreakdown(cost) {
    const metrics = readMetrics();
    metrics.apcCost.totalLargePlannerCost += Math.max(0, cost.largePlannerCost || 0);
    metrics.apcCost.totalSmallPlannerCost += Math.max(0, cost.smallPlannerCost || 0);
    metrics.apcCost.totalActorCost += Math.max(0, cost.actorCost || 0);
    if (cost.cacheOverhead) {
        metrics.apcCost.totalKeywordExtractionCost += Math.max(0, cost.cacheOverhead.keywordExtractionCost || 0);
        metrics.apcCost.totalCacheGenerationCost += Math.max(0, cost.cacheOverhead.cacheGenerationCost || 0);
    }
    metrics.apcCost.totalCost += Math.max(0, cost.totalCost || 0);
    dirtyMetricEvents += 1;
    writeMetrics(false);
}
/**
 * Get cumulative and average wall-clock latency breakdown for APC pipeline components (Table 3).
 */
export function getAPCPipelineLatency() {
    const { apcPipeline } = readMetrics();
    const count = apcPipeline.taskCount || 1;
    return {
        planMs: apcPipeline.totalPlanMs,
        actMs: apcPipeline.totalActMs,
        keywordExtractionMs: apcPipeline.totalKeywordExtractionMs,
        cacheLookupMs: apcPipeline.totalCacheLookupMs,
        cacheGenerationMs: apcPipeline.totalCacheGenerationMs,
        totalMs: apcPipeline.totalTaskWallClockMs,
        averagePlanMs: apcPipeline.totalPlanMs / count,
        averageActMs: apcPipeline.totalActMs / count,
        averageLookupMs: apcPipeline.totalCacheLookupMs / count,
        averageGenerationMs: apcPipeline.totalCacheGenerationMs / count,
        averageTotalMs: apcPipeline.totalTaskWallClockMs / count,
        sampleCount: apcPipeline.taskCount
    };
}
/**
 * Get cumulative cost breakdown and cache overhead ratio matching Table 2 (Page 9).
 */
export function getAPCCostBreakdown() {
    const { apcCost } = readMetrics();
    const totalOverhead = apcCost.totalKeywordExtractionCost + apcCost.totalCacheGenerationCost;
    const overheadPct = apcCost.totalCost > 0 ? (totalOverhead / apcCost.totalCost) * 100 : 0;
    return {
        largePlannerCost: apcCost.totalLargePlannerCost,
        smallPlannerCost: apcCost.totalSmallPlannerCost,
        actorCost: apcCost.totalActorCost,
        cacheOverhead: {
            keywordExtractionCost: apcCost.totalKeywordExtractionCost,
            cacheGenerationCost: apcCost.totalCacheGenerationCost,
            totalOverheadCost: totalOverhead,
            overheadPercentage: overheadPct
        },
        totalCost: apcCost.totalCost
    };
}
/**
 * Reference scalability progression from Stanford APC Table 5 (Page 10).
 */
export function getAPCScalabilityReference() {
    return [
        { cacheSize: 100, exactHitLatencyUs: 13, exactMissLatencyUs: 14, fuzzyHitLatencyUs: 57, fuzzyMissLatencyUs: 24 },
        { cacheSize: 1000, exactHitLatencyUs: 15, exactMissLatencyUs: 15, fuzzyHitLatencyUs: 75, fuzzyMissLatencyUs: 70 },
        { cacheSize: 10000, exactHitLatencyUs: 16, exactMissLatencyUs: 17, fuzzyHitLatencyUs: 581, fuzzyMissLatencyUs: 554 },
        { cacheSize: 100000, exactHitLatencyUs: 22, exactMissLatencyUs: 18, fuzzyHitLatencyUs: 10388, fuzzyMissLatencyUs: 10317 },
        { cacheSize: 1000000, exactHitLatencyUs: 56, exactMissLatencyUs: 37, fuzzyHitLatencyUs: 148449, fuzzyMissLatencyUs: 148147 }
    ];
}
/**
 * Reference fuzzy keyword matching similarity threshold profile from Stanford APC Table 6 (Page 10).
 */
export function getAPCFuzzyThresholdReference() {
    return [
        { threshold: 1.0, hitRate: 0.46, cost: 1.86, accuracy: 0.855, planningLatencySec: 1011.82, totalLatencySec: 1424.82 },
        { threshold: 0.8, hitRate: 0.54, cost: 1.15, accuracy: 0.830, planningLatencySec: 875.31, totalLatencySec: 1219.73 },
        { threshold: 0.6, hitRate: 0.64, cost: 0.93, accuracy: 0.770, planningLatencySec: 720.29, totalLatencySec: 1044.50 }
    ];
}
/**
 * Reference cold-start progression from Stanford APC Table 7 (Page 10).
 */
export function getAPCColdStartReference() {
    return [
        { queryPercentile: 20, cacheEntries: 15, hitRate: 0.1429, cost: 0.59, planningLatencySec: 260.19, cacheGenLatencySec: 59.19, totalLatencySec: 358.71 },
        { queryPercentile: 40, cacheEntries: 27, hitRate: 0.2439, cost: 0.97, planningLatencySec: 484.88, cacheGenLatencySec: 130.29, totalLatencySec: 689.49 },
        { queryPercentile: 60, cacheEntries: 36, hitRate: 0.3607, cost: 1.20, planningLatencySec: 638.12, cacheGenLatencySec: 167.89, totalLatencySec: 926.82 },
        { queryPercentile: 80, cacheEntries: 42, hitRate: 0.4075, cost: 1.63, planningLatencySec: 820.94, cacheGenLatencySec: 195.59, totalLatencySec: 1183.39 },
        { queryPercentile: 100, cacheEntries: 46, hitRate: 0.4800, cost: 1.84, planningLatencySec: 948.36, cacheGenLatencySec: 214.11, totalLatencySec: 1394.56 }
    ];
}
/** @returns {object} */
export function planStats() {
    const metrics = readMetrics();
    const pipeline = getAPCPipelineLatency();
    const cost = getAPCCostBreakdown();
    return {
        count: readAll().length,
        file: PLAN_FILE,
        metricsFile: METRICS_FILE,
        lookups: metrics.lookups,
        hits: metrics.hits,
        exactHits: metrics.exactHits,
        fuzzyHits: metrics.fuzzyHits,
        misses: metrics.misses,
        bypassed: metrics.bypassed,
        hitRate: metrics.lookups > 0 ? metrics.hits / metrics.lookups : 0,
        recentHitRate: recentHitRate(metrics),
        averageLookupMs: metrics.lookups > 0 ? metrics.totalLookupMs / metrics.lookups : 0,
        maxLookupMs: metrics.maxLookupMs,
        averageRecordMs: metrics.records > 0 ? metrics.totalRecordMs / metrics.records : 0,
        disabledUntil: metrics.disabledUntil,
        disabled: metrics.disabledUntil > Date.now(),
        apcPipeline: pipeline.sampleCount > 0 ? pipeline : undefined,
        apcCost: cost.totalCost > 0 ? cost : undefined,
        exactLookupP50Us: computeMedian(metrics.exactLookupTimesUs),
        fuzzyLookupP50Us: computeMedian(metrics.fuzzyLookupTimesUs)
    };
}
/**
 * Remove every stored plan. Used by `/cortex --forget` style operations and by
 * tests; never called automatically.
 * @returns {number} how many were removed
 */
export function forgetPlans() {
    const count = readAll().length;
    writeAll([]);
    metricsCache = defaultMetrics();
    dirtyMetricEvents = 1;
    writeMetrics(true);
    return count;
}
export { PLAN_FILE, PLAN_DIR, METRICS_FILE, MATCH_THRESHOLD, DEFAULT_FUZZY_THRESHOLD, DEFAULT_CAPACITY, MAX_PLANS, MIN_LOOKUPS_BEFORE_DISABLE, MIN_PLANS_BEFORE_DISABLE, MIN_HEALTHY_HIT_RATE, DISABLE_COOLDOWN_MS };
