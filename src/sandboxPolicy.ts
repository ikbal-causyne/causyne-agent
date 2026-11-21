/**
 * Causyne Agent — Sandbox Workspace, Credential & Shell Command Policy
 *
 * Linear-time (O(n), zero ReDoS) security helpers supporting `src/sandbox.js`:
 * 1. Canonical blocked-workspace-root checks (POSIX + Windows + symlink resolution)
 *    enforced uniformly by both `updateWorkspacePaths()` and `addWorkspacePath()`.
 * 2. Expanded credential-path recognition (`.env*` excluding example/sample/template
 *    files, `.envrc`, `.git-credentials`, `.pypirc`, `.pgpass`, `.my.cnf`, private
 *    SSH key filenames, and cloud service-account credential JSONs).
 * 3. Quote-aware shell parser that extracts nested command substitutions
 *    (`$(...)` and backticks, including inside double quotes), strips leading env
 *    assignments and wrapper commands (`env`, `command`, `nohup`, `nice`, `time`,
 *    `timeout`, `exec`, `stdbuf`, `builtin`, `caffeinate`), resolves absolute
 *    executable basenames (`/bin/rm` -> `rm`), and extracts redirection + `tee`
 *    write targets even when quoted or prefixed with `$HOME`.
 */

import os from 'node:os';
import path from 'node:path';
import { isWithinPhysicalPath, physicalPath } from './agent/workspaceBoundary.js';

const MAX_SUBSTITUTION_DEPTH = 16;

const SAFE_ENV_TEMPLATE_EXACT = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
  '.env.defaults',
  '.env.schema'
]);

const SAFE_ENV_TEMPLATE_SUFFIXES = [
  '.example',
  '.sample',
  '.template',
  '.dist'
];

const CREDENTIAL_DIR_SEGMENTS = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.causyne'
]);

const CREDENTIAL_EXACT_BASENAMES = new Set([
  '.netrc',
  '.npmrc',
  '.envrc',
  '.git-credentials',
  '.pypirc',
  '.pgpass',
  '.my.cnf',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'credentials.json',
  'application_default_credentials.json'
]);

const SENSITIVE_WRITE_EXACT_BASENAMES = new Set([
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.zlogin',
  '.npmrc',
  '.netrc',
  '.git-credentials',
  '.pypirc',
  '.envrc'
]);

const SHELL_INTERPRETERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'ash',
  'pwsh',
  'powershell'
]);

const LEADING_SHELL_KEYWORDS = new Set([
  '!',
  '(',
  '{',
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  'case'
]);

const POSIX_TEMP_ALLOWLIST = [
  '/tmp',
  '/private/tmp',
  '/private/var/tmp',
  '/private/var/folders',
  '/var/tmp',
  '/var/folders'
];

const POSIX_BLOCKED_WORKSPACE_ROOTS = [
  '/etc',
  '/private/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/System',
  '/var',
  '/private',
  '/Library',
  '/dev',
  '/proc',
  '/sys',
  '/boot',
  '/root'
];

function expandLeadingTilde(targetPath: string): string {
  if (targetPath === '~') return os.homedir();
  if (targetPath.startsWith('~/') || targetPath.startsWith('~\\')) {
    return path.join(os.homedir(), targetPath.slice(2));
  }
  return targetPath;
}

function isWithinForPlatform(child: string, parent: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    const rel = path.win32.relative(parent.toLowerCase(), child.toLowerCase());
    return rel === '' || (rel !== '..' && !rel.startsWith('..\\') && !path.win32.isAbsolute(rel));
  }
  return isWithinPhysicalPath(child, parent);
}

function isBlockedResolvedRoot(candidate: string, platform: NodeJS.Platform): boolean {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const parsedRoot = pathApi.parse(candidate).root;
  if (parsedRoot && candidate.toLowerCase() === parsedRoot.toLowerCase()) {
    return true;
  }

  if (platform === 'win32') {
    const sysRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
    const winBlocked = [
      sysRoot,
      'C:\\Windows',
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      'C:\\ProgramData',
      'C:\\System Volume Information'
    ];
    return winBlocked.some(root => isWithinForPlatform(candidate, root, 'win32'));
  }

  if (POSIX_TEMP_ALLOWLIST.some(allowed => isWithinForPlatform(candidate, allowed, platform))) {
    return false;
  }

  return POSIX_BLOCKED_WORKSPACE_ROOTS.some(root => isWithinForPlatform(candidate, root, platform));
}

