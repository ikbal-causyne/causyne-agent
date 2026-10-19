import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig } from './config.js';

import { causyneHome } from './utils/paths.js';

const USAGE_DIR = path.join(causyneHome(), 'usage');

/**
 * The date key for "today", in the USER'S timezone.
 *
 * This was `new Date().toISOString().split('T')[0]`, which is UTC. A daily
 * budget bucketed in UTC does not reset at the user's midnight: in WIB (UTC+7)
 * it rolls over at 07:00 local, in NZDT (UTC+13) at 13:00, in PST (UTC-8) the
 * previous evening. So a user's morning work was charged to "yesterday" and
 * their daily cap could be exhausted before their day had started — and the
 * reset landed in the middle of it.
 *
 * A limit the user sets as "per day" must mean their day. Anything else is a
 * limit they cannot reason about.
 */

let usageQueue = Promise.resolve();
function withUsageLock(fn) {
  const run = usageQueue.then(fn, fn);
  usageQueue = run.then(() => {}, () => {});
  return run;
}

/**
 * Write a usage file the way the journal does: temp file, then rename.
 *
 * A direct writeFileSync that is interrupted leaves truncated JSON, and
 * getDailyUsage() answers a parse failure with a fresh zeroed record — so a
 * torn write does not surface as an error, it silently ERASES the day's budget.
 * rename() is atomic on the same filesystem, so a reader sees either the whole
 * previous file or the whole new one.
 */
