import { AsyncLocalStorage } from 'node:async_hooks';

export type AutonomyMode = 'A' | 'B' | 'C' | string;

const toolAutonomy = new AsyncLocalStorage<AutonomyMode>();

/** Session-scoped context for legacy tools whose execute signature has no context parameter. */
export function withToolAutonomyMode<T>(mode: AutonomyMode, run: () => Promise<T>): Promise<T> {
  return toolAutonomy.run(mode, run);
}

export function currentToolAutonomyMode(): AutonomyMode | undefined {
  return toolAutonomy.getStore();
}

export interface ToolApprovalInput {
  mode: AutonomyMode;
  tool: string;
  args: Record<string, unknown>;
  risk: string;
  heavyDownload: boolean;
  standingApproval: boolean;
}

/** Read the live session mode from the tool context; never infer it from a tool argument. */
export function isAutonomousToolContext(context: unknown): boolean {
  if (!context || typeof context !== 'object') return false;
  const parentLoop = (context as { parentLoop?: unknown }).parentLoop;
  if (!parentLoop || typeof parentLoop !== 'object') return false;
  const config = (parentLoop as { config?: unknown }).config;
  if (!config || typeof config !== 'object') return false;
  const mode = (config as { autonomyMode?: unknown }).autonomyMode;
  return mode === 'C' || mode === undefined;
}

const SHELL_TOOLS = new Set(['sysRun', 'sysRunBg', 'terminal_persistent_shell']);
const WHOLE_FILE_DELETE = /(?:^|[;&|\n(]\s*)(?:(?:sudo|command|env)\s+)*(?:rm|unlink|rmdir|del|erase|Remove-Item)\b|\bfind\b[^\n;]*\s-delete\b|\bgit\s+(?:rm\b|clean\b[^\n;&|]*(?:-[a-zA-Z0-9]*f[a-zA-Z0-9]*|--force\b))/i;
const DELETE_API_CALL = /\b(?:os\.(?:remove|unlink)|shutil\.rmtree|fs\.(?:rm|unlink)(?:Sync)?|\.unlink|\.rmdir)\s*\(/i;
const NESTED_SHELL_DELETE = /\b(?:bash|sh|zsh|dash)\s+-c\s+['"]\s*(?:rm|unlink|rmdir)\b|\b(?:powershell|pwsh)\s+(?:-Command|-c)\s+['"]?\s*Remove-Item\b/i;

/** A deletion is a whole filesystem entry, not removal of lines in an edit. */
export function isWholeFileDeletion(tool: string, args: Record<string, unknown>): boolean {
  if (tool === 'fs_delete') return true;
  const command = tool === 'gitOp'
    ? `git ${String(args.command ?? args.action ?? '')}`
    : SHELL_TOOLS.has(tool)
      ? String(args.command ?? args.input ?? args.cmd ?? '')
      : '';
  if (/^\s*git\s+rm\s+--cached\b/i.test(command)) return false;
  return command.length > 0
    && (WHOLE_FILE_DELETE.test(command) || DELETE_API_CALL.test(command) || NESTED_SHELL_DELETE.test(command));
}

/** Routine browser verification inside the isolated agent browser (preview, snapshot, click, fill, screenshot, etc.) does not require HITL in Mode B or C unless uploading or downloading files. */
export function isRoutineBrowserVerification(tool: string, args: Record<string, unknown>): boolean {
  if (tool !== 'browser_act') return false;
  const actions = Array.isArray(args?.actions) ? args.actions : [];
  if (actions.length === 0) {
    const singleType = typeof args?.action === 'string' ? args.action : typeof args?.type === 'string' ? args.type : '';
    return singleType !== 'download' && singleType !== 'upload';
  }
  return !actions.some(item => {
    if (!item || typeof item !== 'object') return false;
    const type = String((item as { type?: unknown; action?: unknown }).type ?? (item as { action?: unknown }).action ?? '');
    return type === 'download' || type === 'upload';
  });
}

/** Prompt policy only. Sandbox denial, workspace checks, and observer veto run separately. */
export function requiresToolApproval(input: ToolApprovalInput): boolean {
  if (input.mode === 'C') {
    if (!isWholeFileDeletion(input.tool, input.args)) return false;
    // A general shell or git grant must not authorize future deletions.
    return input.tool !== 'fs_delete' || !input.standingApproval;
  }
  if (input.standingApproval) return false;
  if (input.mode !== 'A' && isRoutineBrowserVerification(input.tool, input.args)) {
    return false;
  }
  return input.risk === 'extreme'
    || input.heavyDownload
    || input.risk === 'dangerous'
    || input.mode === 'A';
}