/**
 * Returns true if `targetPath` is a system-critical root, filesystem root,
 * invalid/dangling symlink, or resolves via symlinks into a blocked system root.
 * Used uniformly by `updateWorkspacePaths()` and `addWorkspacePath()`.
 */
export function isBlockedWorkspaceRoot(
  targetPath: string,
  options?: { platform?: NodeJS.Platform | undefined }
): boolean {
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0 || targetPath.includes('\0')) return true;
  const platform = options?.platform ?? process.platform;
  const expanded = expandLeadingTilde(targetPath.trim());
  const resolved = platform === 'win32' ? path.win32.resolve(expanded) : path.resolve(expanded);

  if (isBlockedResolvedRoot(resolved, platform)) return true;

  if (platform === process.platform) {
    const realTarget = physicalPath(resolved);
    if (!realTarget) return true;
    if (isBlockedResolvedRoot(realTarget, platform)) return true;
  }

  return false;
}

/**
 * Recognizes credential stores, private key files, and secret env files
 * without backtracking regexes. Explicitly excludes `.env.example`, `.env.sample`,
 * `.env.template`, and `.env.dist` templates to prevent developer false positives.
 */
export function isExtendedCredentialPath(targetPath: string): boolean {
  if (typeof targetPath !== 'string' || targetPath.length === 0 || targetPath.includes('\0')) return false;
  const normalized = targetPath.replace(/\\/g, '/').trim();
  if (!normalized) return false;

  const trimmed = normalized.endsWith('/') && normalized.length > 1
    ? normalized.slice(0, -1)
    : normalized;
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.length === 0) return false;

  const lowerParts = parts.map(p => p.toLowerCase());

  for (const part of lowerParts) {
    if (CREDENTIAL_DIR_SEGMENTS.has(part)) return true;
  }

  for (let i = 0; i < lowerParts.length - 1; i++) {
    if (lowerParts[i] === 'library' && lowerParts[i + 1] === 'keychains') return true;
    if (lowerParts[i] === '.docker' && lowerParts[i + 1] === 'config.json') return true;
  }

  const baseLower = lowerParts[lowerParts.length - 1] ?? '';
  if (CREDENTIAL_EXACT_BASENAMES.has(baseLower)) return true;

  if (baseLower === '.env') return true;
  if (baseLower.startsWith('.env.')) {
    if (SAFE_ENV_TEMPLATE_EXACT.has(baseLower)) return false;
    for (const suffix of SAFE_ENV_TEMPLATE_SUFFIXES) {
      if (baseLower.endsWith(suffix)) return false;
    }
    return true;
  }

  if (
    (baseLower.startsWith('service-account') || baseLower.startsWith('service_account')) &&
    baseLower.endsWith('.json')
  ) {
    return true;
  }

  return false;
}

/**
 * Returns true if a file target is a high-risk persistence or credential target
 * for shell redirection (`>`, `>>`) or `tee`.
 */
export function isSensitiveWriteTarget(rawTarget: string): boolean {
  if (typeof rawTarget !== 'string' || rawTarget.length === 0 || rawTarget.includes('\0')) return false;

  let target = rawTarget.trim();
  if (
    (target.startsWith('"') && target.endsWith('"') && target.length >= 2) ||
    (target.startsWith("'") && target.endsWith("'") && target.length >= 2)
  ) {
    target = target.slice(1, -1);
  }
  target = target.replace(/\\/g, '/');

  // Normalize common home-directory expansions for matching
  if (target === '~' || target.startsWith('~/')) {
    target = `/home/user${target.slice(1)}`;
  } else if (target.startsWith('$home/') || target.startsWith('${home}/')) {
    const slash = target.indexOf('/');
    target = `/home/user${target.slice(slash)}`;
  } else if (target.startsWith('$HOME/') || target.startsWith('${HOME}/')) {
    const slash = target.indexOf('/');
    target = `/home/user${target.slice(slash)}`;
  }

  const lower = target.toLowerCase();
  const parts = lower.split('/').filter(Boolean);
  if (parts.length === 0) return false;

  const base = parts[parts.length - 1] ?? '';
  if (SENSITIVE_WRITE_EXACT_BASENAMES.has(base)) return true;

  // Protected system / persistence directories
  if (lower.startsWith('/etc/') || lower === '/etc' || lower.includes('/etc/')) return true;

  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === '.ssh' || seg === '.causyne' || seg === '.aws' || seg === '.kube' || seg === '.gnupg') {
      return true;
    }
    if (seg === 'crontab' || seg === 'cron.d') return true;
    if (seg === '.git' && (parts[i + 1] === 'hooks' || parts[i + 1] === 'config')) return true;
    if (seg === '.docker' && parts[i + 1] === 'config.json') return true;
    if (seg === '.config' && parts[i + 1] === 'fish' && parts[i + 2] === 'config.fish') return true;
  }

  return false;
}

