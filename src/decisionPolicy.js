const ARCHITECTURE_TERMS = [
    'architecture', 'arsitektur',
    'framework', 'runtime', 'database', 'storage', 'authentication', 'authorization',
    'deployment', 'hosting', 'protocol', 'plugin system', 'sandbox', 'license',
    'typescript', 'javascript', 'python', 'rust', 'kotlin', 'swift'
];
const CHANGE_TERMS = [
    'change', 'replace', 'switch', 'choose', 'decide', 'redesign', 'restructure',
    'rewrite', 'rebuild', 'migration', 'migrate'
];
const EXPLICIT_CHOICE_PATTERNS = [
    /\b(?:i|we)\s+(?:choose|chose|selected?|decided? (?:on|to use))\s+[a-z0-9@._+-]+/i,
    /\b(?:must use|will use|switch to|rewrite (?:to|in)|migrate to)\s+[a-z0-9@._+-]+/i,
    /^(?:please\s+)?(?:use|choose)\s+[a-z0-9@._+-]+/i,
    /\b(?:do not|don't)\s+use\s+[a-z0-9@._+-]+/i
];
const MUTATING_TOOLS = new Set([
    'fs_write', 'fs_edit', 'MultiEdit', 'fs_delete', 'fs_move', 'sysRun', 'sysRunBg',
    'gitOp', 'manage_local_dependencies', 'plugin_manage', 'tool_forge', 'plugins_factory', 'create_skill',
    'write_file', 'write_to_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content',
    'write', 'edit', 'multiedit', 'bash', 'terminal', 'execute', 'run_command', 'run'
]);
function splitCommandSegments(command) {
    const segments = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let escape = false;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (escape) {
            current += ch;
            escape = false;
            continue;
        }
        if (ch === '\\') {
            escape = true;
            current += ch;
            continue;
        }
        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
            current += ch;
            continue;
        }
        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            current += ch;
            continue;
        }
        if (!inSingle && !inDouble) {
            if (ch === ';') {
                if (current.trim())
                    segments.push(current.trim());
                current = '';
                continue;
            }
            if (ch === '&' && command[i + 1] === '&') {
                if (current.trim())
                    segments.push(current.trim());
                current = '';
                i++;
                continue;
            }
            if (ch === '|' && command[i + 1] === '|') {
                if (current.trim())
                    segments.push(current.trim());
                current = '';
                i++;
                continue;
            }
        }
        current += ch;
    }
    if (current.trim())
        segments.push(current.trim());
    return segments;
}
const READ_ONLY_CMD_REGEX = /^\s*(?:(?:pwd|ls|find|rg|grep|cat|sed|awk|head|tail|wc|diff|file|stat|which|whereis|type|du|df|pdfinfo|pdftotext|identify|mediainfo|ffprobe|otool|readelf|nm|ps|lsof|top|uptime|whoami|id|uname|env|printenv|echo|printf|pytest)\b|git\s+(?:status|diff|log|show|branch|tag|remote|rev-parse|describe)\b|npm\s+(?:view|audit|test|ls|list|explain|run\s+(?:test|check|lint|typecheck|verify))\b|pnpm\s+(?:test|view|audit|ls|list|run\s+(?:test|check|lint|typecheck|verify))\b|yarn\s+(?:test|audit|list|run\s+(?:test|check|lint|typecheck|verify))\b|bun\s+(?:test|pm)\b|npx\s+(?:jest|vitest|mocha|ava|playwright\s+test|cypress\s+run|tsc\s+--noEmit)\b|tsc\s+--noEmit\b|node\s+(?:--check|--test|-e\b|--eval\b|-p\b|--print\b|.*?(?:test|spec|verify|check))|(?:python3?|py)\s+(?:-m\s+(?:unittest|pytest|doctest|py_compile)|-c\b|.*?(?:test|spec|verify))|cargo\s+(?:test|check)\b|go\s+test\b|curl\s+(?:-I|-sI|-s\b|--head)\b)/i;
export function isReadOnlyShellCommand(command) {
    const trimmed = command.trim();
    if (!trimmed)
        return true;
    const segments = splitCommandSegments(trimmed);
    return segments.length > 0 && segments.every(seg => {
        const s = seg.trim();
        if (!s)
            return true;
        const stripped = s.replace(/^(?:[a-zA-Z_][a-zA-Z0-9_]*=[^\s]+\s+)+/, '');
        return READ_ONLY_CMD_REGEX.test(stripped);
    });
}
function containsAny(text, terms) {
    return terms.some(term => text.includes(term));
}
export function assessDecisionRequirement(prompt) {
    const raw = String(prompt ?? '').trim();
    const text = raw.toLowerCase();
    const architectural = containsAny(text, ARCHITECTURE_TERMS);
    const change = containsAny(text, CHANGE_TERMS);
    const alternatives = /\b(?:or|versus|vs\.?)\b/i.test(raw);
    const asksForChoice = /\b(?:which|what should|should we)\b/i.test(raw);
    const delegatesBroadRedesign = /\b(?:redesign|restructure)\s+(?:the\s+)?(?:architecture|system|runtime|database)\b/i.test(raw);
    const explicit = EXPLICIT_CHOICE_PATTERNS.some(pattern => pattern.test(raw));
    if (!architectural || explicit || (!alternatives && !asksForChoice && !(change && delegatesBroadRedesign))) {
        return { required: false, kind: 'architecture', reason: '' };
    }
    return {
        required: true,
        kind: 'architecture',
        reason: 'The request reaches a durable architecture boundary with more than one plausible implementation.'
    };
}
export function requiresImplementationPlan(prompt, archetype = '', confidence = '') {
    const text = String(prompt ?? '').toLowerCase();
    // A classifier can label any "create" request build_app. A single plain
    // text/data-file operation needs no checklist or rejected mutation round trip.
    const namedFiles = new Set([...text.matchAll(/\b[\w./-]+\.(?:txt|md|csv|json)\b/g)].map(match => match[0]));
    const simpleFileOperation = text.length < 700 && namedFiles.size === 1
        && /\b(?:create|write|save)\b/.test(text)
        && !/\b(?:research|search|scrap\w*|codebase|migrat\w*|refactor|integrat\w*|application|website|database|security|authentication|authorization|framework|architecture|runtime)\b/.test(text)
        && !/\b(?:package(?:-lock)?\.json|tsconfig\w*\.json|permissions?\.json|policy\.json)\b/.test(text);
    if (simpleFileOperation)
        return false;
    if (archetype === 'build_app' || archetype === 'integrate')
        return true;
    if (confidence === 'high' && /\b(?:implement|build|create|migrate|rewrite|refactor|integrate)\b/i.test(text)) {
        return true;
    }
    return containsAny(text, ARCHITECTURE_TERMS) && containsAny(text, CHANGE_TERMS);
}
export function isMutatingToolCall(toolName, args = {}) {
    if (toolName === 'creative_apps') {
        return (args.action !== 'status' &&
            args.action !== 'verify_bridge' &&
            !(args.action === 'live_bridge' && args.liveOperation === 'inspect_active'));
    }
    if (toolName === 'native_engine')
        return !['status', 'catalog', 'describe', 'inspect', 'probe'].includes(String(args.action ?? ''));
    if (MUTATING_TOOLS.has(toolName)) {
        if (['sysRun', 'sysRunBg', 'bash', 'terminal', 'execute', 'sh', 'zsh', 'run_command', 'run'].includes(toolName)) {
            const command = String(args.CommandLine ?? args.commandLine ?? args.command ?? args.cmd ?? args.script ?? args.code ?? '');
            return !isReadOnlyShellCommand(command);
        }
        if (toolName === 'gitOp') {
            const action = String(args.action ?? args.command ?? args.operation ?? '');
            return !/^(?:status|diff|log|show|branch|remote)$/i.test(action.trim());
        }
        return true;
    }
    if (toolName.startsWith('plugin__') || toolName.startsWith('mcp__'))
        return false;
    return false;
}