function writeUsageFile(file, payload) {
  const temp = `${file}.tmp_${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function localDateKey(when = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

// Input-token count above which GPT-6 Astra bills on its second rate card
// ($20/$75 instead of $10/$50). The higher card applies to the whole request,
// not to the overage alone.
const ASTRA_LONG_CONTEXT_THRESHOLD = 272000;

export class TokenTracker {
  constructor() {
    this.config = loadConfig();
    this.budget = this.config.tokenBudget || { enabled: false };
    this.taskTokens = 0;
    this.taskCostUsd = 0;
    this.largestStepTokens = 0;
    this.ensureUsageDir();
  }



  // Cost per 1M tokens [prompt, completion] (2026 Pricing)
  //
  // `promptTokens` is optional and only consulted by providers that publish a
  // SECOND rate card above a context threshold. GPT-6 Astra is the first: past
  // 272,000 input tokens the same request bills at $20 in / $75 out instead of
  // $10 / $50. Ignoring that under-reported long-context runs by 2x — and
  // under-reporting is the worse direction, because the user's real invoice
  // then exceeds the cost shown by Causyne.
  getPricing(promptTokens = 0) {
    const provider = this.config.provider?.toLowerCase();
    const model = this.config.model?.toLowerCase() || '';

    if (provider === 'deepseek') {
      if (model.includes('pro')) return [0.435, 0.87];
      if (model.includes('flash')) return [0.14, 0.28];
      return [0.14, 0.28]; // Default
    }

    // Meta Model API — Muse. Published rates per 1M tokens, read off the
    // console: Standard $1.25 in / $4.25 out; Contributor $0.10 in / $0.20 out,
    // which is the "up to 95% less than Standard" the tier advertises in
    // exchange for training on your prompts and completions.
    //
    // 1.2 and 1.1 are NOT separately published. They fall back to the 1.3 rate
    // of their own tier, which over-estimates if they are cheaper — the safe
    // direction for something that stops a run when the budget is spent.
    if (provider === 'muse' || provider === 'meta') {
      if (model.includes('-contributor')) return [0.10, 0.20];
      return [1.25, 4.25];
    }

    if (provider === 'qwen' || provider === 'dashscope') {
      if (model.includes('max')) return [1.25, 3.75];
      if (model.includes('plus')) return [0.32, 1.28];
      if (model.includes('flash')) return [0.19, 1.13];
      return [0.32, 1.28]; // Default
    }

    if (provider === 'openai') {
      // GPT-6 Astra (2026-09-03). Two rate cards: $10/$50 up to 272K input
      // tokens, $20/$75 for a request that crosses it — the tier applies to
      // the WHOLE request, not just the overage.
      if (model.includes('astra')) {
        return promptTokens > ASTRA_LONG_CONTEXT_THRESHOLD ? [20.00, 75.00] : [10.00, 50.00];
      }
      if (model.includes('sol')) return [5.00, 30.00];
      if (model.includes('terra')) return [2.50, 15.00];
      if (model.includes('luna')) return [1.00, 1.00];
      if (model.includes('mini')) return [0.75, 4.50];
      return [5.00, 30.00]; // Default OpenAI (Sol)
    }
    
    if (provider === 'anthropic') {
      // Mythos shares Fable's tier and price. Without its own branch it fell
      // through to the Sonnet default and was billed at a FIFTH of its rate.
      if (model.includes('fable') || model.includes('mythos')) return [10.00, 50.00];
      if (model.includes('opus')) return [5.00, 25.00];
      // Sonnet 4.6 is $3/$15; Sonnet 5 is $2/$10. Checked in that order
      // because 'sonnet-4-6' also matches the generic 'sonnet' test below.
      if (model.includes('sonnet-4-6')) return [3.00, 15.00];
      if (model.includes('sonnet')) return [2.00, 10.00];
      if (model.includes('haiku')) return [1.00, 5.00];
      return [2.00, 10.00]; // Default Anthropic (Sonnet 5)
    }
    
    if (provider === 'gemini') {
      if (model.includes('pro')) return [2.00, 12.00];
      if (model.includes('flash-lite')) return [0.25, 1.50];
      // 3.6 Flash holds 3.5's $1.50 input but cuts output from $9.00 to $7.50.
      // Checked before the generic 'flash' test, which it would also match.
      if (model.includes('3.6-flash') || model.includes('3-6-flash')) return [1.50, 7.50];
      if (model.includes('flash')) return [1.50, 9.00];
      return [1.50, 9.00]; // Default Gemini
    }
    
    // Local Ollama cost the user $0.00 in BYOK APIs
    if (provider === 'ollama') {
      return [0.00, 0.00]; 
    }
    
    return [5.00, 15.00]; // Unknown BYOK provider fallback
  }

  // Prompt-cache multipliers, applied against the base input price.
  // Anthropic: cache read 0.1x, cache write (5m) 1.25x.
  // OpenAI / xAI: cached input 0.5x. DeepSeek disk cache: roughly 0.1x.
  cachedInputMultiplier() {
    const provider = this.config.provider?.toLowerCase();
    if (provider === 'anthropic') {
      // Fable 5.1 reprices cache reads to $0.25/MTok against a $10 base — a
      // 0.025x discount, not the family's usual 0.1x. Charging 0.1x here
      
      // counter. Same shape as the Muse case below: the discount is a property
      // of the model, not the vendor.
      const model = this.config.model?.toLowerCase() || '';
      if (model.includes('fable-5-1')) return 0.025;
      return 0.1;
    }
    if (provider === 'deepseek') return 0.1;

    // Muse is the one provider whose cache discount differs by MODEL, not just
    // by vendor: $0.15 against $1.25 on Standard is 0.12x, while $0.002 against
    // $0.10 on Contributor is 0.02x. Collapsing both into one vendor number
    // would over-charge a Contributor run by six times on every cached token.
    if (provider === 'muse' || provider === 'meta') {
      const model = this.config.model?.toLowerCase() || '';
      return model.includes('-contributor') ? 0.02 : 0.12;
    }

    // GPT-6 Astra publishes cached input at $1.00/MTok against a $10.00 base —
    // a 90% discount, not the 0.5x the rest of this vendor falls back to.
    // Found while verifying the getPricing() rows above; charging 0.5x
    // overstated every cached Astra token FIVEFOLD.
    if (provider === 'openai') {
      const model = this.config.model?.toLowerCase() || '';
      if (model.includes('astra')) return 0.1;
    }

    // 0.5x is the long-standing OpenAI/xAI cached-input discount. It is NOT
    // verified against the GPT-5.6 family's current rate card; left as-is
    // rather than guessed at, since overstating is the safer error direction
    // for a number the user reads as a bill.
    return 0.5;
  }

  /**
   * @param {number} promptTokens      Total input tokens (cached + uncached).
   * @param {number} completionTokens  Output tokens.
   * @param {object} usageDetail       Optional { cachedPromptTokens, cacheWriteTokens }.
   */
  calculateCost(promptTokens, completionTokens, usageDetail = null) {
    // promptTokens decides the rate card on providers with a context tier.
    const [promptPrice, completionPrice] = this.getPricing(promptTokens);

    const cachedTokens = Math.min(usageDetail?.cachedPromptTokens || 0, promptTokens);
    const writeTokens = Math.min(usageDetail?.cacheWriteTokens || 0, promptTokens - cachedTokens);
    const fullPriceTokens = Math.max(0, promptTokens - cachedTokens - writeTokens);

    const writeMultiplier = usageDetail?.cacheWriteMultiplier || 1.25;
    const promptCost =
      (fullPriceTokens / 1_000_000) * promptPrice +
      (cachedTokens / 1_000_000) * promptPrice * this.cachedInputMultiplier() +
      (writeTokens / 1_000_000) * promptPrice * writeMultiplier;

    const completionCost = (completionTokens / 1_000_000) * completionPrice;
    return promptCost + completionCost;
  }

  // Cost per item (image) or per second (video_animation) in USD (2026 Pricing)
  getMediaPricing(provider = '', model = '', mediaType = 'image') {
    const p = provider.toLowerCase();
    const m = model.toLowerCase();

    // Muse Image is a flat per-image rate; there is no video model in the
    // family, so a video request must not silently bill at the image rate.
    if (p === 'muse' || p === 'meta') {
      if (mediaType === 'video_animation') return 0;
      return 0.01; // $0.01 per image
    }

    if (p === 'gemini') {
      if (mediaType === 'video_animation' || m.includes('veo')) return 0.05; // $0.05 per second of Veo 2.0 video
      if (m.includes('imagen')) return 0.03; // $0.03 per image
      return 0.03;
    }
    if (p === 'openai') {
      if (mediaType === 'video_animation' || m.includes('sora')) return 0.10; // $0.10 per second
      if (m.includes('dall-e-3')) return 0.08; // $0.08 per HD image
      return 0.04; // $0.04 per standard image
    }
    if (p === 'qwen' || p === 'dashscope') {
      if (mediaType === 'video_animation' || m.includes('wanx') || m.includes('wan2')) return 0.04; // $0.04 per second
      return 0.02; // $0.02 per image
    }
    if (p === 'pollinations' || p === 'local') {
      return 0.00; // Free Mode D / Mode A
    }
    return 0.03; // Default generic media cost
  }

  async trackMediaUsage(provider, mediaType, model, quantityUnits = 1, onWarning = null) {
    this.config = loadConfig();
    this.budget = this.config.tokenBudget || { enabled: false };

    const unitPrice = this.getMediaPricing(provider, model, mediaType);
    const cost = unitPrice * (quantityUnits || 1);
    
    // Multimedia Equivalent Units (MEU): convert dollar cost to equivalent tokens ($0.000002/token ~ $2/1M tokens)
    const equivalentTokens = Math.round(cost / 0.000002);
    
    this.taskTokens += equivalentTokens;
    this.taskCostUsd += cost;



    const daily = await this.getDailyUsage();
    daily.totalTokens += equivalentTokens;
    daily.totalCalls += 1;
    daily.totalCostUsd = (daily.totalCostUsd || 0) + cost;
    await this.saveDailyUsage(daily);

    const cumulative = await this.getCumulativeUsage();
    cumulative.totalTokens += equivalentTokens;
    cumulative.totalCalls += 1;
    cumulative.totalCostUsd = (cumulative.totalCostUsd || 0) + cost;
    await this.saveCumulativeUsage(cumulative);

    if (!this.budget.enabled) {
      return { allowed: true, used: daily.totalTokens, costUsd: daily.totalCostUsd, taskCostUsd: this.taskCostUsd, equivalentTokens };
    }

    // Monetary Kill Switch
    if (this.budget.maxCostUsd && daily.totalCostUsd > this.budget.maxCostUsd) {
      if (this.budget.hardStop) {
        return {
          allowed: false,
          reason: `BYOK Monetary Kill-Switch Activated: Media generation cost ($${cost.toFixed(2)}) pushes total spend to $${daily.totalCostUsd.toFixed(2)}, exceeding your $${this.budget.maxCostUsd.toFixed(2)} limit.`,
          used: daily.totalTokens,
          costUsd: daily.totalCostUsd,
          taskCostUsd: this.taskCostUsd,
          equivalentTokens
        };
      }
    }

    await this.checkAndTriggerAlerts(daily, onWarning);
    return { allowed: true, used: daily.totalTokens, costUsd: daily.totalCostUsd, taskCostUsd: this.taskCostUsd, equivalentTokens };
  }

  async checkAndTriggerAlerts(daily, onWarning = null) {
    if (!this.budget.enabled) return;

    const alertThreshold = this.budget.alertThresholdTokens
      ? Number(this.budget.alertThresholdTokens)
      : (this.budget.maxTokensPerDay && this.budget.warningThreshold ? this.budget.maxTokensPerDay * this.budget.warningThreshold : null);

    if (alertThreshold && alertThreshold > 0 && daily.totalTokens >= alertThreshold && !daily.alertSent) {
      daily.alertSent = true;
      await this.saveDailyUsage(daily);

      const msg = `⚠️ Token Budget Alert: Your BYOK usage has reached ${daily.totalTokens.toLocaleString()} tokens (Threshold: ${alertThreshold.toLocaleString()}).`;
      if (onWarning) {
        onWarning(msg);
      }
    }
  }

  ensureUsageDir() {
    if (!fs.existsSync(USAGE_DIR)) {
      fs.mkdirSync(USAGE_DIR, { recursive: true });
    }
  }

  getDailyFile() {
    return path.join(USAGE_DIR, `${localDateKey()}.json`);
  }

  getCumulativeFile() {
    return path.join(USAGE_DIR, 'byok_cumulative.json');
  }


  async getDailyUsage() {
    const file = this.getDailyFile();
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch(e) {}
    }
    return { date: localDateKey(), totalTokens: 0, totalCalls: 0, totalCostUsd: 0 };
  }

  async getCumulativeUsage() {
    const file = this.getCumulativeFile();
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch(e) {}
    }
    
    // Automatic Historical Backfill Migration (v1.1.50):
    // Scan all past `${date}.json` files across USAGE_DIR and sum them up so past 5M+ tokens are never lost!
    let totalTokens = 0;
    let totalCalls = 0;
    let totalCostUsd = 0;
    try {
      if (fs.existsSync(USAGE_DIR)) {
        const files = fs.readdirSync(USAGE_DIR);
        for (const f of files) {
          if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) {
            try {
              const data = JSON.parse(fs.readFileSync(path.join(USAGE_DIR, f), 'utf8'));
              totalTokens += (data.totalTokens || 0);
              totalCalls += (data.totalCalls || 0);
              totalCostUsd += (data.totalCostUsd || 0);
            } catch (err) {}
          }
        }
      }
    } catch (err) {}
    
    const initialCumulative = { totalTokens, totalCalls, totalCostUsd, backfilled: true, lastUpdated: new Date().toISOString() };
    try {
      writeUsageFile(file, initialCumulative);
    } catch (err) {}
    return initialCumulative;
  }


  async saveDailyUsage(usage) {
    writeUsageFile(this.getDailyFile(), usage);
  }

  async saveCumulativeUsage(usage) {
    writeUsageFile(this.getCumulativeFile(), usage);
  }


  async resetDailyUsage() {
    const file = this.getDailyFile();
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
    // DO NOT reset cumulative usage here, keeping lifetime tracking separate from fresh budget.
  }

  async resetCumulativeUsage() {
    const file = this.getCumulativeFile();
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }

  async getReportedUsage() {
    const daily = await this.getDailyUsage();
    const cumulative = await this.getCumulativeUsage();
    return {
      usedTokens: daily.totalTokens, // UI budget tracks against daily "Fresh" setup
      dailyTokens: daily.totalTokens,
      taskTokens: this.taskTokens,
      lifetimeTokens: cumulative.totalTokens,
      costUsd: daily.totalCostUsd, // UI estimated cost tracks against daily "Fresh" setup
      taskCostUsd: this.taskCostUsd,
      lifetimeCostUsd: cumulative.totalCostUsd,
      isDemo: false
    };
  }

  /**
   * Can the loop afford ANOTHER step without breaching the task ceiling?
   *
   * WHY THIS EXISTS. trackUsage() checks `taskTokens > maxTokensPerTask` AFTER
   * a call has already been paid for, so the run always overshoots by one step.
   * With ~9,000-token steps a 299,000 ceiling lands at ~308,000 — which breaks
   * the only promise a token cap makes. Asked BEFORE the call, using the
   * largest step seen so far, the ceiling actually holds.
   *
   * The largest step rather than the average, deliberately: a cap that holds
   * on average is a cap that fails on the step that matters.
   *
   * @returns {{allowed:boolean, reason?:string, used:number, limit:number, projected:number}}
   */
  canAffordAnotherStep() {
    const limit = this.budget && this.budget.enabled && this.budget.hardStop
      ? Number(this.budget.maxTokensPerTask || 0)
      : 0;
    if (!limit) return { allowed: true, used: this.taskTokens, limit: 0, projected: this.taskTokens };

    // Before the first step there is nothing to extrapolate from; let it run.
    const step = this.largestStepTokens || 0;
    const projected = this.taskTokens + step;
    if (step > 0 && projected > limit) {
      return {
        allowed: false,
        reason: `Stopping before the next step would breach the task ceiling: ${this.taskTokens.toLocaleString()} used, `
          + `the largest step so far was ${step.toLocaleString()}, and ${projected.toLocaleString()} would exceed the ${limit.toLocaleString()} limit.`,
        used: this.taskTokens, limit, projected
      };
    }
    return { allowed: true, used: this.taskTokens, limit, projected };
  }

  resetTask() {
    this.taskTokens = 0;
    this.taskCostUsd = 0;
    this.largestStepTokens = 0;
  }

  
  settle(extra, daily, cumulative) {
    return {
      // Daily scope — what the budget bar and the daily limiter both measure.
      usedTokens: daily.totalTokens,
      dailyTokens: daily.totalTokens,
      dailyCostUsd: daily.totalCostUsd || 0,
      dailyLimit: Number(this.budget && this.budget.maxTokensPerDay) || 0,
      // Task scope — what this run has spent.
      taskTokens: this.taskTokens,
      taskCostUsd: this.taskCostUsd,
      taskLimit: Number(this.budget && this.budget.maxTokensPerTask) || 0,
      // Lifetime scope.
      lifetimeTokens: cumulative.totalTokens,
      lifetimeCostUsd: cumulative.totalCostUsd,
      // Retained for clients built against the older frame. It has always been
      // the daily cost on the allowed path, so it keeps that meaning here
      // rather than acquiring a third one.
      costUsd: daily.totalCostUsd || 0,
      used: this.taskTokens,
      ...extra
    };
  }

  async trackUsage(promptTokens, completionTokens, onWarning = null, usageDetail = null) {
    // Dynamically reload config to apply live budget updates from UI
    this.config = loadConfig();
    this.budget = this.config.tokenBudget || { enabled: false };

    const total = (promptTokens || 0) + (completionTokens || 0);
    this.taskTokens += total;
    // Feeds canAffordAnotherStep(). The LARGEST step, not the average: a
    // ceiling that holds on average is a ceiling that fails on the step that
    // matters, and every step is bigger than the last as the window grows.
    this.largestStepTokens = Math.max(this.largestStepTokens || 0, total);

    const cost = this.calculateCost(promptTokens, completionTokens, usageDetail);
    this.taskCostUsd += cost;


    
    // Normal BYOK Tracking.
    //
    // Read-modify-write, so it runs inside the lock. Outside it, a condenser
    // pass firing concurrently with the loop silently subtracts its own tokens
    // from the day's total.
    const { daily, cumulative } = await withUsageLock(async () => {
      const daily = await this.getDailyUsage();
      daily.totalTokens += total;
      daily.totalCalls += 1;
      daily.totalCostUsd = (daily.totalCostUsd || 0) + cost;
      await this.saveDailyUsage(daily);

      const cumulative = await this.getCumulativeUsage();
      cumulative.totalTokens += total;
      cumulative.totalCalls += 1;
      cumulative.totalCostUsd = (cumulative.totalCostUsd || 0) + cost;
      await this.saveCumulativeUsage(cumulative);

      return { daily, cumulative };
    });
    
    if (!this.budget.enabled) {
      return this.settle({ allowed: true }, daily, cumulative);
    }
    
    // BYOK Monetary Kill Switch
    if (this.budget.maxCostUsd && daily.totalCostUsd > this.budget.maxCostUsd) {
      if (this.budget.hardStop) {
        return this.settle({
          allowed: false,
          reason: `BYOK Monetary Kill-Switch Activated: You have spent $${daily.totalCostUsd.toFixed(2)}, which exceeds your $${this.budget.maxCostUsd.toFixed(2)} limit.`
        }, daily, cumulative);
      }
    }
    
    // Check task budget
    if (this.budget.maxTokensPerTask && this.taskTokens > this.budget.maxTokensPerTask) {
      if (this.budget.hardStop) {
        return this.settle({
          allowed: false,
          reason: `Task token budget reached: ${this.taskTokens.toLocaleString()} of ${Number(this.budget.maxTokensPerTask).toLocaleString()} tokens for this task.`,
          limit: this.budget.maxTokensPerTask
        }, daily, cumulative);
      }
    }

    // Check daily budget. This limit was previously accepted from the UI and
    // used only to derive an alert threshold — it never actually stopped
    // anything, so a runaway task could blow straight through it.
    if (this.budget.maxTokensPerDay && daily.totalTokens > this.budget.maxTokensPerDay) {
      if (this.budget.hardStop) {
        return this.settle({
          allowed: false,
          reason: `Daily token budget reached: ${daily.totalTokens.toLocaleString()} of ${Number(this.budget.maxTokensPerDay).toLocaleString()} tokens used today.`,
          limit: this.budget.maxTokensPerDay
        }, daily, cumulative);
      }
    }
    
    await this.checkAndTriggerAlerts(daily, onWarning);
    
    return this.settle({ allowed: true }, daily, cumulative);
  }
}