interface ParsedMaskResult {
  masked: string;
  substitutions: string[];
}

/**
 * Single-pass quote-aware scanner that masks literal single/double-quoted text
 * while extracting executable command substitutions (`$(...)` and backticks)
 * both outside quotes and inside double quotes (single quotes stay literal).
 */
export function parseMaskAndExtractSubstitutions(
  input: string,
  depth = 0
): ParsedMaskResult {
  let masked = '';
  const substitutions: string[] = [];
  const len = input.length;
  let i = 0;

  while (i < len) {
    const ch = input[i];

    // Backslash escape outside quotes
    if (ch === '\\' && i + 1 < len) {
      masked += ch + input[i + 1];
      i += 2;
      continue;
    }

    // Single-quoted literal span (no variable or command substitution in POSIX)
    if (ch === "'") {
      i++;
      while (i < len && input[i] !== "'") {
        i++;
      }
      if (i < len) i++; // consume closing quote
      masked += "''";
      continue;
    }

    // Double-quoted span: literal text is masked, but `$(...)` and `` `...` `` EXECUTE!
    if (ch === '"') {
      i++;
      while (i < len && input[i] !== '"') {
        const inner = input[i];
        if (inner === '\\' && i + 1 < len) {
          i += 2;
          continue;
        }
        if (inner === '$' && input[i + 1] === '(') {
          const captured = readDollarSubshell(input, i + 2);
          if (captured.content.trim().length > 0) {
            substitutions.push(captured.content);
          }
          i = captured.nextIndex;
          continue;
        }
        if (inner === '`') {
          const captured = readBacktickSubshell(input, i + 1);
          if (captured.content.trim().length > 0) {
            substitutions.push(captured.content);
          }
          i = captured.nextIndex;
          continue;
        }
        i++;
      }
      if (i < len) i++; // consume closing quote
      masked += '""';
      continue;
    }

    // Unquoted `$(...)` command substitution
    if (ch === '$' && input[i + 1] === '(') {
      const captured = readDollarSubshell(input, i + 2);
      if (captured.content.trim().length > 0) {
        substitutions.push(captured.content);
      }
      masked += ' ';
      i = captured.nextIndex;
      continue;
    }

    // Unquoted backtick command substitution
    if (ch === '`') {
      const captured = readBacktickSubshell(input, i + 1);
      if (captured.content.trim().length > 0) {
        substitutions.push(captured.content);
      }
      masked += ' ';
      i = captured.nextIndex;
      continue;
    }

    masked += ch;
    i++;
  }

  if (depth < MAX_SUBSTITUTION_DEPTH && substitutions.length > 0) {
    const nested: string[] = [];
    for (const sub of substitutions) {
      const parsed = parseMaskAndExtractSubstitutions(sub, depth + 1);
      for (const deeper of parsed.substitutions) {
        nested.push(deeper);
      }
    }
    for (const deeper of nested) {
      substitutions.push(deeper);
    }
  }

  return { masked, substitutions };
}

function readDollarSubshell(input: string, startIndex: number): { content: string; nextIndex: number } {
  const len = input.length;
  let i = startIndex;
  let parenDepth = 1;
  let inSingle = false;
  let inDouble = false;

  while (i < len && parenDepth > 0) {
    const ch = input[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === '\\' && i + 1 < len) {
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < len) {
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i++;
      continue;
    }
    if (ch === '(') {
      parenDepth++;
      i++;
      continue;
    }
    if (ch === ')') {
      parenDepth--;
      if (parenDepth === 0) {
        return { content: input.slice(startIndex, i), nextIndex: i + 1 };
      }
      i++;
      continue;
    }
    i++;
  }
  return { content: input.slice(startIndex, i), nextIndex: i };
}

