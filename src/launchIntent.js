const CREATIVE_WORDS = /\b(?:story|novel|fiction|narrative|lore|essay|poem|poetry|chapter|character|plot|dialogue|scene|cerita|kisah|dongeng|karangan|buku|tulisan|bab|paragraf|halaman)\b/i;
const INQUIRY_WORDS = /\b(?:explain|why|what|how|who|where|when|analyze|describe|tell\s+me|show\s+me\s+how|difference|summary|summarize|review|audit|jelaskan|kenapa|mengapa|bagaimana|siapa|apakah|analisis)\b/i;
const CHANGE_VERBS = /\b(?:create|build|make|write|edit|fix|modify|change|update|implement|generate|refactor|delete|remove|install|deploy|add|append|expand|continue|improve|refine|compose|draft|author|design|buat(?:kan)?|bikin|tulis(?:kan)?|ubah|ganti|perbaiki|tambah(?:kan)?|kembangkan|lanjut(?:kan)?|sambung(?:kan)?|membaut|maembuat|merancang|susun|crear|escribir|construir|modificar|actualizar|créer|écrire|modifier|erstellen|schreiben|bauen)\b/i;
const NON_LAUNCH_PHRASES = /\b(?:(?:run|runs|running)\s+(?:by|on|in|with|out|through)|(?:play|plays|playing)\s+(?:a\s+role|with)|(?:open|opens|opening)\s+(?:to|world|source|mind|ended|door)|(?:start|starts|starting)\s+(?:with|from)|(?:serve|serves|serving)\s+(?:as|to)|in\s+the\s+long\s+run|home\s+run)\b/i;
const IMPERATIVE_LAUNCH = /^\s*(?:please\s+|can\s+you\s+)?(?:open|launch|start|run|play|serve|preview)(?:\s+(?:it|this|that|app|application|project|game|server|service|dev|preview|up|now|here|locally))?\s*[.!?]?\s*$/i;
const TARGETED_LAUNCH = /\b(?:open|launch|start|run|play|serve|preview)\s+(?:up\s+)?(?:the\s+|this\s+|an?\s+)?(?:app|application|project|game|server|dev\s+server|website|site|page|ui|preview|demo|localhost|frontend|backend)\b/i;
const URL_OR_FILE_LAUNCH = /^\s*(?:open|preview)\s+(?:https?:\/\/|\/|~\/|\.\/|[a-zA-Z0-9_\-\.\/]+\.(?:html|htm|php|py|js|ts))\b/i;
const BROWSER_LAUNCH = /\b(?:open|view)\s+(?:in\s+)?(?:browser|chrome|safari)\b/i;
const SERVER_COMMAND = /^\s*(?:python(?:3(?:\.\d+)?)?\s+(?:-u\s+)?(?:\S*\/)?server\.py\b|python(?:3(?:\.\d+)?)?\s+-m\s+http\.server\b|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)\b|(?:npx|bunx)\s+(?:vite|next\s+dev|http-server)\b|uvicorn\b|gunicorn\b|flask\s+run\b)/i;
const READ_ONLY_COMMAND = /^\s*(?:pwd|ls|rg|grep|cat|head|tail|find|which|where|ps|pgrep|lsof|netstat|ss|git\s+(?:status|diff|log|show)|node\s+(?:-v|--version)|python(?:3(?:\.\d+)?)?\s+(?:-V|--version))\b/i;
// Some inspection executables have flags that write files or execute commands.
const MUTATING_INSPECTION_OPTIONS = /(?:^|\s)(?:-delete|-exec(?:dir)?|-ok(?:dir)?|-fprint(?:f|0)?|-fprintf|-fls)(?=\s|$)|(?:^|\s)--(?:output|pre)(?==|\s|$|-)/i;
const OPEN_COMMAND = /^\s*(?:open|xdg-open|start)\s+\S+/i;
const LOCAL_HEALTH_CHECK = /^\s*curl\b[^;&|><`$()]*https?:\/\/(?:localhost|127\.0\.0\.1):\d+(?:\/\S*)?\s*$/i;
export const MUTATION_TOOLS = new Set([
    'fs_write', 'fs_edit', 'fs_delete', 'fs_move',
    'multi_edit', 'MultiEdit', 'edit_file', 'write_to_file', 'delete_file',
    'create_skill', 'manage_local_dependencies', 'skill_create', 'memory_write', 'archive', 'tool.forge', 'proc.term'
]);
const NO_EXECUTION_PHRASES = /\b(?:don'?t|do\s+not|never|without)\s+(?:execute|run|modify|mutate|apply|touch|write|change|edit|delete)\b|\b(?:no|without)\s+(?:execution|tools?|actions?)\b|\bjust\s+explain\b|\bread[\s-]only\b/i;
export function isNoExecutionPrompt(prompt) {
    if (!prompt || typeof prompt !== 'string')
        return false;
    return NO_EXECUTION_PHRASES.test(prompt);
}
export function isReadOnlyOrExplanatoryPrompt(prompt) {
    if (!prompt || typeof prompt !== 'string')
        return false;
    const trimmed = prompt.trim();
    if (trimmed.length === 0)
        return false;
    if (isNoExecutionPrompt(trimmed))
        return true;
    if (!INQUIRY_WORDS.test(trimmed))
        return false;
    // Questions about *how to modify* are still requests for information.
    if (/^(?:please\s+)?(?:how|why|what|where|when|who)\b/i.test(trimmed))
        return true;
    if (/^(?:please\s+)?(?:explain|describe|summarize|analy[sz]e|review|tell\s+me)\b/i.test(trimmed)) {
        const followUp = /\b(?:and|then|also|afterwards)\s+(?:please\s+)?(.+)/i.exec(trimmed)?.[1] ?? '';
        if (!CHANGE_VERBS.test(followUp) && !/^(?:run|execute|test|launch|open|start)\b/i.test(followUp))
            return true;
    }
    // An inquiry that also commands implementation must not be forced read-only.
    if (CHANGE_VERBS.test(trimmed))
        return false;
    return true;
}
const READ_ONLY_GIT_COMMAND = /^(?:status|diff|log|show|rev-parse|ls-files)(?=\s|$)/i;
const RISKY_GIT_INSPECTION_OPTIONS = /(?:^|\s)--(?:ext-diff|textconv|config-env)(?=\s|$|=)/i;
function isGitInspectionCommand(rawCommand) {
    const command = String(rawCommand ?? '').trim();
    return READ_ONLY_GIT_COMMAND.test(command)
        && !hasShellControlOperators(command)
        && !MUTATING_INSPECTION_OPTIONS.test(command)
        && !RISKY_GIT_INSPECTION_OPTIONS.test(command);
}
/** Enforces scope boundaries when the user's intent is explanatory or forbids execution. */
export function readOnlyScopeError(tool, args, prompt) {
    const p = prompt || '';
    const noExecution = isNoExecutionPrompt(p);
    if (noExecution) {
        if (tool === 'fs_read' || tool === 'doc_read')
            return null;
        return 'The user explicitly requested an explanation without action execution; modifying files or executing commands is not authorized.';
    }
    if (isReadOnlyOrExplanatoryPrompt(p)) {
        if (MUTATION_TOOLS.has(tool) || tool === 'desktop_act' || tool === 'computer_use') {
            return 'The user requested an explanation/read-only inquiry, not workspace modifications or desktop actions.';
        }
        if (tool === 'plugin.manager' && String(args.action ?? '').toLowerCase() !== 'list') {
            return 'A read-only inquiry does not authorize modifying installed plugins.';
        }
        if (tool === 'gitOp') {
            return isGitInspectionCommand(args.command)
                ? null
                : 'A read-only inquiry authorizes inspection of Git status and history, not repository mutations.';
        }
        if (tool === 'sysRun' || tool === 'sysRunBg' || tool === 'terminal_persistent_shell') {
            const command = String(args.command ?? args.input ?? '').trim();
            if (READ_ONLY_COMMAND.test(command) && !MUTATING_INSPECTION_OPTIONS.test(command) && !/[;&|><`$()]/.test(command)) {
                return null;
            }
            return 'A read-only inquiry authorizes only non-mutating status inspection commands (e.g. pwd, git status, cat), not arbitrary execution.';
        }
    }
    return null;
}
export function isLaunchOnlyPrompt(prompt) {
    if (!prompt || typeof prompt !== 'string')
        return false;
    const trimmed = prompt.trim();
    if (trimmed.length === 0)
        return false;
    if (trimmed.split(/\s+/).length > 25 || trimmed.length > 150)
        return false;
    if (/\b(?:run|execute)\s+(?:the\s+)?(?:tests?|checks?|lint|benchmarks?|scripts?|commands?|tools?|creative_apps|resolve_act|memory_recall|native_engine|browser_act|fs_read|sysRun)\b/i.test(prompt))
        return false;
    if (/\b(?:verify|verification|verify_bridge|inspectActive|simulate|probe|audit|analyze|diagnose)\b/i.test(prompt))
        return false;
    if (CREATIVE_WORDS.test(prompt))
        return false;
    if (INQUIRY_WORDS.test(prompt))
        return false;
    if (CHANGE_VERBS.test(prompt))
        return false;
    if (NON_LAUNCH_PHRASES.test(prompt))
        return false;
    return IMPERATIVE_LAUNCH.test(prompt)
        || TARGETED_LAUNCH.test(prompt)
        || URL_OR_FILE_LAUNCH.test(prompt)
        || BROWSER_LAUNCH.test(prompt);
}
export function isServerLaunchCommand(command) {
    return SERVER_COMMAND.test(command.trim());
}
function hasShellControlOperators(command) {
    let quote = null;
    for (let i = 0; i < command.length; i++) {
        const ch = command.charAt(i);
        if (ch === '\\') {
            if (i === command.length - 1)
                return true;
            i++;
            continue;
        }
        if (ch === '"' || ch === "'") {
            if (quote === null)
                quote = ch;
            else if (quote === ch)
                quote = null;
            continue;
        }
        // Shell substitution is active inside double quotes.
        if (ch === '`' || ch === '$' || ch === '\n' || ch === '\r')
            return true;
        if (quote === null && /[;&|><()]/.test(ch))
            return true;
    }
    return quote !== null;
}
/** A launch-only request authorizes inspection, starting the app, and opening it. */
export function launchScopeError(tool, args) {
    if (MUTATION_TOOLS.has(tool)) {
        return 'The user asked to open the existing project, not change its files or configuration.';
    }
    if (tool === 'plugin.manager' && String(args.action ?? '').toLowerCase() !== 'list') {
        return 'A launch-only request does not authorize modifying installed plugins.';
    }
        if (tool === 'gitOp') {
        return isGitInspectionCommand(args.command)
            ? null
            : 'A launch-only request allows Git inspection, not working-tree or history changes.';
    }
    if (tool === 'sysRun' || tool === 'sysRunBg' || tool === 'terminal_persistent_shell') {
        const command = String(args.command ?? args.input ?? '').trim();
        if (hasShellControlOperators(command)) {
            return 'A launch-only request does not authorize chained shell commands. Use one scoped command per tool call.';
        }
        if (OPEN_COMMAND.test(command) || isServerLaunchCommand(command) || LOCAL_HEALTH_CHECK.test(command)) {
            return null;
        }
        if (READ_ONLY_COMMAND.test(command) && !MUTATING_INSPECTION_OPTIONS.test(command)) {
            return null;
        }
        return 'A launch-only request does not authorize unrelated commands. Use read-only inspection, a background server, or desktop.open; do not run unrelated commands.';
    }
    return null;
}
