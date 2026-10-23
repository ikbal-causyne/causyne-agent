// Sanitizer for cross-agent prompt wrappers and verbose tool dumps.
// Authorship: Strict TypeScript (Causyne Agent).
/** Strip bulky system wrapper tags and metadata blocks from user prompt. */
export function cleanUserText(text) {
    if (!text)
        return '';
    let str = String(text);
    str = str.replace(/<\/?USER_REQUEST>/gi, '');
    if (str.includes('<ADDITIONAL_METADATA>')) {
        str = str.split(/<ADDITIONAL_METADATA>/i)[0] || '';
    }
    if (str.includes('<environment_context>')) {
        const parts = str.split(/<\/environment_context>/i);
        if (parts.length > 1) {
            str = parts.slice(1).join('\n');
        }
    }
    if (str.includes('<causyne_universal_skills>')) {
        const parts = str.split(/<\/causyne_universal_skills>/i);
        if (parts.length > 1) {
            str = parts.slice(1).join('\n');
        }
    }
    if (str.includes('## My request:')) {
        const parts = str.split('## My request:');
        if (parts.length > 1) {
            str = parts.slice(1).join('\n');
        }
    }
    // Remove common internal system instruction blocks if embedded inside user turn
    str = str.replace(/\[System Instructions\][\s\S]*?(?=\[User\]|\n\n[a-zA-Z0-9]|$)/gi, '');
    const lines = str
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0);
    return lines.join('\n').trim();
}
/** Summarize and truncate excessive tool dump text while preserving answer & rationale. */
export function cleanAssistantText(text, maxChars = 2000) {
    if (!text)
        return '';
    const str = String(text).trim();
    if (str.length <= maxChars) {
        return str;
    }
    const half = Math.floor(maxChars / 2);
    return `${str.slice(0, half)}\n\n... [output condensed for context efficiency] ...\n\n${str.slice(-half)}`;
}
/** Extract a clean, meaningful title from the first user request. */
export function deriveSessionTitle(firstPrompt, fallback = 'Untitled Session') {
    const clean = cleanUserText(firstPrompt).replace(/\s+/g, ' ').trim();
    if (!clean)
        return fallback;
    return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean;
}