function readBacktickSubshell(input: string, startIndex: number): { content: string; nextIndex: number } {
  const len = input.length;
  let i = startIndex;
  while (i < len) {
    const ch = input[i];
    if (ch === '\\' && i + 1 < len) {
      i += 2;
      continue;
    }
    if (ch === '`') {
      return { content: input.slice(startIndex, i), nextIndex: i + 1 };
    }
    i++;
  }
  return { content: input.slice(startIndex, i), nextIndex: i };
}

/**
 * Splits a masked shell command string into sequential command lists and
 * pipe-connected pipeline groups while keeping `2>&1` / `>&2` descriptor
 * duplications intact.
 */
export function splitIntoPipelinesAndSegments(maskedText: string): {
  segments: string[];
  pipelines: string[][];
} {
  const listGroups: string[] = [];
  let current = '';
  const len = maskedText.length;
  let i = 0;

  const pushGroup = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) listGroups.push(trimmed);
    current = '';
  };

  while (i < len) {
    const ch = maskedText[i]!;
    const next = maskedText[i + 1];

    if (ch === ';' || ch === '\n') {
      pushGroup();
      i++;
      continue;
    }
    if (ch === '&' && next === '&') {
      pushGroup();
      i += 2;
      continue;
    }
    if (ch === '|' && next === '|') {
      pushGroup();
      i += 2;
      continue;
    }
    if (ch === '&') {
      const prev = i > 0 ? maskedText[i - 1] : '';
      // Keep `>&1`, `2>&1`, `<&0`, `&>` redirections intact
      if (prev === '>' || prev === '<' || next === '>') {
        current += ch;
        i++;
        continue;
      }
      pushGroup();
      i++;
      continue;
    }

    current += ch;
    i++;
  }
  pushGroup();

  const segments: string[] = [];
  const pipelines: string[][] = [];

  for (const group of listGroups) {
    const stages: string[] = [];
    let stage = '';
    for (let j = 0; j < group.length; j++) {
      const ch = group[j]!;
      if (ch === '|') {
        const trimmed = stage.trim();
        if (trimmed.length > 0) {
          stages.push(trimmed);
          segments.push(trimmed);
        }
        stage = '';
        continue;
      }
      stage += ch;
    }
    const trimmed = stage.trim();
    if (trimmed.length > 0) {
      stages.push(trimmed);
      segments.push(trimmed);
    }
    if (stages.length > 0) {
      pipelines.push(stages);
    }
  }

  return { segments, pipelines };
}

function isEnvAssignmentToken(token: string): boolean {
  const eq = token.indexOf('=');
  if (eq <= 0) return false;
  const name = token.slice(0, eq);
  const first = name.charCodeAt(0);
  const isFirstValid =
    (first >= 97 && first <= 122) || // a-z
    (first >= 65 && first <= 90) ||  // A-Z
    first === 95;                    // _
  if (!isFirstValid) return false;
  for (let i = 1; i < name.length; i++) {
    const code = name.charCodeAt(i);
    const valid =
      (code >= 97 && code <= 122) ||
      (code >= 65 && code <= 90) ||
      (code >= 48 && code <= 57) ||
      code === 95;
    if (!valid) return false;
  }
  return true;
}

function isStandaloneRedirectOperator(token: string): boolean {
  return (
    token === '>' ||
    token === '>>' ||
    token === '<' ||
    token === '1>' ||
    token === '1>>' ||
    token === '2>' ||
    token === '2>>' ||
    token === '&>' ||
    token === '&>>'
  );
}

function isAttachedRedirectToken(token: string): boolean {
  return (
    token.startsWith('>') ||
    token.startsWith('<') ||
    token.startsWith('1>') ||
    token.startsWith('2>') ||
    token.startsWith('&>')
  );
}

function resolveExecutableBasename(token: string): string {
  const normalized = token.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  let base = slash !== -1 ? normalized.slice(slash + 1) : normalized;
  if (base.endsWith('.exe') && base.length > 4) {
    base = base.slice(0, -4);
  }
  return base;
}

export interface NormalizedSegment {
  normalized: string;
  executable: string;
  args: string[];
  isReadOnlyLookup: boolean;
}

/**
 * Normalizes one already-lowercased, quote-masked shell segment by stripping
 * leading env assignments (`FOO=1`), redirections, control keywords, and
 * benign command wrappers (`env`, `command`, `nohup`, `nice`, `time`, `timeout`,
 * `exec`, `stdbuf`, `builtin`, `caffeinate`), then resolving the executable
 * basename (`/bin/rm` -> `rm`).
 *
 * Preserves read-only lookup semantics for `command -v` / `command -V` so
 * existence probes do not trigger false alarms.
 */
