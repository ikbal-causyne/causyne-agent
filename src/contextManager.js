// Sovereign Context Manager
//
// Owns the whole context lifecycle:
//   1. Tool-result decay — old tool outputs collapse into one-line stubs.
//   2. Window construction — character-pool budget, newest first.
//   3. Real compaction — amputated messages are replaced by a single summary message.
//   4. Sequence sanitising — guarantees valid tool_call / tool_result pairing.
import { buildDecayPointer } from './outputStore.js';
export const CHARS_PER_TOKEN = 4;
export const RESULT_CAPS = {
    fs_read: 32000,
    code_search_ast: 32000,
    MultiEdit: 32000,
    fs_read_skill: 16000,
    tool_search: 8000,
    sysRun: 12000,
    sysRunBg: 12000,
    terminal_persistent_shell: 12000,
    web_fetch: 12000,
    web_search: 12000,
    fs_list: 8000,
    fs_find: 8000,
    fs_search: 12000
};
export const DEFAULT_RESULT_CAP = 32000;
export function resultCapFor(tool) {
    const raw = typeof tool === 'string' ? tool.trim() : '';
    if (!raw)
        return DEFAULT_RESULT_CAP;
    const canonical = raw.replace(/\./g, '_');
    const cap = Object.hasOwn(RESULT_CAPS, raw)
        ? RESULT_CAPS[raw]
        : (Object.hasOwn(RESULT_CAPS, canonical) ? RESULT_CAPS[canonical] : undefined);
    return typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_RESULT_CAP;
}
export const CHAR_POOLS = {
    super_max: 400000,
    max: 240000,
    premium: 180000,
    default: 120000
};
export const MODEL_CONTEXT_TOKENS = {
    gemini_1m: 1000000,
    gemini_2m: 2000000,
    claude_200k: 200000,
    openai_128k: 128000,
    openai_200k: 200000,
    astra_258k: 258000,
    deepseek_128k: 128000,
    qwen_128k: 128000,
    mistral_128k: 128000,
    grok_131k: 131072,
    default_byok: 128000
};
export function resolveModelContextTokens(options = {}) {
    const { provider = '', model = '', overrideTokens = 0 } = (options || {});
    if (typeof overrideTokens === 'number' && Number.isFinite(overrideTokens) && overrideTokens > 0) {
        return overrideTokens;
    }
    const p = String(provider || '').toLowerCase();
    const m = String(model || '').toLowerCase();
    if (m.includes('1.5-pro') || m.includes('2.0-pro') || m.includes('gemini-pro')) {
        return MODEL_CONTEXT_TOKENS.gemini_2m ?? 2000000;
    }
    if (p === 'antigravity' || p === 'agy' || m.includes('gemini') || p.includes('gemini')) {
        return MODEL_CONTEXT_TOKENS.gemini_1m ?? 1000000;
    }
    if (m.includes('astra')) {
        return MODEL_CONTEXT_TOKENS.astra_258k ?? 258000;
    }
    if (p === 'anthropic' || m.includes('claude') || m.includes('sonnet') || m.includes('opus') || m.includes('haiku')) {
        return MODEL_CONTEXT_TOKENS.claude_200k ?? 200000;
    }
    if (m.includes('o1') || m.includes('o3')) {
        return MODEL_CONTEXT_TOKENS.openai_200k ?? 200000;
    }
    if (p === 'openai' || m.includes('gpt-4')) {
        return MODEL_CONTEXT_TOKENS.openai_128k ?? 128000;
    }
    if (p === 'deepseek' || m.includes('deepseek')) {
        return MODEL_CONTEXT_TOKENS.deepseek_128k ?? 128000;
    }
    if (p === 'qwen' || p === 'dashscope' || m.includes('qwen')) {
        return MODEL_CONTEXT_TOKENS.qwen_128k ?? 128000;
    }
    if (p === 'mistral' || m.includes('mistral') || m.includes('codestral')) {
        return MODEL_CONTEXT_TOKENS.mistral_128k ?? 128000;
    }
    if (p === 'xai' || m.includes('grok')) {
        return MODEL_CONTEXT_TOKENS.grok_131k ?? 131072;
    }
    if (p && p !== 'default') {
        return MODEL_CONTEXT_TOKENS.default_byok ?? 128000;
    }
    return 0;
}
export function resolveCharPool(tier, override, context = {}) {
    if (typeof override === 'number' && Number.isFinite(override) && override > 0)
        return override;
    const modelTokens = resolveModelContextTokens(context);
    if (modelTokens > 0) {
        return modelTokens * 4;
    }
    if (tier === 'super_max')
        return CHAR_POOLS.super_max ?? 400000;
    if (tier === 'max')
        return CHAR_POOLS.max ?? 240000;
    if (tier === 'premium' || tier === 'premium_annual')
        return CHAR_POOLS.premium ?? 180000;
    return CHAR_POOLS.default ?? 120000;
}
function safeSerializeContent(content) {
    if (typeof content === 'string')
        return content;
    if (content == null)
        return '';
    try {
        const serialized = JSON.stringify(content);
        return typeof serialized === 'string' ? serialized : String(content);
    }
    catch {
        return String(content);
    }
}
function contentLength(content) {
    if (typeof content === 'string')
        return content.length;
    if (content == null)
        return 0;
    return safeSerializeContent(content).length;
}
export function measureMessages(messages) {
    if (!Array.isArray(messages))
        return 0;
    let total = 0;
    for (const msg of messages) {
        if (!msg)
            continue;
        total += contentLength(msg.content);
    }
    return total;
}
const DECAY_MARKER = '[decayed]';
function summariseToolResult(msg) {
    const raw = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    const sizeKb = (raw.length / 1024).toFixed(1);
    let verdict = '';
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            verdict = parsed.success === false
                ? ` failed: ${String(parsed.error || '').slice(0, 160)}`
                : ' succeeded';
        }
    }
    catch {
        verdict = '';
    }
    const pointer = buildDecayPointer({ path: msg.spillPath });
    const fallback = ' Re-run the tool or read the specific file/lines again if you still need it.';
    return `${DECAY_MARKER} ${msg.name || 'tool'}${verdict}. Output (${sizeKb} KB) was cleared to protect the context window.${pointer || fallback}`;
}
export function decayToolResults(messages, options = {}) {
    const keepRecent = Number.isInteger(options.keepRecent) ? options.keepRecent : 8;
    const minChars = Number.isInteger(options.minChars) ? options.minChars : 600;
    const keepMediaRecent = Number.isInteger(options.keepMediaRecent) ? options.keepMediaRecent : 2;
    let reclaimed = 0;
    let toolsSeen = 0;
    let mediaSeen = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (!msg)
            continue;
        if (msg.role === 'tool') {
            toolsSeen++;
            if (toolsSeen <= keepRecent)
                continue;
            const original = contentLength(msg.content);
            if (original < minChars)
                continue;
            if (typeof msg.content === 'string' && msg.content.startsWith(DECAY_MARKER))
                continue;
            msg.content = summariseToolResult(msg);
            reclaimed += original - msg.content.length;
            continue;
        }
        if (Array.isArray(msg.content)) {
            const hasMedia = msg.content.some((block) => block && (block.type === 'image' || block.type === 'image_url' || block.type === 'input_audio'));
            if (!hasMedia)
                continue;
            mediaSeen++;
            if (mediaSeen <= keepMediaRecent)
                continue;
            const original = contentLength(msg.content);
            const captions = msg.content
                .filter((block) => block && block.type === 'text' && block.text)
                .map((block) => String(block.text))
                .join(' ');
            msg.content = `${DECAY_MARKER} media attachment cleared to protect the context window. ${captions}`.trim();
            reclaimed += original - msg.content.length;
        }
    }
    return reclaimed;
}
export function buildWindow(messages, maxCharPool) {
    const window = [];
    let characterCount = 0;
    let splitIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (!msg)
            continue;
        const length = contentLength(msg.content);
        if (characterCount + length > maxCharPool) {
            splitIndex = i;
            break;
        }
        characterCount += length;
        window.unshift(msg);
    }
    if (window.length === 0 && messages.length > 0) {
        const last = messages[messages.length - 1];
        const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content ?? '');
        window.push({
            ...last,
            content: text.length > maxCharPool
                ? text.slice(0, Math.max(0, maxCharPool - 80)) + '\n[truncated: this single message exceeded the whole context budget]'
                : text
        });
        splitIndex = messages.length - 1;
    }
    while (window.length > 1 && window[0]?.role === 'tool') {
        window.shift();
    }
    const last = window[window.length - 1];
    if (last && last.role === 'assistant' && last.tool_calls && last.tool_calls.length > 0) {
        delete last.tool_calls;
    }
    return { window, splitIndex };
}
export function compactInPlace(messages, splitIndex, summaryText) {
    const start = 1;
    const end = splitIndex;
    if (end < start)
        return 0;
    const removed = end - start + 1;
    const summary = {
        role: 'user',
        content: `[COMPACTED CONTEXT SUMMARY — ${removed} earlier messages were condensed to protect the context window]\n${summaryText}`
    };
    messages.splice(start, removed, summary);
    return removed - 1;
}
export function describeDroppedMessages(dropped) {
    const toolCalls = new Map();
    let userTurns = 0;
    for (const msg of dropped) {
        if (msg.role === 'tool' && msg.name) {
            toolCalls.set(msg.name, (toolCalls.get(msg.name) || 0) + 1);
        }
        else if (msg.role === 'user') {
            userTurns++;
        }
    }
    const tools = [...toolCalls.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([name, count]) => `${name}x${count}`)
        .join(', ');
    const parts = [];
    if (userTurns > 0)
        parts.push(`${userTurns} earlier user turn(s)`);
    if (tools)
        parts.push(`tools used: ${tools}`);
    return parts.length > 0
        ? parts.join('. ') + '. Re-read files or re-run tools if you need those details again.'
        : 'Earlier exchange omitted.';
}
export function sanitizeSequences(messages) {
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg)
            continue;
        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
            const foundToolIds = new Set();
            let followingResults = 0;
            let j = i + 1;
            while (j < messages.length && messages[j]?.role === 'tool') {
                const tcId = messages[j]?.tool_call_id;
                if (tcId)
                    foundToolIds.add(tcId);
                followingResults++;
                j++;
            }
            const canPairPositionally = foundToolIds.size === 0 && followingResults === msg.tool_calls.length;
            if (!canPairPositionally) {
                msg.tool_calls = msg.tool_calls.filter(tc => Boolean(tc?.id && foundToolIds.has(tc.id)));
            }
            if (msg.tool_calls.length === 0) {
                delete msg.tool_calls;
                if (!msg.content || typeof msg.content !== 'string' || msg.content.trim() === '') {
                    msg.content = '[Action initiated and completed]';
                }
            }
        }
    }
    let validToolBlock = false;
    let activeToolIds = new Set();
    let positionalRemaining = 0;
    const clean = [];
    for (const msg of messages) {
        if (!msg)
            continue;
        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
            validToolBlock = true;
            activeToolIds = new Set(msg.tool_calls.map(tc => tc && tc.id).filter((id) => Boolean(id)));
            positionalRemaining = activeToolIds.size === 0 ? msg.tool_calls.length : 0;
            clean.push(msg);
        }
        else if (msg.role === 'tool') {
            if (validToolBlock) {
                if (msg.tool_call_id && activeToolIds.has(msg.tool_call_id)) {
                    activeToolIds.delete(msg.tool_call_id);
                    clean.push(msg);
                }
                else if (!msg.tool_call_id && positionalRemaining > 0) {
                    positionalRemaining--;
                    clean.push(msg);
                }
            }
        }
        else {
            validToolBlock = false;
            activeToolIds.clear();
            positionalRemaining = 0;
            clean.push(msg);
        }
    }
    return clean;
}
export const STAGE1_BUDGET_THRESHOLD = 0.70;
export const STAGE2_SNIP_CHARS = 60000;
export const STAGE2_SNIP_HEAD = 20000;
export const STAGE2_SNIP_TAIL = 10000;
export const STAGE4_COLLAPSE_THRESHOLD = 0.85;
export function snipOversizedToolOutputs(messages, options = {}) {
    const threshold = options.threshold || STAGE2_SNIP_CHARS;
    const headChars = options.headChars || STAGE2_SNIP_HEAD;
    const tailChars = options.tailChars || STAGE2_SNIP_TAIL;
    let snippedCount = 0;
    let reclaimedChars = 0;
    for (const msg of messages) {
        if (msg.role !== 'tool' && !msg.tool_call_id)
            continue;
        if (typeof msg.content !== 'string')
            continue;
        const len = msg.content.length;
        if (len > threshold) {
            const removed = len - (headChars + tailChars);
            const head = msg.content.slice(0, headChars);
            const tail = msg.content.slice(-tailChars);
            const pointer = msg.spillPath ? ` Full output preserved at: ${msg.spillPath}.` : '';
            msg.content = `${head}\n\n[... SNIPPED ${removed.toLocaleString()} CHARS (${Math.round(removed / CHARS_PER_TOKEN).toLocaleString()} TOKENS) TO PREVENT CONTEXT OVERFLOW.${pointer} Use targeted file reads to inspect specific sections ...] \n\n${tail}`;
            snippedCount++;
            reclaimedChars += (len - msg.content.length);
        }
    }
    return { snippedCount, reclaimedChars };
}
export function microcompactText(text) {
    if (typeof text !== 'string')
        return text;
    return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
}
export function applyProgressiveCompaction(messages, maxCharPool, options = {}) {
    let totalReclaimed = 0;
    const stagesFired = [];
    if (options.enableEphemeralDecay) {
        const ephemeralKeepRecent = options.ephemeralKeepRecent ?? 3;
        const ephemeralMinChars = options.ephemeralMinChars ?? 1200;
        const ephemeralReclaimed = decayToolResults(messages, {
            keepRecent: ephemeralKeepRecent,
            minChars: ephemeralMinChars
        });
        if (ephemeralReclaimed > 0) {
            totalReclaimed += ephemeralReclaimed;
            stagesFired.push(`ephemeral_decay:${(ephemeralReclaimed / 1024).toFixed(1)}kb`);
        }
    }
    const snipRes = snipOversizedToolOutputs(messages, options.snipOptions);
    if (snipRes.snippedCount > 0) {
        totalReclaimed += snipRes.reclaimedChars;
        stagesFired.push(`snip:${snipRes.snippedCount}_tools`);
    }
    let currentChars = measureMessages(messages);
    const ratio = maxCharPool > 0 ? currentChars / maxCharPool : 0;
    if (ratio >= STAGE1_BUDGET_THRESHOLD) {
        stagesFired.push(`budget_reduction:${(ratio * 100).toFixed(0)}%`);
        for (const msg of messages) {
            if (msg.role === 'tool' && typeof msg.content === 'string') {
                const origLen = msg.content.length;
                msg.content = microcompactText(msg.content);
                totalReclaimed += (origLen - msg.content.length);
            }
        }
        const decayReclaimed = decayToolResults(messages, {
            keepRecent: options.budgetKeepRecent ?? 4,
            minChars: 300
        });
        totalReclaimed += decayReclaimed;
    }
    currentChars = measureMessages(messages);
    const updatedRatio = maxCharPool > 0 ? currentChars / maxCharPool : 0;
    if (updatedRatio >= STAGE4_COLLAPSE_THRESHOLD) {
        stagesFired.push(`context_collapse:${(updatedRatio * 100).toFixed(0)}%`);
        const collapseReclaimed = decayToolResults(messages, {
            keepRecent: options.collapseKeepRecent ?? 2,
            minChars: 200,
            keepMediaRecent: 0
        });
        totalReclaimed += collapseReclaimed;
    }
    const finalChars = measureMessages(messages);
    return {
        totalReclaimed,
        stagesFired,
        finalChars,
        finalRatio: maxCharPool > 0 ? finalChars / maxCharPool : 0
    };
}
