import { cortexDb } from './vectorDb.js';
// Diagnostics, off by default: console output during a turn overwrites the
// prompt's live region. See src/cortex/provisioner.js for the full reason.
function debugLog(message) {
    if (process.env.CAUSYNE_DEBUG !== '1')
        return;
    process.stderr.write(`[causyne] ${message}\n`);
}
// V5 Cortex — Tiered Auto-Condensation
//
// When the sliding window amputates older messages, that knowledge must not
// simply evaporate: continuity across sessions is what turns a stateless text
// predictor into something with a useful retained history.
//
// The tiered design:
//   Tier 1 (always, free)  — a deterministic structural summary is written to
//                            the Cortex with no LLM involved. The brain always
//                            learns something, on every provider, at zero cost.
//   Tier 2 (gated, billed) — semantic LLM condensation, but only when the
//                            dropped chunk is materially large, capped per task,
//                            with bounded input and fully tracked usage.
const MAX_CONDENSE_CHARS = 24000;
const MIN_CHARS_FOR_LLM_PASS = 6000;
const DEFAULT_MAX_LLM_PASSES_PER_TASK = 3;
function serialiseContent(content) {
    if (content == null)
        return '';
    return typeof content === 'string' ? content : (JSON.stringify(content) || '');
}
/**
 * Tier 1: structural facts extracted without any model call.
 * Records what was attempted, which files were touched and what failed —
 * exactly the things the agent asks itself again ten steps later.
 */
export function buildStructuralSummary(droppedMessages) {
    const toolCounts = new Map();
    const touchedPaths = new Set();
    const failures = [];
    const userTurns = [];
    for (const msg of droppedMessages) {
        const content = serialiseContent(msg.content);
        if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.length < 600) {
            userTurns.push(msg.content.trim());
        }
        if (msg.role === 'tool') {
            if (msg.name)
                toolCounts.set(msg.name, (toolCounts.get(msg.name) || 0) + 1);
            // Absolute paths are the highest-value breadcrumb in a dropped chunk.
            const paths = content.match(/\/[\w.\-/]+\.[a-zA-Z0-9]{1,6}/g);
            if (paths)
                for (const p of paths.slice(0, 6))
                    touchedPaths.add(p);
            try {
                const parsed = JSON.parse(content);
                if (parsed && parsed.success === false && parsed.error) {
                    failures.push(`${msg.name || 'tool'}: ${String(parsed.error).slice(0, 140)}`);
                }
            }
            catch (_e) {
                // Non-JSON tool output carries no structured verdict; skip it.
            }
        }
    }
    const parts = [];
    if (userTurns.length > 0) {
        parts.push(`Requests in this segment: ${userTurns.slice(0, 3).join(' | ')}`);
    }
    if (toolCounts.size > 0) {
        const tools = [...toolCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([name, count]) => `${name}x${count}`)
            .join(', ');
        parts.push(`Tools used: ${tools}`);
    }
    if (touchedPaths.size > 0) {
        parts.push(`Files touched: ${[...touchedPaths].slice(0, 12).join(', ')}`);
    }
    if (failures.length > 0) {
        parts.push(`Failures encountered: ${failures.slice(0, 4).join(' | ')}`);
    }
    return parts.length > 0 ? parts.join('. ') : '';
}
/**
 * Condense dropped messages into Cortex memory.
 */
export async function condenseAndSave(droppedMessages, llm = null, tokenTracker = null, options = {}) {
    const result = { structural: false, semantic: false };
    if (!droppedMessages || droppedMessages.length === 0)
        return result;
    // ---- Tier 1: always-on, zero cost -------------------------------------
    try {
        const structural = buildStructuralSummary(droppedMessages);
        if (structural) {
            await cortexDb.saveCondensedMemory(structural);
            result.structural = true;
        }
    }
    catch (e) {
        debugLog(`[Auto-Condenser] Structural condensation failed: ${e.message}`);
    }
    // ---- Tier 2: gated semantic pass --------------------------------------
    if (!llm || options.enableLlmPass === false)
        return result;
    const maxPasses = Number.isInteger(options.maxLlmPasses)
        ? options.maxLlmPasses
        : DEFAULT_MAX_LLM_PASSES_PER_TASK;
    if ((options.passesUsed || 0) >= maxPasses)
        return result;
    let conversationText = droppedMessages.map((m) => {
        let content = serialiseContent(m.content);
        if (content.length > 2000)
            content = content.slice(0, 2000) + ' …[truncated]';
        return `${String(m.role || '').toUpperCase()}: ${content}`;
    }).join('\n\n');
    if (conversationText.length < MIN_CHARS_FOR_LLM_PASS)
        return result;
    if (conversationText.length > MAX_CONDENSE_CHARS) {
        conversationText = conversationText.slice(-MAX_CONDENSE_CHARS);
    }
    try {
        const prompt = `You are an AI Memory Condenser for an autonomous agent.
Below is a chunk of an older conversation between the User and the Assistant that is being pushed out of the short-term memory window due to length constraints.
Your task is to summarize the KEY FACTS, DECISIONS, or OUTCOMES from this conversation snippet into 1-3 concise bullet points.
- Do NOT include pleasantries, filler, or transient errors that were immediately fixed.
- Only include structural knowledge, architectural decisions, and final outcomes that the agent might need later.
- If there is nothing permanently useful in this chunk, reply with exactly: SKIP

Conversation Snippet:
${conversationText}

Provide only the bullet points.`;
        const response = await llm.chat([{ role: 'user', content: prompt }], {
            temperature: 0.1,
            maxTokens: 400
        });
        if (tokenTracker && response && response.usage) {
            await tokenTracker.trackUsage(response.usage.promptTokens || 0, response.usage.completionTokens || 0, null, response.usage);
        }
        if (response && response.content) {
            const summary = String(response.content).trim();
            if (summary && summary !== 'SKIP' && summary.length > 10) {
                await cortexDb.saveCondensedMemory(summary);
                result.semantic = true;
            }
        }
    }
    catch (e) {
        debugLog(`[Auto-Condenser] Semantic condensation failed: ${e.message}`);
    }
    return result;
}