export function normalizeExecutableSegment(segment: string): NormalizedSegment {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let idx = 0;

  // Bounded normalization loop
  for (let guard = 0; guard < 32 && idx < tokens.length; guard++) {
    const tok = tokens[idx]!;

    // Strip leading parentheses attached to a token, e.g. `(rm`
    if (tok.startsWith('(') && tok.length > 1) {
      tokens[idx] = tok.slice(1);
      continue;
    }

    if (LEADING_SHELL_KEYWORDS.has(tok)) {
      idx++;
      continue;
    }

    if (isStandaloneRedirectOperator(tok)) {
      idx += 2; // operator + filename
      continue;
    }
    if (isAttachedRedirectToken(tok)) {
      idx++;
      continue;
    }

    if (isEnvAssignmentToken(tok)) {
      idx++;
      continue;
    }

    const base = resolveExecutableBasename(tok);

    if (base === 'env') {
      idx++;
      while (idx < tokens.length) {
        const next = tokens[idx]!;
        if (next === '--') {
          idx++;
          break;
        }
        if (next === '-u' || next === '-c' || next === '-s' || next === '--unset' || next === '--chdir') {
          idx += 2;
          continue;
        }
        if (next.startsWith('-')) {
          idx++;
          continue;
        }
        if (isEnvAssignmentToken(next)) {
          idx++;
          continue;
        }
        break;
      }
      continue;
    }

    if (base === 'command') {
      let scan = idx + 1;
      let isQueryOnly = false;
      while (scan < tokens.length) {
        const next = tokens[scan]!;
        if (next === '--') {
          scan++;
          break;
        }
        if (next.startsWith('-') && next.length > 1) {
          // POSIX `command -v` and `command -V` only look up the path; never execute
          if (next.includes('v')) {
            isQueryOnly = true;
          }
          scan++;
          continue;
        }
        break;
      }
      if (isQueryOnly) {
        const rest = tokens.slice(idx);
        return {
          normalized: rest.join(' '),
          executable: 'command',
          args: rest.slice(1),
          isReadOnlyLookup: true
        };
      }
      idx = scan;
      continue;
    }

    if (base === 'nohup' || base === 'builtin') {
      idx++;
      if (tokens[idx] === '--') idx++;
      continue;
    }

    if (base === 'time') {
      idx++;
      while (idx < tokens.length && tokens[idx]!.startsWith('-')) {
        if (tokens[idx] === '--') {
          idx++;
          break;
        }
        idx++;
      }
      continue;
    }

    if (base === 'nice') {
      idx++;
      while (idx < tokens.length && tokens[idx]!.startsWith('-')) {
        const flag = tokens[idx]!;
        if (flag === '--') {
          idx++;
          break;
        }
        if (flag === '-n' || flag === '--adjustment') {
          idx += 2;
          continue;
        }
        idx++;
      }
      continue;
    }

    if (base === 'exec') {
      idx++;
      while (idx < tokens.length && tokens[idx]!.startsWith('-')) {
        const flag = tokens[idx]!;
        if (flag === '--') {
          idx++;
          break;
        }
        if (flag === '-a') {
          idx += 2;
          continue;
        }
        idx++;
      }
      continue;
    }

    if (base === 'stdbuf') {
      idx++;
      while (idx < tokens.length && tokens[idx]!.startsWith('-')) {
        const flag = tokens[idx]!;
        if (flag === '--') {
          idx++;
          break;
        }
        if (flag === '-i' || flag === '-o' || flag === '-e') {
          idx += 2;
          continue;
        }
        idx++;
      }
      continue;
    }

    if (base === 'caffeinate') {
      idx++;
      while (idx < tokens.length && tokens[idx]!.startsWith('-')) {
        const flag = tokens[idx]!;
        if (flag === '--') {
          idx++;
          break;
        }
        if (flag === '-t' || flag === '-w') {
          idx += 2;
          continue;
        }
        idx++;
      }
      continue;
    }

    if (base === 'timeout') {
      idx++;
      while (idx < tokens.length && tokens[idx]!.startsWith('-')) {
        const flag = tokens[idx]!;
        if (flag === '--') {
          idx++;
          break;
        }
        if (flag === '-k' || flag === '-s' || flag === '--signal' || flag === '--kill-after') {
          idx += 2;
          continue;
        }
        idx++;
      }
      // Consume duration operand (e.g. `10`, `30s`, `2m`)
      if (idx < tokens.length && /^\d+(?:\.\d+)?[smhd]?$/.test(tokens[idx]!)) {
        idx++;
      }
      continue;
    }

    break;
  }

  if (idx >= tokens.length) {
    return { normalized: '', executable: '', args: [], isReadOnlyLookup: false };
  }

  const executable = resolveExecutableBasename(tokens[idx]!);
  const args = tokens.slice(idx + 1);
  const normalized = args.length > 0 ? `${executable} ${args.join(' ')}` : executable;

  return {
    normalized,
    executable,
    args,
    isReadOnlyLookup: false
  };
}

