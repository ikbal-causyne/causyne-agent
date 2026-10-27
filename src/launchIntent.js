const LAUNCH_VERBS = /\b(open|launch|start|run|play|serve|preview)\b/i;
const CHANGE_VERBS = /\b(create|build|make|write|edit|fix|modify|change|update|implement|generate|refactor|delete|remove|install|deploy)\b/i;
const SERVER_COMMAND = /^\s*(?:python(?:3(?:\.\d+)?)?\s+(?:-u\s+)?(?:\S*\/)?server\.py\b|python(?:3(?:\.\d+)?)?\s+-m\s+http\.server\b|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)\b|(?:npx|bunx)\s+(?:vite|next\s+dev|http-server)\b|uvicorn\b|gunicorn\b|flask\s+run\b)/i;
const READ_ONLY_COMMAND = /^\s*(?:pwd|ls|rg|grep|cat|head|tail|find|which|where|ps|pgrep|lsof|netstat|ss|git\s+(?:status|diff|log|show)|node\s+(?:-v|--version)|python(?:3(?:\.\d+)?)?\s+(?:-V|--version))\b/i;
const OPEN_COMMAND = /^\s*(?:open|xdg-open|start)\s+\S+/i;
const LOCAL_HEALTH_CHECK = /^\s*curl\s+(?:(?:-I|-s|-S|-f|--head|--silent|--show-error|--fail|--max-time\s+\d+)\s+)*https?:\/\/(?:localhost|127\.0\.0\.1):\d+(?:\/\S*)?\s*$/i;
const PORT_CLEANUP_COMMAND = /^\s*(?:pkill|kill|fuser)\b/i;
const MUTATION_TOOLS = new Set([
    'fs_write', 'fs_edit', 'fs_delete', 'fs_move',
    'multi_edit', 'MultiEdit', 'edit_file', 'write_to_file', 'delete_file',
    'create_skill', 'manage_local_dependencies'
]);
export function isLaunchOnlyPrompt(prompt) {
    if (/\brun\s+(?:the\s+)?(?:tests?|checks?|lint|benchmarks?|scripts?|commands?)\b/i.test(prompt))
        return false;
    return LAUNCH_VERBS.test(prompt) && !CHANGE_VERBS.test(prompt);
}
export function isServerLaunchCommand(command) {
    return SERVER_COMMAND.test(command.trim());
}
/** A launch-only request authorizes inspection, starting the app, and opening it. */
export function launchScopeError(tool, args) {
    if (MUTATION_TOOLS.has(tool)) {
        return 'The user asked to open the existing project, not change its files or configuration.';
    }
    if (tool === 'sysRun' || tool === 'sysRunBg' || tool === 'terminal_persistent_shell') {
        const command = String(args.command ?? args.input ?? '').trim();
        if (OPEN_COMMAND.test(command) || isServerLaunchCommand(command) || LOCAL_HEALTH_CHECK.test(command) || PORT_CLEANUP_COMMAND.test(command)) {
            return null;
        }
        if (/[;&|><`$()]/.test(command)) {
            return 'A launch-only request does not authorize chained shell commands. Use one scoped command per tool call.';
        }
        if (READ_ONLY_COMMAND.test(command)) {
            return null;
        }
        return 'The user asked to open the existing project. Use read-only inspection, a background server, or desktop.open; do not run unrelated commands.';
    }
    return null;
}
