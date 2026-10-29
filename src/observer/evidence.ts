import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveUserPath } from '../utils/paths.js';

export type RiskSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface RiskEvidence {
  code: string;
  severity: RiskSeverity;
  weight: number;
  confidence: number;
  detail: string;
  source: 'rules' | 'advisory';
}

export interface MutationAssessment {
  allowed: boolean;
  veto: boolean;
  requiresConfirmation: boolean;
  riskScore: number;
  confidence: number;
  reason: string;
  findings: string[];
  evidence: RiskEvidence[];
}

export interface MutationContext {
  workspaceRoot: string;
}

export interface ToolOutcome {
  tool: string;
  args: Record<string, unknown>;
  success: boolean;
  error: string;
  exitCode: number | null;
  command: string;
  path: string;
  at: number;
  rendered?: boolean;
}

const SEVERITY_WEIGHT: Record<RiskSeverity, number> = {
  low: 0.3,
  medium: 0.55,
  high: 0.78,
  critical: 1
};

const CRITICAL_PROJECT_FILES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'tsconfig.json',
  'tsconfig.runtime.json',
  'tsconfig.strict.json',
  '.env',
  '.env.production',
  '.env.local'
]);

const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.rb', '.php',
  '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.c', '.cc', '.cpp',
  '.h', '.hpp', '.cs', '.fs', '.sh', '.bash', '.zsh', '.fish', '.sql',
  '.html', '.css', '.scss', '.sass', '.vue', '.svelte'
]);

const VERIFICATION_COMMAND = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|build|lint|typecheck|types)|node\s+(?:--test|--check|-c)|pytest|py_compile|compileall|cargo\s+(?:test|check)|go\s+(?:test|vet)|mvn\s+test|gradle\s+test|dotnet\s+test|swift\s+test|tsc(?:\s|$)|eslint|biome\s+(?:check|ci)|ruby\s+-c|php\s+-l)\b/i;

const HIGH_RISK_COMMANDS: Array<{ pattern: RegExp; code: string; detail: string; severity?: RiskSeverity }> = [
  { pattern: /\bgit\s+reset\s+--hard\b/i, code: 'git-reset-hard', detail: 'git reset --hard discards uncommitted work' },
  { pattern: /\bgit\s+clean\s+-[a-z]*[fdx][a-z]*/i, code: 'git-clean', detail: 'git clean permanently removes untracked files' },
  { pattern: /\bgit\s+checkout\s+--\s+\./i, code: 'git-checkout-all', detail: 'checkout -- . discards working-tree changes' },
  { pattern: /\bgit\s+push\b[^\n]*(?:--force|-f)\b/i, code: 'git-force-push', detail: 'force push rewrites shared history' },
  { pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i, code: 'remote-shell', detail: 'piping downloaded content into a shell executes unreviewed code' },
  { pattern: /\bchmod\s+(?:-[A-Za-z]*R[A-Za-z]*\s+)?0?777\b/i, code: 'chmod-777', detail: 'world-writable permissions weaken the project', severity: 'medium' },
  { pattern: /\bchown\s+-[A-Za-z]*R[A-Za-z]*\b/i, code: 'chown-recursive', detail: 'recursive ownership changes can make files unusable', severity: 'high' },
  { pattern: /\b(?:DROP|TRUNCATE)\s+(?:DATABASE|SCHEMA|TABLE)\b/i, code: 'sql-destructive', detail: 'destructive SQL can remove stored data' },
  { pattern: /\b(?:npm|pnpm|yarn)\s+publish\b/i, code: 'package-publish', detail: 'publishing changes a public package' },
  { pattern: /\b(?:docker|podman)\s+system\s+prune\b/i, code: 'container-prune', detail: 'pruning containers and images removes local state' },
  { pattern: /\bfind\s+(?:\/|~|\$HOME)\b[^\n]*-delete\b/i, code: 'find-root-delete', detail: 'deleting files from a system or home root is destructive' },
  { pattern: /\btruncate\s+-s\s*0\b/i, code: 'file-truncate', detail: 'truncating a file destroys its current contents' },
  { pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i, code: 'system-power', detail: 'power state changes interrupt every running process' },
  { pattern: /\bsudo\b/i, code: 'privilege-escalation', detail: 'elevated privileges expand the blast radius', severity: 'medium' },
  { pattern: /\bkill\s+-9\s+(?:-1|1)\b/i, code: 'kill-all', detail: 'killing every process can take down the session' }
];