/**
 * Splits a raw command string into sequential/piped stages while ignoring
 * separators (`;`, `&&`, `||`, `|`, `&`, `\n`) inside single or double quotes.
 */
function splitRawIntoStages(rawCommand: string): string[] {
  const stages: string[] = [];
  let current = '';
  const len = rawCommand.length;
  let i = 0;
  let inSingle = false;
  let inDouble = false;

  const pushStage = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) stages.push(trimmed);
    current = '';
  };

  while (i < len) {
    const ch = rawCommand[i]!;
    const next = rawCommand[i + 1];

    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === '\\' && i + 1 < len) {
        current += ch + next;
        i += 2;
        continue;
      }
      current += ch;
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < len) {
      current += ch + next;
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      i++;
      continue;
    }

    if (ch === ';' || ch === '\n') {
      pushStage();
      i++;
      continue;
    }
    if (ch === '|' && next === '|') {
      pushStage();
      i += 2;
      continue;
    }
    if (ch === '&' && next === '&') {
      pushStage();
      i += 2;
      continue;
    }
    if (ch === '|') {
      pushStage();
      i++;
      continue;
    }
    if (ch === '&') {
      const prev = i > 0 ? rawCommand[i - 1] : '';
      if (prev === '>' || prev === '<' || next === '>') {
        current += ch;
        i++;
        continue;
      }
      pushStage();
      i++;
      continue;
    }

    current += ch;
    i++;
  }
  pushStage();
  return stages;
}

/**
 * Extracts unquoted and quoted file targets written via redirection (`>`, `>>`)
 * or `tee` across a raw command string without matching operators inside quotes.
 */
export function extractWriteTargetsFromRaw(rawCommand: string): string[] {
  const targets: string[] = [];
  const len = rawCommand.length;
  let i = 0;
  let inSingle = false;
  let inDouble = false;

  const readShellWord = (start: number): { word: string; nextIndex: number } => {
    let j = start;
    while (j < len && (rawCommand[j] === ' ' || rawCommand[j] === '\t')) j++;
    let word = '';
    while (j < len) {
      const c = rawCommand[j]!;
      if (c === ' ' || c === '\t' || c === '\n' || c === ';' || c === '|' || c === '&' || c === '<' || c === '>') {
        break;
      }
      if (c === "'") {
        j++;
        while (j < len && rawCommand[j] !== "'") {
          word += rawCommand[j];
          j++;
        }
        if (j < len) j++;
        continue;
      }
      if (c === '"') {
        j++;
        while (j < len && rawCommand[j] !== '"') {
          if (rawCommand[j] === '\\' && j + 1 < len) {
            word += rawCommand[j + 1];
            j += 2;
            continue;
          }
          word += rawCommand[j];
          j++;
        }
        if (j < len) j++;
        continue;
      }
      if (c === '\\' && j + 1 < len) {
        word += rawCommand[j + 1];
        j += 2;
        continue;
      }
      word += c;
      j++;
    }
    return { word, nextIndex: j };
  };

  while (i < len) {
    const ch = rawCommand[i]!;
    if (inSingle) {
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === '\\' && i + 1 < len) {
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < len) {
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i++;
      continue;
    }

    if (ch === '>') {
      // Handle `>>`, `>|`, and `>&`: FD duplications (`2>&1`, `>&2`, `>&-`) are not files,
      // whereas `>& file` in Bash/Zsh redirects stdout+stderr to `file`.
      let next = i + 1;
      if (rawCommand[next] === '&') {
        const { word, nextIndex } = readShellWord(next + 1);
        if (word && !/^(?:\d+-?|-)$/.test(word)) {
          targets.push(word);
        }
        i = nextIndex;
        continue;
      }
      if (rawCommand[next] === '>' || rawCommand[next] === '|') {
        next++;
      }
      const { word, nextIndex } = readShellWord(next);
      if (word && !word.startsWith('&')) {
        targets.push(word);
      }
      i = nextIndex;
      continue;
    }

    i++;
  }

  // Also capture `tee [-a|-i] <target...>` destinations on unquoted pipe/command stages
  const stages = splitRawIntoStages(rawCommand);
  for (const seg of stages) {
    const words = tokenizeRawShellWords(seg);
    if (words.length < 2) continue;
    const norm = normalizeExecutableSegment(words.map(w => w.toLowerCase()).join(' '));
    if (norm.executable === 'tee') {
      // Re-scan original-case words after the `tee` token
      const teeIndex = words.findIndex(w => resolveExecutableBasename(w.toLowerCase()) === 'tee');
      if (teeIndex !== -1) {
        for (let k = teeIndex + 1; k < words.length; k++) {
          const arg = words[k]!;
          if (arg === '--') continue;
          if (arg.startsWith('-')) continue;
          targets.push(arg);
        }
      }
    }
  }

  return targets;
}

