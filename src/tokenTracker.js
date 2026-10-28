import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { causyneHome } from './utils/paths.js';
const USAGE_DIR = path.join(causyneHome(), 'usage');
let usageQueue = Promise.resolve();
function withUsageLock(fn) {
    const run = usageQueue.then(fn, fn);
    usageQueue = run.then(() => { }, () => { });
    return run;
}
function writeUsageFile(file, payload) {
    const temp = `${file}.tmp_${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
}
function localDateKey(when = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}
const ASTRA_LONG_CONTEXT_THRESHOLD = 272000;
export class TokenTracker {
    config;
    budget;
    taskTokens;
    taskCostUsd;
    largestStepTokens;
    constructor() {
        this.config = loadConfig();
        this.budget = this.config.tokenBudget || { enabled: false };
        this.taskTokens = 0;
        this.taskCostUsd = 0;
        this.largestStepTokens = 0;
        this.ensureUsageDir();
    }
    getPricing(promptTokens = 0) {
        const provider = this.config.provider?.toLowerCase();
        const model = this.config.model?.toLowerCase() || '';
        if (provider === 'deepseek') {
            if (model.includes('pro'))
                return [0.435, 0.87];
            if (model.includes('flash'))
                return [0.14, 0.28];
            return [0.14, 0.28];
        }
        if (provider === 'muse' || provider === 'meta') {
            if (model.includes('-contributor'))
                return [0.10, 0.20];
            return [1.25, 4.25];
        }
        if (provider === 'qwen' || provider === 'dashscope') {
            if (model.includes('max'))
                return [1.25, 3.75];
            if (model.includes('plus'))
                return [0.32, 1.28];
            if (model.includes('flash'))
                return [0.19, 1.13];
            return [0.32, 1.28];
        }
        if (provider === 'openai') {
            if (model.includes('astra')) {
                return promptTokens > ASTRA_LONG_CONTEXT_THRESHOLD ? [20.00, 75.00] : [10.00, 50.00];
            }
            if (model.includes('sol'))
                return [5.00, 30.00];
            if (model.includes('terra'))
                return [2.50, 15.00];
            if (model.includes('luna'))
                return [1.00, 1.00];
            if (model.includes('mini'))
                return [0.75, 4.50];
            return [5.00, 30.00];
        }
        if (provider === 'anthropic') {
            if (model.includes('fable') || model.includes('mythos'))
                return [10.00, 50.00];
            if (model.includes('opus'))
                return [5.00, 25.00];
            if (model.includes('sonnet-4-6'))
                return [3.00, 15.00];
            if (model.includes('sonnet'))
                return [2.00, 10.00];
            if (model.includes('haiku'))
                return [1.00, 5.00];
            return [2.00, 10.00];
        }
        if (provider === 'gemini') {
            if (model.includes('pro'))
                return [2.00, 12.00];
            if (model.includes('flash-lite'))
                return [0.25, 1.50];
            if (model.includes('3.6-flash') || model.includes('3-6-flash'))
                return [1.50, 7.50];
            if (model.includes('flash'))
                return [1.50, 9.00];
            return [1.50, 9.00];
        }
        if (provider === 'ollama') {
            return [0.00, 0.00];
        }
        if (provider === 'acp' || provider?.startsWith('acp/') || provider === 'antigravity' || provider === 'agy') {
            return [0.00, 0.00];
        }
        return [5.00, 15.00];
    }
    cachedInputMultiplier() {
        const provider = this.config.provider?.toLowerCase();
        if (provider === 'anthropic') {
            const model = this.config.model?.toLowerCase() || '';
            if (model.includes('fable-5-1'))
                return 0.025;
            return 0.1;
        }
        if (provider === 'deepseek')
            return 0.1;
        if (provider === 'muse' || provider === 'meta') {
            const model = this.config.model?.toLowerCase() || '';
            return model.includes('-contributor') ? 0.02 : 0.12;
        }
        if (provider === 'openai') {
            const model = this.config.model?.toLowerCase() || '';
            if (model.includes('astra'))
                return 0.1;
        }
        return 0.5;
    }
    calculateCost(promptTokens, completionTokens, usageDetail = null) {
        const [promptPrice, completionPrice] = this.getPricing(promptTokens);
        const cachedTokens = Math.min(Number(usageDetail?.cachedPromptTokens || 0), promptTokens);
        const writeTokens = Math.min(Number(usageDetail?.cacheWriteTokens || 0), promptTokens - cachedTokens);
        const fullPriceTokens = Math.max(0, promptTokens - cachedTokens - writeTokens);
        const writeMultiplier = Number(usageDetail?.cacheWriteMultiplier || 1.25);
        const promptCost = (fullPriceTokens / 1_000_000) * promptPrice +
            (cachedTokens / 1_000_000) * promptPrice * this.cachedInputMultiplier() +
            (writeTokens / 1_000_000) * promptPrice * writeMultiplier;
        const completionCost = (completionTokens / 1_000_000) * completionPrice;
        return promptCost + completionCost;
    }
    getMediaPricing(provider = '', model = '', mediaType = 'image') {
        const p = provider.toLowerCase();
        const m = model.toLowerCase();
        if (p === 'muse' || p === 'meta') {
            if (mediaType === 'video_animation')
                return 0;
            return 0.01;
        }
        if (p === 'gemini') {
            if (mediaType === 'video_animation' || m.includes('veo'))
                return 0.05;
            if (m.includes('imagen'))
                return 0.03;
            return 0.03;
        }
        if (p === 'openai') {
            if (mediaType === 'video_animation' || m.includes('sora'))
                return 0.10;
            if (m.includes('dall-e-3'))
                return 0.08;
            return 0.04;
        }
        if (p === 'qwen' || p === 'dashscope') {
            if (mediaType === 'video_animation' || m.includes('wanx') || m.includes('wan2'))
                return 0.04;
            return 0.02;
        }
        if (p === 'pollinations' || p === 'local') {
            return 0.00;
        }
        if (p === 'acp' || p.startsWith('acp/') || p === 'antigravity' || p === 'agy') {
            return 0.00;
        }
        return 0.03;
    }
    async trackMediaUsage(provider, mediaType, model, quantityUnits = 1, onWarning = null) {
        this.config = loadConfig();
        this.budget = this.config.tokenBudget || { enabled: false };
        const unitPrice = this.getMediaPricing(provider, model, mediaType);
        const cost = unitPrice * (quantityUnits || 1);
        const equivalentTokens = Math.round(cost / 0.000002);
        this.taskTokens += equivalentTokens;
        this.taskCostUsd += cost;
        const cumulative = await this.getCumulativeUsage();
        const daily = await this.getDailyUsage();
        daily.totalTokens += equivalentTokens;
        daily.totalCalls += 1;
        daily.totalCostUsd = (daily.totalCostUsd || 0) + cost;
        await this.saveDailyUsage(daily);
        cumulative.totalTokens += equivalentTokens;
        cumulative.totalCalls += 1;
        cumulative.totalCostUsd = (cumulative.totalCostUsd || 0) + cost;
        await this.saveCumulativeUsage(cumulative);
        if (!this.budget.enabled) {
            return { allowed: true, used: daily.totalTokens, costUsd: daily.totalCostUsd, taskCostUsd: this.taskCostUsd, equivalentTokens };
        }
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
        if (!this.budget.enabled)
            return;
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
            }
            catch {
                // Parse error fallback
            }
        }
        return { date: localDateKey(), totalTokens: 0, totalCalls: 0, totalCostUsd: 0 };
    }
    async getCumulativeUsage() {
        const file = this.getCumulativeFile();
        if (fs.existsSync(file)) {
            try {
                return JSON.parse(fs.readFileSync(file, 'utf8'));
            }
            catch {
                // Parse error fallback
            }
        }
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
                        }
                        catch {
                            // Ignore single unreadable file
                        }
                    }
                }
            }
        }
        catch {
            // Ignore scan failure
        }
        const initialCumulative = { totalTokens, totalCalls, totalCostUsd, backfilled: true, lastUpdated: new Date().toISOString() };
        try {
            writeUsageFile(file, initialCumulative);
        }
        catch {
            // Ignore initial write error
        }
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
            usedTokens: daily.totalTokens,
            dailyTokens: daily.totalTokens,
            taskTokens: this.taskTokens,
            lifetimeTokens: cumulative.totalTokens,
            costUsd: daily.totalCostUsd,
            taskCostUsd: this.taskCostUsd,
            lifetimeCostUsd: cumulative.totalCostUsd,
            isDemo: false
        };
    }
    canAffordAnotherStep() {
        const limit = this.budget && this.budget.enabled && this.budget.hardStop
            ? Number(this.budget.maxTokensPerTask || 0)
            : 0;
        if (!limit)
            return { allowed: true, used: this.taskTokens, limit: 0, projected: this.taskTokens };
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
            usedTokens: daily.totalTokens,
            dailyTokens: daily.totalTokens,
            dailyCostUsd: daily.totalCostUsd || 0,
            dailyLimit: Number(this.budget && this.budget.maxTokensPerDay) || 0,
            taskTokens: this.taskTokens,
            taskCostUsd: this.taskCostUsd,
            taskLimit: Number(this.budget && this.budget.maxTokensPerTask) || 0,
            lifetimeTokens: cumulative.totalTokens,
            lifetimeCostUsd: cumulative.totalCostUsd,
            costUsd: daily.totalCostUsd || 0,
            used: this.taskTokens,
            allowed: true,
            ...extra
        };
    }
    async trackUsage(promptTokens, completionTokens, onWarning = null, usageDetail = null) {
        this.config = loadConfig();
        this.budget = this.config.tokenBudget || { enabled: false };
        const finite = (v) => (Number.isFinite(v) ? Math.max(0, Number(v)) : 0);
        const pTokens = finite(promptTokens);
        const cTokens = finite(completionTokens);
        let freshInput = pTokens;
        let cachedTokens = 0;
        if (usageDetail) {
            if (usageDetail.uncachedPromptTokens !== undefined) {
                freshInput = finite(usageDetail.uncachedPromptTokens);
                cachedTokens = finite(usageDetail.cachedPromptTokens);
            }
            else if (usageDetail.cachedPromptTokens !== undefined) {
                cachedTokens = finite(usageDetail.cachedPromptTokens);
                if (cachedTokens > pTokens) {
                    freshInput = pTokens;
                }
                else {
                    freshInput = Math.max(0, pTokens - cachedTokens);
                }
            }
        }
        const freshStep = freshInput + cTokens;
        this.taskTokens += freshStep;
        this.largestStepTokens = Math.max(this.largestStepTokens || 0, freshStep);
        const cost = this.calculateCost(promptTokens, completionTokens, usageDetail);
        this.taskCostUsd += cost;
        const { daily, cumulative } = await withUsageLock(async () => {
            const cumulative = await this.getCumulativeUsage();
            const daily = await this.getDailyUsage();
            daily.totalTokens += freshStep;
            daily.totalCalls += 1;
            daily.totalCostUsd = (daily.totalCostUsd || 0) + cost;
            if (cachedTokens > 0) {
                daily.cachedTokens = (daily.cachedTokens || 0) + cachedTokens;
            }
            await this.saveDailyUsage(daily);
            cumulative.totalTokens += freshStep;
            cumulative.totalCalls += 1;
            cumulative.totalCostUsd = (cumulative.totalCostUsd || 0) + cost;
            if (cachedTokens > 0) {
                cumulative.cachedTokens = (cumulative.cachedTokens || 0) + cachedTokens;
            }
            await this.saveCumulativeUsage(cumulative);
            return { daily, cumulative };
        });
        if (!this.budget.enabled) {
            return this.settle({ allowed: true }, daily, cumulative);
        }
        if (this.budget.maxCostUsd && daily.totalCostUsd > this.budget.maxCostUsd) {
            if (this.budget.hardStop) {
                return this.settle({
                    allowed: false,
                    reason: `BYOK Monetary Kill-Switch Activated: You have spent $${daily.totalCostUsd.toFixed(2)}, which exceeds your $${this.budget.maxCostUsd.toFixed(2)} limit.`
                }, daily, cumulative);
            }
        }
        if (this.budget.maxTokensPerTask && this.taskTokens > this.budget.maxTokensPerTask) {
            if (this.budget.hardStop) {
                return this.settle({
                    allowed: false,
                    reason: `Task token budget reached: ${this.taskTokens.toLocaleString()} of ${Number(this.budget.maxTokensPerTask).toLocaleString()} tokens for this task.`,
                    limit: this.budget.maxTokensPerTask
                }, daily, cumulative);
            }
        }
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