const CRITICAL_COMMANDS: Array<{ pattern: RegExp; code: string; detail: string }> = [
  { pattern: /\bmkfs(?:\.\w+)?\b/i, code: 'filesystem-format', detail: 'formatting a filesystem destroys its contents' },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\//i, code: 'raw-device-write', detail: 'writing directly to a device destroys its filesystem' },
  { pattern: />\s*\/dev\/(?:sd|disk|nvme|hd)/i, code: 'raw-device-redirect', detail: 'redirecting output to a device destroys its contents' },
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, code: 'fork-bomb', detail: 'a fork bomb exhausts process resources' },
  { pattern: /\b(?:rm|shred)\b[^\n]*--no-preserve-root\b/i, code: 'no-preserve-root', detail: 'removing the root filesystem protection is catastrophic' },
  { pattern: /\bchmod\s+-[A-Za-z]*R[A-Za-z]*\s+0?777\s+\/(?:\s|$)/i, code: 'root-permissions', detail: 'making the filesystem root world-writable is catastrophic' }
];

function add(
  evidence: RiskEvidence[],
  code: string,
  severity: RiskSeverity,
  detail: string,
  confidence: number,
  source: RiskEvidence['source'] = 'rules'
): void {
  if (evidence.some((item) => item.code === code)) return;
  evidence.push({
    code,
    severity,
    weight: SEVERITY_WEIGHT[severity],
    confidence,
    detail,
    source
  });
}