function tokenizeRawShellWords(segment: string): string[] {
  const words: string[] = [];
  const len = segment.length;
  let i = 0;

  while (i < len) {
    while (i < len && (segment[i] === ' ' || segment[i] === '\t' || segment[i] === '\n')) i++;
    if (i >= len) break;

    let word = '';
    while (i < len) {
      const ch = segment[i]!;
      if (ch === ' ' || ch === '\t' || ch === '\n') break;
      if (ch === "'") {
        i++;
        while (i < len && segment[i] !== "'") {
          word += segment[i];
          i++;
        }
        if (i < len) i++;
        continue;
      }
      if (ch === '"') {
        i++;
        while (i < len && segment[i] !== '"') {
          if (segment[i] === '\\' && i + 1 < len) {
            word += segment[i + 1];
            i += 2;
            continue;
          }
          word += segment[i];
          i++;
        }
        if (i < len) i++;
        continue;
      }
      if (ch === '\\' && i + 1 < len) {
        word += segment[i + 1];
        i += 2;
        continue;
      }
      word += ch;
      i++;
    }
    if (word.length > 0) words.push(word);
  }
  return words;
}

/**
 * Detects destructive recursive-force removals regardless of flag order or
 * flag bundling (e.g. `rm -r -f /`, `rm -f -r ~`, `rm -rfv /`, `rm --recursive --force *`).
 */
export function isExtremeRemovalSegment(seg: NormalizedSegment): boolean {
  if (seg.executable !== 'rm') return false;

  let hasRecursive = false;
  let hasForce = false;
  const targets: string[] = [];
  let endOfFlags = false;

  for (const arg of seg.args) {
    if (!endOfFlags && arg === '--') {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && arg.startsWith('--')) {
      if (arg === '--recursive') hasRecursive = true;
      if (arg === '--force') hasForce = true;
      continue;
    }
    if (!endOfFlags && arg.startsWith('-') && arg.length > 1) {
      const flags = arg.slice(1);
      if (flags.includes('r')) hasRecursive = true;
      if (flags.includes('f')) hasForce = true;
      continue;
    }
    targets.push(arg);
  }

  if (!hasRecursive || !hasForce) return false;

  for (const target of targets) {
    if (
      target === '/' ||
      target.startsWith('/') ||
      target === '~' ||
      target.startsWith('~/') ||
      target.startsWith('~') ||
      target.startsWith('*') ||
      target === '$home' ||
      target.startsWith('$home/') ||
      target === '${home}' ||
      target.startsWith('${home}/')
    ) {
      // Allow `/tmp/...`? Wait — `rm -rf /tmp/foo` is dangerous, not necessarily root wipe,
      // EXCEPT existing classifier explicitly treated `/rm\s+(-rf|-fr)\s+[\/~]/` as extreme!
      // Preserve exact strictness: any leading `/` or `~` or `*` with recursive+force is extreme.
      return true;
    }
  }
  return false;
}

/**
 * Detects fetch-and-execute pipelines (`curl ... | bash`, `wget ... | /bin/zsh`,
 * `curl ... | sudo sh`, `curl ... | env bash`) in linear time.
 */
