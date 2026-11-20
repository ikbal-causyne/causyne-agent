/**
 * Causyne Agent — Prompt Intent & Response Classification Helpers (Sector 3)
 *
 * Extracted from `AgentLoop` into a cohesive Strict TypeScript module.
 * Re-exported from `src/agentLoop.ts` for full backward compatibility.
 */
import { isDirectGameTask as isDirectGameTaskDecision } from '../decideTools.js';
import { isNoExecutionPrompt, isReadOnlyOrExplanatoryPrompt } from '../launchIntent.js';
export function isActionableTaskPrompt(text) {
    const t = (text || '').trim();
    if (!t)
        return false;
    // A no-execution request can be satisfied by analysis without mandatory tool calls.
    if (isNoExecutionPrompt(t))
        return false;
    const pureGreeting = /^(hi|hello|hey|yo|halo|hai|p|assalamu['a]?[l]?aikum|good\s+(morning|afternoon|evening))[.!?, ]*$/i.test(t);
    if (pureGreeting)
        return false;
    const actionKeywords = /\b(continue|resume|proceed|lanjut\w*|create|build|make|write|code|implement|fix|optimize|refactor|generate|add|setup|install|run|open|launch|start|play|serve|preview|deploy|delete|remove|update|change|test|review|inspect|search|find|download|buat\w*|bikin\w*|perbaik\w*|tambah\w*|ubah\w*|hapus\w*|jalan\w*|pasang\w*|analis\w*|cek\w*|rancang\w*|desain\w*|kerjakan\w*|tolong\w*|bantu\w*|ganti\w*|tulis\w*|kembangkan\w*)\b/i;
    if (actionKeywords.test(t))
        return true;
    return false; // Length alone does not turn an information question into an execution order.
}
export function isGenericHandoffResponse(text) {
    const answer = (text || '').trim();
    if (!answer || answer.length > 500)
        return false;
    const lower = answer.toLowerCase();
    const handoff = /\b(let me know what you would like to do next|what would you like me to do next|how (can|may) i help|what can i help you with|feel free to (ask|tell me))\b/i.test(lower);
    const verifiedOutcome = /\b(completed|changed|set the (desktop|wallpaper)|saved|created|installed|verified|downloaded|finished)\b/i.test(lower);
    return handoff && !verifiedOutcome;
}
export function isDesktopWallpaperChangePrompt(text) {
    const t = (text || '').trim();
    if (!t)
        return false;
    // Explanatory questions or prompts that explicitly forbid execution are never wallpaper mutation requests
    if (isNoExecutionPrompt(t) || isReadOnlyOrExplanatoryPrompt(t))
        return false;
    if (/^(?:why|how|what|does|can\s+you\s+explain|explain|tell\s+me|show\s+me\s+how)\b/i.test(t))
        return false;
    if (/\b(?:why|how)\s+does\b/i.test(t))
        return false;
    // Debugging wallpaper-related source or regexes is not a request to mutate macOS.
    if (/\b(?:test|review|audit|analy[sz]e|debug|refactor|inspect|explain|write|implement)\b[\s\S]{0,140}\b(?:regex|code|source|logic|verification|readback|function|script|test)\b/i.test(t))
        return false;
    return /\b(?:change|set|switch|replace)\s+(?:(?:my|the|this|current|desktop|mac|macos)\s+){0,4}(?:desktop picture|wallpaper|desktop background)\b/i.test(t);
}
export function isExecutionOrLaunchTaskPrompt(text) {
    const t = (text || '').trim();
    if (!t)
        return false;
    return /\b(open|launch|start|run|play|serve|preview)\b/i.test(t)
        && !/\b(create|build|make|write|code|implement|generate|refactor)\b/i.test(t);
}
export function isCodeAuthoringTaskPrompt(text) {
    const t = (text || '').trim();
    if (!t)
        return false;
    if (isExecutionOrLaunchTaskPrompt(t))
        return false;
    return /\b(create|build|make|write|code|implement|generate|game|3js|three?\.?js|three?js|app)\b/i.test(t);
}
export function extractSkillIdFromPrompt(prompt) {
    const text = String(prompt || '').trim();
    if (!text)
        return '';
    const stopWords = new Set([
        'the', 'a', 'an', 'this', 'that', 'from', 'in', 'with',
        'using', 'for', 'to', 'by', 'and', 'or', 'of'
    ]);
    const leadingTrim = new Set(['`', '"', "'", '(', '[']);
    const trailingTrim = new Set(['`', '"', "'", ')', ',', '.', ';', ':', '!', '?', ']', '\\']);
    const cleanCandidate = (raw) => {
        const trimmed = raw.trim();
        let start = 0;
        let end = trimmed.length;
        while (start < end && leadingTrim.has(trimmed[start]))
            start++;
        while (end > start && trailingTrim.has(trimmed[end - 1]))
            end--;
        const stripped = trimmed.slice(start, end);
        if (!stripped || stopWords.has(stripped.toLowerCase()))
            return '';
        if (/^(?:fs_read_skill|fs_read_skil|read_skill|read_skil|tool_search)$/i.test(stripped)) {
            return '';
        }
        return stripped;
    };
    const isFileExt = (candidate) => /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|json|html|css|gradle|apk|aab|dex)$/i.test(candidate);
    const cuedSlashMatch = text.match(/(?:\bskill_id|\bskill|\bfs_read_skil{1,2})(?:\s*[:=]\s*|\s+)[`"']?([a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,120})[`"']?/i);
    if (cuedSlashMatch?.[1]) {
        const candidate = cleanCandidate(cuedSlashMatch[1]);
        if (candidate && !isFileExt(candidate)) {
            return candidate;
        }
    }
    for (const m of text.matchAll(/\b([a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,120})\b/g)) {
        const candidate = cleanCandidate(m[1] || '');
        if (candidate && !isFileExt(candidate)) {
            return candidate;
        }
    }
    const explicitQuotedMatch = text.match(/(?:\bskill_id|\bskill)(?:\s*[:=]\s*|\s+)(?:the\s+)?[`"']([^`"'\n\r]{2,120})[`"']/i);
    if (explicitQuotedMatch?.[1]) {
        const candidate = cleanCandidate(explicitQuotedMatch[1]);
        if (candidate)
            return candidate;
    }
    const bareMatch = text.match(/(?:\bskill_id\s*[:=]\s*|\bskill\s*[:=]\s*|\bskill\s+(?:called\s+|named\s+)?)([a-zA-Z0-9][a-zA-Z0-9_.-]{1,120})/i);
    if (bareMatch?.[1]) {
        const candidate = cleanCandidate(bareMatch[1]);
        if (candidate)
            return candidate;
    }
    return '';
}
export function isDirectGameTask(text) {
    return isDirectGameTaskDecision(text);
}
export function isProviderPlanOrQuotaRefusal(text) {
    if (!text || typeof text !== 'string')
        return false;
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 320)
        return false;
    if (/^upgrade your plan to continue\.?$/i.test(trimmed))
        return true;
    return /\b(upgrade your plan to continue|insufficient[_ ]quota|credit balance is too low|billing hard limit|quota exceeded for|plan limit reached|subscription required to continue)\b/i.test(trimmed);
}
/**
 * Detects when an agent response is an intermediate mid-task progress note or
 * transition announcement rather than a finished answer.
 */
export function isMidTaskProgressText(text) {
    if (!text || typeof text !== 'string')
        return false;
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 480)
        return false;
    const lower = trimmed.toLowerCase();
    if (lower.includes('?') ||
        lower.includes('let me know') ||
        lower.includes('how can i help') ||
        lower.includes('how may i help') ||
        lower.includes('how can i assist') ||
        lower.includes('what would you like') ||
        lower.includes('what can i help') ||
        lower.includes('feel free to')) {
        return false;
    }
    if (trimmed.includes('```'))
        return false;
    const sentences = trimmed
        .split(/(?:(?<=[.!])\s+|\n+)/)
        .map(s => s.trim())
        .filter(Boolean);
    const lastSentence = (sentences[sentences.length - 1] || trimmed).trim();
    const lastLower = lastSentence.toLowerCase();
    if (trimmed.length <= 280 && (trimmed.endsWith(':') || trimmed.endsWith('...') || trimmed.endsWith('…'))) {
        return true;
    }
    const intentPrefixes = [
        'let me ',
        "i'll ",
        'i will ',
        'now i ',
        'now let me ',
        "now i'll ",
        'now i will ',
        'next, i ',
        'next i ',
        "next, i'll ",
        "next i'll ",
        'first, i ',
        'first i ',
        'let us ',
        "let's ",
        'i shall ',
        'we will ',
        "we'll ",
        'i am going to ',
        "i'm going to ",
        'going to '
    ];
    if (intentPrefixes.some(prefix => lastLower.startsWith(prefix) || (trimmed.length <= 280 && lower.startsWith(prefix)))) {
        if (!/\b(?:task completed|all done|everything is ready|finished|complete\.)\b/i.test(lastSentence)) {
            return true;
        }
    }
    const gerundStart = /^(?:now\s+|next,?\s+|currently\s+|still\s+)?(?:writing|pulling|checking|inspecting|building|creating|updating|applying|implementing|generating|fetching|downloading|testing|running|fixing|setting up|configuring|refactoring|adding|modifying|replacing|launching|starting|verifying|confirming|reading|searching|analyzing|preparing|compiling|rendering|extracting|installing|opening|switching|retrying|continuing)\b/i;
    if (gerundStart.test(lastSentence) && lastSentence.length <= 220) {
        return true;
    }
    const actionNowSuffix = /\b(?:writing|pulling|checking|inspecting|building|creating|updating|applying|implementing|generating|fetching|downloading|testing|running|fixing|configuring|refactoring|adding|modifying|replacing|launching|starting|verifying|confirming|reading|searching|analyzing|preparing|compiling|rendering|extracting)\b[^.!?\n]{1,120}\b(?:now|next)\.?$/i;
    if (actionNowSuffix.test(lastSentence)) {
        return true;
    }
    return false;
}
