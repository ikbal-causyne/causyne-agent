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
    'gitOp', 'manage_local_dependencies', 'plugin_manage', 'tool_forge', 'create_skill'
]);
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
    if (archetype === 'build_app' || archetype === 'integrate')
        return true;
    if (confidence === 'high' && /\b(?:implement|build|create|migrate|rewrite|refactor|integrate)\b/i.test(text)) {
        return true;
    }
    return containsAny(text, ARCHITECTURE_TERMS) && containsAny(text, CHANGE_TERMS);
}
export function isMutatingToolCall(toolName, args = {}) {
    if (toolName === 'creative_apps')
        return args.action !== 'status';
    if (toolName === 'native_engine')
        return !['status', 'catalog', 'describe', 'inspect', 'probe'].includes(String(args.action ?? ''));
    if (MUTATING_TOOLS.has(toolName)) {
        if (toolName === 'sysRun' || toolName === 'sysRunBg') {
            const command = String(args.command ?? '');
            return !/^\s*(?:pwd|ls|find|rg|grep|cat|sed|head|tail|git\s+(?:status|diff|log|show)|npm\s+(?:view|audit|test)|node\s+--check)\b/i.test(command);
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