export function isFetchAndExecPipeline(pipelines: readonly (readonly NormalizedSegment[])[]): boolean {
  for (const pipeline of pipelines) {
    if (pipeline.length < 2) continue;
    let sawFetcher = false;
    for (const stage of pipeline) {
      if (stage.executable === 'curl' || stage.executable === 'wget') {
        sawFetcher = true;
        continue;
      }
      if (!sawFetcher) continue;
      if (SHELL_INTERPRETERS.has(stage.executable)) return true;
      // Handle `curl ... | sudo bash`, `curl ... | sudo -E sh`, `curl ... | sudo -u root bash`
      if (stage.executable === 'sudo' || stage.executable === 'su') {
        const valueFlags = new Set([
          '-u', '-g', '-c', '-d', '-h', '-p', '-r', '-t', '-a', '-s',
          '--user', '--group', '--prompt', '--chdir', '--shell'
        ]);
        for (let i = 0; i < stage.args.length; i++) {
          const arg = stage.args[i]!;
          if (arg === '--') {
            const next = stage.args[i + 1];
            if (next && SHELL_INTERPRETERS.has(resolveExecutableBasename(next))) return true;
            break;
          }
          if (arg.startsWith('-')) {
            if (valueFlags.has(arg)) i++;
            continue;
          }
          if (SHELL_INTERPRETERS.has(resolveExecutableBasename(arg))) return true;
          break;
        }
      }
    }
  }
  return false;
}

export interface AnalyzedShellCommand {
  maskedTopLevel: string;
  allRawUnits: string[];
  allMaskedUnits: string[];
  normalizedSegments: NormalizedSegment[];
  unwrappedRawSegments: NormalizedSegment[];
  normalizedPipelines: NormalizedSegment[][];
  writeTargets: string[];
}

/**
 * Parses a shell command string (including nested `$(...)` and backtick
 * substitutions) into normalized executable segments, pipelines, and write targets.
 */
export function analyzeShellCommand(rawCommand: string): AnalyzedShellCommand {
  const lower = rawCommand.trim().toLowerCase();
  const topParsed = parseMaskAndExtractSubstitutions(lower, 0);

  const allRawUnits: string[] = [rawCommand.trim()];
  const allMaskedUnits: string[] = [topParsed.masked];

  // Also keep original-case substitutions for accurate path-target extraction
  const rawCaseParsed = parseMaskAndExtractSubstitutions(rawCommand.trim(), 0);
  for (const sub of rawCaseParsed.substitutions) {
    allRawUnits.push(sub);
  }
  for (const sub of topParsed.substitutions) {
    const subParsed = parseMaskAndExtractSubstitutions(sub, MAX_SUBSTITUTION_DEPTH);
    allMaskedUnits.push(subParsed.masked);
  }

  const normalizedSegments: NormalizedSegment[] = [];
  const normalizedPipelines: NormalizedSegment[][] = [];

  for (const unit of allMaskedUnits) {
    const { pipelines } = splitIntoPipelinesAndSegments(unit);
    for (const pipeline of pipelines) {
      const normPipeline: NormalizedSegment[] = [];
      for (const stage of pipeline) {
        const norm = normalizeExecutableSegment(stage);
        if (norm.normalized.length > 0) {
          normalizedSegments.push(norm);
          normPipeline.push(norm);
        }
      }
      if (normPipeline.length > 0) {
        normalizedPipelines.push(normPipeline);
      }
    }
  }

  const unwrappedRawSegments: NormalizedSegment[] = [];
  const writeTargets: string[] = [];
  for (const rawUnit of allRawUnits) {
    for (const target of extractWriteTargetsFromRaw(rawUnit)) {
      writeTargets.push(target);
    }
    for (const stage of splitRawIntoStages(rawUnit)) {
      const words = tokenizeRawShellWords(stage);
      if (words.length === 0) continue;
      const norm = normalizeExecutableSegment(words.map(w => w.toLowerCase()).join(' '));
      if (norm.normalized.length > 0) {
        unwrappedRawSegments.push(norm);
      }
    }
  }

  return {
    maskedTopLevel: topParsed.masked,
    allRawUnits,
    allMaskedUnits,
    normalizedSegments,
    unwrappedRawSegments,
    normalizedPipelines,
    writeTargets
  };
}