function realpathLoose(target: string): string {
  let current = target;
  const suffix: string[] = [];
  while (true) {
    try {
      return path.join(fs.realpathSync(current), ...suffix.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function safeRealpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function physicalRoot(workspaceRoot: string): string {
  return realpathLoose(path.resolve(workspaceRoot));
}

function resolveTarget(workspaceRoot: string, raw: string): { lexical: string; physical: string; inside: boolean } {
  const lexical = resolveUserPath(raw);
  const physical = realpathLoose(lexical);
  const root = physicalRoot(workspaceRoot);
  const relative = path.relative(root, physical);
  const inside = relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  return { lexical, physical, inside };
}

function pathArgument(args: Record<string, unknown>): string {
  for (const key of ['path', 'file_path', 'targetFile', 'file', 'source', 'destination', 'target', 'cwd']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function toolPath(args: Record<string, unknown>): string {
  return pathArgument(args);
}

export function isCodePath(target: string): boolean {
  return CODE_EXTENSIONS.has(path.extname(target).toLowerCase());
}

export function isVerificationCommand(command: string): boolean {
  return VERIFICATION_COMMAND.test(command);
}

function readSize(target: string): number | null {
  try {
    const stat = fs.statSync(target);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function tokenizeTargets(segment: string): { recursive: boolean; targets: string[] } {
  const tokens: string[] = [];
  let current = '';
  let quote = '';
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if (character === undefined) continue;
    if (quote) {
      if (character === quote) quote = '';
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);

  let recursive = false;
  const targets: string[] = [];
  let flagsDone = false;
  for (const token of tokens) {
    if (!flagsDone && token === '--') {
      flagsDone = true;
      continue;
    }
    if (!flagsDone && /^--/.test(token)) {
      if (token === '--recursive') recursive = true;
      continue;
    }
    if (!flagsDone && /^-[A-Za-z]+$/.test(token)) {
      if (/[rR]/.test(token)) recursive = true;
      continue;
    }
    if (!flagsDone && /^-/.test(token)) continue;
    targets.push(token);
  }
  return { recursive, targets };
}

function scanRemoveCommands(command: string, workspaceRoot: string, evidence: RiskEvidence[]): void {
  const pattern = /\brm\s+([^;&|\n]+)/gi;
  for (const match of command.matchAll(pattern)) {
    const segment = match[1];
    if (!segment) continue;
    const { recursive, targets } = tokenizeTargets(segment);
    for (const rawTarget of targets) {
      const expanded = rawTarget
        .replace(/^\$\{HOME\}/, os.homedir())
        .replace(/^\$HOME\b/, os.homedir())
        .replace(/^~(?=\/|$)/, os.homedir());
      const wildcard = expanded === '*' || expanded === './*' || expanded === '.*';
      const resolved = resolveTarget(workspaceRoot, wildcard ? workspaceRoot : expanded);
      const target = resolved.physical;
      const root = physicalRoot(workspaceRoot);
      const home = safeRealpath(os.homedir());
      const filesystemRoot = path.parse(target).root;

      if (wildcard || target === root || target === home || target === filesystemRoot) {
        if (recursive) {
          add(evidence, 'rm-project-root', 'critical', `recursive removal targets the workspace, home, or filesystem root: ${expanded}`, 0.95);
        } else {
          add(evidence, 'rm-root-file', 'high', `removal targets a protected root path: ${expanded}`, 0.85);
        }
        continue;
      }

      if (!resolved.inside) {
        add(
          evidence,
          'rm-outside-workspace',
          recursive ? 'high' : 'medium',
          `recursive removal targets a path outside the workspace: ${expanded}`,
          0.8
        );
        continue;
      }

      const base = path.basename(target);
      if (recursive && ['.git', 'src', 'app', 'lib', 'packages'].includes(base)) {
        add(evidence, 'rm-critical-directory', 'high', `recursive removal targets a core project directory: ${expanded}`, 0.85);
      } else if (recursive) {
        add(evidence, 'rm-recursive', 'medium', `recursive removal inside the workspace: ${expanded}`, 0.75);
      } else {
        add(evidence, 'rm-file', 'low', `file removal: ${expanded}`, 0.65);
      }
    }
  }
}

function scanShell(command: string, workspaceRoot: string, evidence: RiskEvidence[]): void {
  if (!command.trim()) return;
  scanRemoveCommands(command, workspaceRoot, evidence);
  for (const rule of CRITICAL_COMMANDS) {
    if (rule.pattern.test(command)) add(evidence, rule.code, 'critical', rule.detail, 0.92);
  }
  for (const rule of HIGH_RISK_COMMANDS) {
    if (rule.pattern.test(command)) add(evidence, rule.code, rule.severity ?? 'high', rule.detail, 0.82);
  }
}

function scanWrite(toolName: string, args: Record<string, unknown>, workspaceRoot: string, evidence: RiskEvidence[]): void {
  const rawTarget = pathArgument(args);
  if (!rawTarget) {
    add(evidence, 'write-without-path', 'medium', `${toolName} did not declare a target path`, 0.6);
    return;
  }

  const resolved = resolveTarget(workspaceRoot, rawTarget);
  const base = path.basename(resolved.physical);

  if (!resolved.inside) {
    const temporary = resolved.physical.startsWith(safeRealpath(os.tmpdir()));
    add(
      evidence,
      temporary ? 'write-temporary' : 'write-outside-workspace',
      temporary ? 'low' : 'high',
      `${toolName} writes outside the workspace: ${rawTarget}`,
      0.82
    );
  }

  if (resolved.physical.includes(`${path.sep}.git${path.sep}`) || base === '.git') {
    add(evidence, 'write-git-metadata', 'high', `write touches repository metadata: ${rawTarget}`, 0.85);
  }

  if (CRITICAL_PROJECT_FILES.has(base)) {
    add(evidence, 'write-critical-config', 'high', `write changes a critical project file: ${base}`, 0.8);
  }

  if (base === 'AGENTS.md') {
    add(evidence, 'write-agent-instructions', 'medium', 'write changes repository agent instructions', 0.7);
  }

  const originalSize = readSize(resolved.physical);
  let replacementSize: number | null = null;
  if (toolName === 'fs_write') {
    const content = typeof args.content === 'string' ? args.content : typeof args.text === 'string' ? args.text : '';
    replacementSize = Buffer.byteLength(content, 'utf8');
    if (replacementSize === 0 && originalSize !== null && originalSize > 0) {
      add(evidence, 'write-empty-file', 'high', `write replaces ${base} with an empty file`, 0.85);
    }
    if (base === 'package.json' && replacementSize > 0) {
      try {
        const parsed: unknown = JSON.parse(content);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          add(evidence, 'invalid-package-json', 'high', 'package.json would not contain a JSON object', 0.9);
        }
      } catch {
        add(evidence, 'invalid-package-json', 'high', 'package.json would contain invalid JSON', 0.9);
      }
    }
  } else {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    let delta = 0;
    let sawEdit = false;
    for (const edit of edits) {
      if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) continue;
      const record = edit as Record<string, unknown>;
      const before = typeof record.old_string === 'string'
        ? record.old_string
        : typeof record.searchContent === 'string' ? record.searchContent : null;
      const after = typeof record.new_string === 'string'
        ? record.new_string
        : typeof record.replaceContent === 'string' ? record.replaceContent : null;
      if (before === null || after === null) continue;
      delta += Buffer.byteLength(after, 'utf8') - Buffer.byteLength(before, 'utf8');
      sawEdit = true;
    }
    if (sawEdit && originalSize !== null) replacementSize = originalSize + delta;
  }

  if (originalSize !== null && replacementSize !== null && originalSize > 1024 && replacementSize < originalSize * 0.2) {
    const lost = Math.round((1 - replacementSize / originalSize) * 100);
    add(evidence, 'write-large-shrink', 'high', `edit removes about ${lost}% of ${base}`, 0.78);
  }
}

function scanDelete(args: Record<string, unknown>, workspaceRoot: string, evidence: RiskEvidence[]): void {
  const rawTarget = pathArgument(args);
  if (!rawTarget) {
    add(evidence, 'delete-without-path', 'medium', 'delete did not declare a target', 0.6);
    return;
  }
  const resolved = resolveTarget(workspaceRoot, rawTarget);
  const base = path.basename(resolved.physical);

  if (!resolved.inside) {
    add(evidence, 'delete-outside-workspace', 'high', `delete targets a path outside the workspace: ${rawTarget}`, 0.88);
    return;
  }
  if (base === '.git' || resolved.physical.includes(`${path.sep}.git${path.sep}`)) {
    add(evidence, 'delete-git-metadata', 'high', `delete targets repository metadata: ${rawTarget}`, 0.9);
    return;
  }
  if (resolved.physical === physicalRoot(workspaceRoot)) {
    add(evidence, 'delete-workspace-root', 'critical', `delete targets the workspace root: ${rawTarget}`, 0.95);
    return;
  }
  if (CRITICAL_PROJECT_FILES.has(base)) {
    add(evidence, 'delete-critical-config', 'high', `delete targets a critical project file: ${base}`, 0.9);
    return;
  }
  if (args.recursive === true) {
    add(evidence, 'delete-recursive', 'high', `recursive delete inside the workspace: ${rawTarget}`, 0.82);
  } else {
    add(evidence, 'delete-file', 'medium', `delete targets a project file: ${rawTarget}`, 0.7);
  }
}

function scanMove(args: Record<string, unknown>, workspaceRoot: string, evidence: RiskEvidence[]): void {
  const source = typeof args.source === 'string' ? args.source : '';
  const destination = typeof args.destination === 'string' ? args.destination : '';
  if (source) {
    const resolved = resolveTarget(workspaceRoot, source);
    if (!resolved.inside) add(evidence, 'move-source-outside', 'medium', `move reads outside the workspace: ${source}`, 0.75);
    const base = path.basename(resolved.physical);
    if (base === '.git' || CRITICAL_PROJECT_FILES.has(base)) {
      add(evidence, 'move-critical-path', 'high', `move targets a critical path: ${source}`, 0.85);
    }
  }
  if (destination) {
    const resolved = resolveTarget(workspaceRoot, destination);
    if (!resolved.inside) add(evidence, 'move-destination-outside', 'high', `move writes outside the workspace: ${destination}`, 0.82);
  }
  if (args.overwrite === true) {
    add(evidence, 'move-overwrite', 'medium', 'move is allowed to overwrite an existing destination', 0.65);
  }
}

export function scanMutation(toolName: string, args: Record<string, unknown>, context: MutationContext): {
  evidence: RiskEvidence[];
  riskScore: number;
  confidence: number;
  veto: boolean;
} {
  const evidence: RiskEvidence[] = [];
  const workspaceRoot = context.workspaceRoot || process.cwd();

  if (['sysRun', 'sysRunBg', 'terminal_persistent_shell'].includes(toolName)) {
    const command = typeof args.command === 'string'
      ? args.command
      : typeof args.cmd === 'string' ? args.cmd : '';
    scanShell(command, workspaceRoot, evidence);
  } else if (toolName === 'gitOp') {
    const command = typeof args.command === 'string' ? `git ${args.command}` : '';
    scanShell(command, workspaceRoot, evidence);
  } else if (toolName === 'fs_write' || toolName === 'fs_edit' || toolName === 'MultiEdit') {
    scanWrite(toolName, args, workspaceRoot, evidence);
  } else if (toolName === 'fs_delete') {
    scanDelete(args, workspaceRoot, evidence);
  } else if (toolName === 'fs_move') {
    scanMove(args, workspaceRoot, evidence);
  }

  const critical = evidence.some((item) => item.severity === 'critical');
  let riskScore = 0;
  let confidence = 0;
  for (const item of evidence) {
    riskScore = Math.max(riskScore, item.weight);
    confidence = Math.max(confidence, item.confidence);
  }
  if (!critical && evidence.length > 1) {
    riskScore = Math.min(0.97, riskScore + 0.04 * (evidence.length - 1));
  }
  if (critical) {
    riskScore = 1;
    confidence = Math.max(confidence, 0.9);
  }

  return { evidence, riskScore, confidence, veto: critical };
}

export function boundedArgs(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['command', 'cmd', 'path', 'file_path', 'source', 'destination', 'action', 'url', 'query', 'pattern']) {
    const value = args[key];
    if (typeof value === 'string') result[key] = value.slice(0, 400);
  }
  if (typeof args.recursive === 'boolean') result.recursive = args.recursive;
  if (typeof args.overwrite === 'boolean') result.overwrite = args.overwrite;
  if (typeof args.content === 'string') result.contentBytes = Buffer.byteLength(args.content, 'utf8');
  if (Array.isArray(args.edits)) result.editCount = args.edits.length;
  return result;
}

export function outcomeFromResult(tool: string, args: Record<string, unknown>, result: unknown, at: number): ToolOutcome {
  const record = result !== null && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  const success = record.success !== false && typeof record.error !== 'string';
  const rawError = typeof record.error === 'string' ? record.error : '';
  const exitCode = typeof record.exitCode === 'number' && Number.isFinite(record.exitCode) ? record.exitCode : null;
  const command = typeof args.command === 'string'
    ? args.command
    : typeof args.cmd === 'string' ? args.cmd : '';
  const browserData = Array.isArray(record.data) ? record.data : [];
  const rendered = success && tool === 'browser_act' && browserData.some((item: unknown) => {
    const action = item as { action?: string; data?: { runtimeErrors?: unknown[] } };
    return ['snapshot', 'scrape'].includes(action?.action || '') && Array.isArray(action.data?.runtimeErrors) && action.data.runtimeErrors.length === 0;
  });
  return {
    tool,
    args: boundedArgs(args),
    success,
    error: rawError.slice(0, 600),
    exitCode,
    command: command.slice(0, 600),
    path: pathArgument(args).slice(0, 400),
    at,
    ...(rendered ? { rendered: true } : {})
  };
}
