// Curated tool display — what a tool call looks like to a human.
//
// The renderer used to print raw argument JSON, so a file write showed as
//
//   fs_write {"path":"/Users/example/Projects/site/index.html","content":"<!DOC…
//
// which buries the one thing that matters (WHICH file) behind the one thing
// that does not (the entire payload). Every tool here declares a verb and the
// single detail worth reading; paths are shortened to `~`, credential-shaped
// values are masked, and anything unmapped falls back to a generic summary so a
// newly added tool can never render broken.
//
// Pure TypeScript over src/tui/text.js. No dependency, no shell.
import { shortenHome, safeDisplay } from './text.js';
/**
 * Pull the first present field, as a string.
 * Tools disagree about what to call their path argument — that inconsistency is
 * documented in sandbox.js PATH_ARGUMENTS and is the reason this exists.
 */
function firstString(args, keys) {
    for (const key of keys) {
        const value = args[key];
        if (typeof value === 'string' && value.length > 0)
            return value;
    }
    return '';
}
/** Path detail: the filename, with just enough parent to disambiguate. */
function pathDetail(value, { full = false } = {}) {
    if (!value)
        return '';
    const shortened = shortenHome(String(value));
    if (full)
        return shortened;
    const parts = shortened.split(/[/\\]/).filter(Boolean);
    if (parts.length <= 2)
        return shortened;
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}
function hostOf(url) {
    try {
        const parsed = new URL(String(url));
        return parsed.hostname + (parsed.pathname !== '/' ? parsed.pathname : '');
    }
    catch {
        return String(url ?? '');
    }
}
function editDetail(args, listKey) {
    const path = pathDetail(firstString(args, ['path', 'file_path']));
    const list = args[listKey];
    const edits = Array.isArray(list) ? list.length : 0;
    return edits > 1 ? `${path} (${edits} edits)` : path;
}
function countDetail(list, noun) {
    const count = Array.isArray(list) ? list.length : 0;
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
const TOOL_DISPLAY = new Map([
    ['fs_read', (a) => ({ verb: 'read', detail: pathDetail(firstString(a, ['path', 'file_path', 'target'])) })],
    ['read_file', (a) => ({ verb: 'read', detail: pathDetail(firstString(a, ['path', 'file_path', 'target'])) })],
    ['view_file', (a) => ({ verb: 'read', detail: pathDetail(firstString(a, ['path', 'file_path', 'target'])) })],
    ['fs_write', (a) => ({ verb: 'write', detail: pathDetail(firstString(a, ['path', 'file_path', 'target'])) })],
    ['write_file', (a) => ({ verb: 'write', detail: pathDetail(firstString(a, ['path', 'file_path', 'target'])) })],
    ['create_file', (a) => ({ verb: 'write', detail: pathDetail(firstString(a, ['path', 'file_path', 'target'])) })],
    ['fs_edit', (a) => ({ verb: 'edit', detail: editDetail(a, 'edits') })],
    ['edit_file', (a) => ({ verb: 'edit', detail: editDetail(a, 'edits') })],
    ['MultiEdit', (a) => ({ verb: 'edit', detail: editDetail(a, 'edits') })],
    ['fs_delete', (a) => ({ verb: 'delete', detail: pathDetail(firstString(a, ['path']), { full: true }) })],
    ['fs_move', (a) => ({ verb: 'move', detail: `${pathDetail(a['source'])} → ${pathDetail(a['destination'])}` })],
    ['fs_list', (a) => ({ verb: 'list', detail: pathDetail(firstString(a, ['path', 'directory']), { full: true }) })],
    ['fs_find', (a) => ({ verb: 'find', detail: firstString(a, ['pattern', 'query', 'name']) })],
    ['fs_search', (a) => ({ verb: 'search', detail: firstString(a, ['query', 'pattern']) })],
    ['sysRun', (a) => ({ verb: 'run', detail: firstString(a, ['command', 'cmd', 'detail']) })],
    ['run_command', (a) => ({ verb: 'run', detail: firstString(a, ['command', 'cmd', 'detail']) })],
    ['bash', (a) => ({ verb: 'run', detail: firstString(a, ['command', 'cmd', 'detail']) })],
    ['terminal', (a) => ({ verb: 'run', detail: firstString(a, ['command', 'cmd', 'detail']) })],
    ['execute', (a) => ({ verb: 'run', detail: firstString(a, ['command', 'cmd', 'detail']) })],
    ['sh', (a) => ({ verb: 'run', detail: firstString(a, ['command', 'cmd', 'detail']) })],
    ['zsh', (a) => ({ verb: 'run', detail: firstString(a, ['command', 'cmd', 'detail']) })],
    ['sysRunBg', (a) => ({ verb: 'run bg', detail: firstString(a, ['command', 'cmd']) })],
    ['terminal_persistent_shell', (a) => ({ verb: 'shell', detail: firstString(a, ['command', 'input']) })],
    ['proc_term', (a) => ({ verb: 'kill', detail: firstString(a, ['pid', 'name']) })],
    ['process_list', () => ({ verb: 'list', detail: 'processes' })],
    ['gitOp', (a) => ({ verb: 'git', detail: firstString(a, ['command', 'action', 'operation']) })],
    ['web_fetch', (a) => ({ verb: 'fetch', detail: hostOf(a['url']) })],
    ['web_search', (a) => ({ verb: 'search', detail: firstString(a, ['query', 'q']) })],
    ['browser_act', (a) => ({ verb: 'browse', detail: firstString(a, ['url', 'action']) })],
    ['screenshot', (a) => ({ verb: 'capture', detail: firstString(a, ['target', 'url']) || 'screen' })],
    ['code_search_ripgrep', (a) => ({ verb: 'grep', detail: firstString(a, ['query', 'pattern']) })],
    ['codebase_search', (a) => ({ verb: 'search', detail: firstString(a, ['query']) })],
    ['code_verify_syntax', (a) => ({ verb: 'verify', detail: pathDetail(firstString(a, ['path', 'file_path', 'detail'])) })],
    ['verify', (a) => ({ verb: 'verify', detail: pathDetail(firstString(a, ['path', 'file_path', 'detail'])) })],
    ['memory_write', (a) => ({ verb: 'remember', detail: firstString(a, ['fact', 'key', 'project']) })],
    ['update_plan', (a) => ({ verb: 'plan', detail: countDetail(a['plan'], 'step') })],
    ['tool_search', (a) => ({ verb: 'discover', detail: firstString(a, ['query', 'description']) })],
    ['fs_read_skill', (a) => ({ verb: 'skill', detail: firstString(a, ['id', 'skillId', 'domain']) })],
    ['manage_local_dependencies', (a) => ({ verb: 'provision', detail: `${String(a['action'] || '')} ${String(a['group'] || a['package'] || '')}`.trim() })]
]);
/**
 * Generic fallback for any tool without a curated entry.
 *
 * Ordered so the field that actually carries meaning shows first — the same
 * ordering the approval prompt uses, for the same reason.
 */
const FALLBACK_KEYS = [
    'command', 'path', 'file_path', 'source', 'url', 'query', 'action',
    'name', 'pattern', 'directory', 'target'
];
function fallbackDisplay(toolName, args) {
    const detail = firstString(args, FALLBACK_KEYS);
    if (detail)
        return { verb: '', detail: shortenHome(detail) };
    try {
        const compact = JSON.stringify(args);
        if (compact && compact !== '{}')
            return { verb: '', detail: compact };
    }
    catch { /* circular or unserialisable: nothing useful to show */ }
    return { verb: '', detail: '' };
}
/**
 * Resolve a tool call to `{ verb, detail }` fit for one terminal row.
 *
 * Never throws: a display helper must not be able to break the transcript.
 */
export function describeTool(toolName, args) {
    const safeArgs = args && typeof args === 'object' ? args : {};
    const safeName = typeof toolName === 'string' ? toolName : '';
    let display;
    try {
        const curated = TOOL_DISPLAY.get(safeName);
        display = curated ? curated(safeArgs) : fallbackDisplay(safeName, safeArgs);
    }
    catch {
        display = fallbackDisplay(safeName, safeArgs);
    }
    return {
        verb: safeDisplay(display.verb || ''),
        // Untrusted: an argument can carry escapes or a credential the model echoed.
        detail: safeDisplay(display.detail || '').replace(/\s+/g, ' ').trim()
    };
}
/** True when a curated entry exists — used by tests and by /help style output. */
export function hasCuratedDisplay(toolName) {
    return TOOL_DISPLAY.has(toolName);
}
/**
 * Multi-line detail for an approval prompt, where the user needs more than one
 * row. Reuses the same ordering and the same redaction.
 */
export function describeToolForApproval(args) {
    const safeArgs = args && typeof args === 'object' ? args : {};
    const lines = [];
    for (const key of FALLBACK_KEYS) {
        const value = safeArgs[key];
        if (typeof value !== 'string' || value.length === 0)
            continue;
        lines.push(`${key}: ${safeDisplay(shortenHome(value))}`);
        if (lines.length >= 4)
            break;
    }
    if (lines.length === 0) {
        try {
            const compact = JSON.stringify(safeArgs);
            if (compact && compact !== '{}')
                lines.push(safeDisplay(compact));
        }
        catch { /* nothing showable */ }
    }
    return lines;
}
