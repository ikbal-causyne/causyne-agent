import path from 'node:path';
import os from 'node:os';
import { isIP } from 'node:net';
import { loadConfig, type CausyneConfig } from './config.js';
import { isDevEmulator } from './devMode.js';
import { validateBrowserActSandbox } from './browser/causyneBrowser.js';
import { isPhysicalPathAllowed } from './agent/workspaceBoundary.js';
import {
  isBlockedWorkspaceRoot,
  isExtendedCredentialPath,
  isSensitiveWriteTarget,
  analyzeShellCommand,
  isExtremeRemovalSegment,
  isFetchAndExecPipeline
} from './sandboxPolicy.js';

export type RiskLevel = 'safe' | 'moderate' | 'dangerous' | 'extreme' | 'forbidden';

export interface SandboxVerdict {
  allowed: boolean;
  risk: RiskLevel;
  reason?: string | undefined;
}

export interface SandboxOptions {
  workspaceRoot?: string | undefined;
  [key: string]: unknown;
}

const READ_ONLY_INVOCATIONS: Record<string, RegExp> = {
  brew: /^brew\s+(--version|-v|list|info|search|config|outdated|deps|home|--prefix|--cellar)\b/,
  apt: /^apt\s+(--version|list|show|search|policy)\b/,
  'apt-get': /^apt-get\s+(--version|-v)\b/,
  yum: /^yum\s+(--version|list|info|search)\b/,
  dnf: /^dnf\s+(--version|list|info|search)\b/,
  systemctl: /^systemctl\s+(status|show|cat|is-active|is-enabled|is-failed|list-units|list-unit-files|--version)\b/,
  service: /^service\s+[\w.@-]+\s+status\b/,
  crontab: /^crontab\s+-l\b/,
  kill: /^kill\s+(-l|-0)\b/,
  git: /^git\s+reset\s+(--\s*)?$/
};

function hasLinearPipeToShell(lowerText: string): boolean {
  const pipeIdx = lowerText.indexOf('|');
  if (pipeIdx === -1) return false;
  const beforePipe = lowerText.slice(0, pipeIdx);
  if (!/\b(?:curl|wget)\s/.test(beforePipe)) return false;
  const afterPipe = lowerText.slice(pipeIdx + 1).trimStart();
  return /^(?:sh|bash)(?:\s|$)/.test(afterPipe);
}

function hasRansomwareKeyword(lowerText: string): boolean {
  if (lowerText.includes('ransomware')) return true;
  const encIdx = lowerText.indexOf('encrypt');
  return encIdx !== -1 && lowerText.indexOf('ransom', encIdx + 7) !== -1;
}

function hasDangerousFindAction(unit: string): boolean {
  const findMatch = /\bfind\b/.exec(unit);
  if (!findMatch) return false;
  const tail = unit.slice(findMatch.index + findMatch[0].length);
  return /\s-(?:exec|execdir|delete)\b/.test(tail);
}

function isReadOnlyInvocation(segment: unknown): boolean {
  const text = String(segment || '').trim();
  const leadingWord = text.split(/\s+/)[0] || '';
  if (!leadingWord || !Object.hasOwn(READ_ONLY_INVOCATIONS, leadingWord)) return false;
  const pattern = READ_ONLY_INVOCATIONS[leadingWord];
  return Boolean(pattern && pattern.test(text));
}

const INTERPRETER_INVOCATION = /(^|\s)(sh|bash|zsh|ksh|dash|fish|eval|xargs|ssh|sudo|env|nohup|command|perl|ruby|awk|gawk|mawk|tclsh|php|lua|luajit|python3|python|pwsh|powershell|node|deno|bun|rscript)(\s|$)/i;

const CREDENTIAL_PATHS: readonly RegExp[] = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.kube(\/|$)/,
  /(^|\/)Library\/Keychains(\/|$)/i,
  /(^|\/)\.causyne(\/|$)/,
  /(^|\/)\.envrc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.pgpass$/i,
  /(^|\/)\.my\.cnf$/i
];

export function isCredentialPath(targetPath: unknown): boolean {
  if (typeof targetPath !== 'string' || targetPath.length === 0 || targetPath.includes('\0')) return false;
  const normalized = targetPath.replace(/\\/g, '/');
  return CREDENTIAL_PATHS.some(pattern => pattern.test(normalized)) || isExtendedCredentialPath(normalized);
}

const SENSITIVE_WRITE_TARGETS: readonly RegExp[] = [
  /(^|\/)\.(bashrc|bash_profile|bash_login|profile|zshrc|zprofile|zshenv|zlogin)$/,
  /(^|\/)\.config\/fish\/config\.fish$/,
  /(^|\/)\.ssh\//,
  /(^|\/)\.aws\//,
  /(^|\/)\.kube\//,
  /(^|\/)\.gnupg\//,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.(npmrc|netrc|git-credentials|pypirc|envrc)$/,
  /(^|\/)\.git\/(hooks(\/|$)|config$)/,
  /(^|\/)(crontab|cron\.d)(\/|$)/,
  /\/etc\//,
  /(^|\/)\.causyne\//
];

function redirectionTargets(maskedCommand: string): string[] {
  const targets: string[] = [];
  const pattern = /(?:^|[^0-9&>])>>?\s*([^\s;|&<>]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(maskedCommand)) !== null) {
    const target = match[1];
    if (!target || target.startsWith('&')) continue;
    targets.push(target);
  }
  return targets;
}

function redirectsIntoSensitiveTarget(maskedCommand: string): boolean {
  for (const target of redirectionTargets(maskedCommand)) {
    const normalizedTarget = target.replace(/^~/, '/home/user');
    for (const pattern of SENSITIVE_WRITE_TARGETS) {
      if (pattern.test(normalizedTarget)) return true;
    }
  }
  return false;
}

export class Sandbox {
  config: CausyneConfig;
  workspacePaths: string[];
  grantAllAccess: boolean;
  allowedTools: string[];
  deniedTools: Set<string>;
  parentLoop?: any;
  signal?: AbortSignal | undefined;

  constructor(options?: SandboxOptions | null) {
    const safeOptions = options && typeof options === 'object' ? options : {};
    const candidateRoot = typeof safeOptions.workspaceRoot === 'string' && safeOptions.workspaceRoot.trim()
      ? safeOptions.workspaceRoot.trim()
      : process.cwd();
    this.config = loadConfig();
    this.workspacePaths = isBlockedWorkspaceRoot(candidateRoot) ? [] : [path.resolve(candidateRoot)];
    const devMode = isDevEmulator(this.config);
    this.grantAllAccess = devMode ? true : (this.config.grantAllAccess || false);
    const rawAllowed = devMode ? ['*'] : (Array.isArray(this.config.allowedTools) ? this.config.allowedTools : ['*']);
    this.allowedTools = rawAllowed.map((name: unknown) => String(name).replace(/\./g, '_'));
    this.deniedTools = new Set(
      (devMode ? [] : (this.config.deniedTools || []))
        .map((name: unknown) => String(name).replace(/\./g, '_'))
    );
  }

  updateWorkspacePaths(newPaths: unknown): { success: boolean; paths?: string[]; reason?: string } {
    if (Array.isArray(newPaths) && newPaths.length > 0) {
      const safePaths = newPaths
        .filter((p): p is string => typeof p === 'string' && !isBlockedWorkspaceRoot(p))
        .map(p => path.resolve(p));

      if (safePaths.length > 0) {
        this.workspacePaths = safePaths;
        return { success: true, paths: this.workspacePaths };
      }
    }
    return { success: false, reason: 'Invalid or blocked paths provided' };
  }

  addWorkspacePath(newPath: unknown): string[] {
    if (typeof newPath !== 'string' || isBlockedWorkspaceRoot(newPath)) {
      return this.workspacePaths;
    }
    const resolved = path.resolve(newPath);
    if (!this.workspacePaths.includes(resolved)) {
      this.workspacePaths.push(resolved);
    }
    return this.workspacePaths;
  }

  validate(toolName: string, args: any): SandboxVerdict {
    const canonicalToolName = String(toolName || '').replace(/\./g, '_');
    if (this.deniedTools.has(canonicalToolName)) {
      return { allowed: false, reason: `Tool ${toolName} is denied by local policy`, risk: 'forbidden' };
    }
    if (!this.allowedTools.includes('*') && !this.allowedTools.includes(canonicalToolName)) {
      return { allowed: false, reason: `Tool ${toolName} not allowed on current tier`, risk: 'forbidden' };
    }

    const safeArgs: Record<string, any> = args && typeof args === 'object' ? args : {};
    const pathsToCheck: unknown[] = [];
    if (canonicalToolName !== 'fs_read_skill') {
      const PATH_ARGUMENTS = [
        'path', 'searchPath', 'cwd', 'source', 'destination',
        'file_path', 'filePath', 'filepath', 'directory',
        'targetFile', 'outputFile', 'outputPath'
      ];
      for (const field of PATH_ARGUMENTS) {
        if (safeArgs[field]) pathsToCheck.push(safeArgs[field]);
      }
      if (Array.isArray(safeArgs.target_directories)) {
        for (const dir of safeArgs.target_directories) {
          if (typeof dir === 'string' && dir.trim()) pathsToCheck.push(dir);
        }
      }
    }

    for (const p of pathsToCheck) {
      if (typeof p === 'string' && !this.isPathAllowed(p)) {
        return { allowed: false, reason: `Path outside allowed workspace: ${p}`, risk: 'dangerous' };
      }
    }

    let credentialPathHit: string | null = null;
    for (const p of pathsToCheck) {
      if (typeof p === 'string' && isCredentialPath(p)) {
        credentialPathHit = p;
        break;
      }
    }

    const withCredentialEscalation = (verdict: SandboxVerdict): SandboxVerdict => {
      if (!verdict.allowed || !credentialPathHit) return verdict;
      return {
        allowed: true,
        risk: 'extreme',
        reason: verdict.reason
          ? `${verdict.reason} (touches credential material: ${credentialPathHit})`
          : `Touches credential material: ${credentialPathHit}`
      };
    };

    if (canonicalToolName === 'sysRun' || canonicalToolName === 'sysRunBg' || canonicalToolName === 'terminal_persistent_shell') {
      const command = safeArgs.command || safeArgs.input;
      if (command) {
        const risk = this.classifyCommandRisk(command);
        if (risk === 'forbidden') {
          return { allowed: false, reason: 'Command is permanently blocked for safety', risk: 'forbidden' };
        }
        return withCredentialEscalation({ allowed: true, risk });
      }
      return withCredentialEscalation({ allowed: true, risk: 'moderate' });
    }

    if (canonicalToolName === 'gitOp') {
      const command = String(safeArgs.command || '');
      const risk = this.classifyCommandRisk(`git ${command}`);
      if (risk === 'forbidden') {
        return { allowed: false, reason: 'Command is permanently blocked for safety', risk: 'forbidden' };
      }
      return withCredentialEscalation({ allowed: true, risk: /\bbranch\s+-D\b/.test(command) ? 'dangerous' : risk });
    }

    if (canonicalToolName === 'web_fetch' && safeArgs.url) {
      if (this.isInternalUrl(safeArgs.url)) {
        return { allowed: false, reason: 'Cannot access internal/local network URLs (SSRF Protection)', risk: 'forbidden' };
      }
      if (safeArgs.outputFile) {
        return withCredentialEscalation({ allowed: true, risk: 'extreme', reason: 'Downloads network content to disk' });
      }
    }

    if (canonicalToolName === 'browser_act') {
      return withCredentialEscalation(validateBrowserActSandbox(
        safeArgs,
        this.workspacePaths[0] || process.cwd(),
        url => this.isInternalUrl(url, { allowLoopback: true }),
        targetPath => this.isPathAllowed(targetPath)
      ) as SandboxVerdict);
    }

    if (canonicalToolName === 'creative_apps') {
      const isReadOnly =
        safeArgs.action === 'status' ||
        safeArgs.action === 'verify_bridge' ||
        (safeArgs.action === 'live_bridge' && safeArgs.liveOperation === 'inspect_active');
      return withCredentialEscalation({ allowed: true, risk: isReadOnly ? 'safe' : 'dangerous' });
    }

    if (canonicalToolName === 'native_engine') {
      if (safeArgs.action === 'install') {
        return withCredentialEscalation({ allowed: true, risk: 'extreme', reason: 'Downloads and installs a native engine binary' });
      }
      const readOnly = ['status', 'catalog', 'describe', 'inspect', 'probe'];
      return withCredentialEscalation({ allowed: true, risk: readOnly.includes(String(safeArgs.action ?? '')) ? 'safe' : 'dangerous' });
    }

    if (canonicalToolName === 'game_asset_fetch' && safeArgs.action === 'download_asset') {
      if (!safeArgs.url || this.isInternalUrl(safeArgs.url)) {
        return { allowed: false, reason: 'Cannot download from an internal or invalid URL', risk: 'forbidden' };
      }
      return withCredentialEscalation({ allowed: true, risk: 'extreme', reason: 'Downloads a third-party asset to disk' });
    }

    if (canonicalToolName === 'manage_local_dependencies') {
      const heavyActions = ['pipInst', 'grant_capability', 'grant_mcp_server'];
      if (heavyActions.includes(String(safeArgs.action ?? ''))) {
        return withCredentialEscalation({ allowed: true, risk: 'extreme' });
      }
      return withCredentialEscalation({ allowed: true, risk: 'moderate' });
    }

    if (canonicalToolName === 'plugin_manager') {
      return withCredentialEscalation(['create', 'enable'].includes(String(safeArgs.action ?? ''))
        ? { allowed: true, risk: 'extreme', reason: 'Creates or trusts executable plugin code' }
        : { allowed: true, risk: 'safe' });
    }
    if (canonicalToolName.startsWith('plugin__')) {
      return withCredentialEscalation({ allowed: true, risk: 'extreme', reason: 'Executes an enabled local plugin' });
    }

    if (canonicalToolName === 'fs_delete') {
      if (typeof safeArgs.path === 'string' && !safeArgs.path.includes('.')) {
        return withCredentialEscalation({ allowed: true, risk: 'extreme' });
      }
      return withCredentialEscalation({ allowed: true, risk: 'dangerous' });
    }
    if (canonicalToolName === 'proc_term') {
      return withCredentialEscalation({ allowed: true, risk: 'dangerous' });
    }
    if (canonicalToolName === 'desktop_act' || canonicalToolName === 'computer_use') {
      return withCredentialEscalation({ allowed: true, risk: 'extreme' });
    }
    if (canonicalToolName === 'ui_forge' || canonicalToolName === 'document_forge') {
      return withCredentialEscalation({ allowed: true, risk: 'safe' });
    }
    if (canonicalToolName === 'fs_write' || canonicalToolName === 'fs_move' || canonicalToolName === 'fs_edit' || canonicalToolName === 'MultiEdit') {
      return withCredentialEscalation({ allowed: true, risk: 'moderate' });
    }

    return withCredentialEscalation({ allowed: true, risk: 'safe' });
  }

  isPathAllowed(targetPath: unknown): boolean {
    if (typeof targetPath !== 'string' || targetPath.length === 0) return false;
    const expand = (value: string): string => {
      if (value === '~') return os.homedir();
      if (value.startsWith('~/') || value.startsWith('~\\')) {
        return path.join(os.homedir(), value.slice(2));
      }
      return value;
    };
    const workspaces = Array.isArray(this.workspacePaths)
      ? this.workspacePaths.filter(item => typeof item === 'string').map(expand) : [];
    const baseDir = workspaces[0] ? path.resolve(workspaces[0]) : process.cwd();
    const expandedTarget = expand(targetPath);
    const resolvedTarget = path.isAbsolute(expandedTarget)
      ? expandedTarget
      : path.resolve(baseDir, expandedTarget);
    return isPhysicalPathAllowed(resolvedTarget, workspaces, this.grantAllAccess === true);
  }

  isInternalUrl(urlString: unknown, { allowLoopback = false }: { allowLoopback?: boolean } = {}): boolean {
    if (typeof urlString !== 'string' || !urlString.trim() || /[\r\n\0]/.test(urlString)) {
      return true;
    }
    try {
      const url = new URL(urlString.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return true;
      const rawHost = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
      const host = rawHost.split('%')[0] || '';
      if (!host) return true;
      const ipv6OnlyZerosAndOne = host.includes(':') && /^(?:0+:){0,7}0*1$/.test(host);
      const ipv6AllZeros = host.includes(':') && /^(?:0*:)+0*$/.test(host);
      const isLoopback = host === 'localhost'
        || host.endsWith('.localhost')
        || /^127\.\d+\.\d+\.\d+$/.test(host)
        || host === '::1'
        || ipv6OnlyZerosAndOne;
      if (allowLoopback && isLoopback) return false;
      if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;

      const blockedRegex = /^(localhost|0\.\d+\.\d+\.\d+|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|192\.168\.\d+\.\d+|192\.0\.(0|2)\.\d+|192\.88\.99\.\d+|198\.(18|19)\.\d+\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+|(22[4-9]|23\d|24\d|25[0-5])\.\d+\.\d+\.\d+)$/;
      if (blockedRegex.test(host)) return true;
      if (host === 'metadata.google.internal') return true;
      if (isIP(host) === 6) {
        if (host === '::' || host === '::1' || ipv6AllZeros || ipv6OnlyZerosAndOne) return true;
        if (/^(fc|fd|fe8|fe9|fea|feb|fec|fed|fee|fef|ff|2001:db8:|64:ff9b:|100::)/.test(host)) return true;
        if (host.startsWith('::ffff:') || host.startsWith('0:0:0:0:0:ffff:')) return true;
      }

      return false;
    } catch {
      return true;
    }
  }

  classifyCommandRisk(command: unknown): RiskLevel {
    if (!command || typeof command !== 'string') return 'safe';
    const normalized = command.trim().toLowerCase();

    const FORBIDDEN_PATTERNS: readonly RegExp[] = [
      /:\(\)\s*\{\s*:\|:&\s*\};/,
      /<\(\s*(curl|wget)\b/,
      />\s*\/dev\/sda/,
      /nmap\s+-s[STUVFN]/i,
      /sqlmap/i,
      /metasploit|msfconsole|msfvenom/i,
      /hydra\s+/i,
      /john\s+/i,
      /hashcat/i,
      /aircrack|airmon|aireplay/i,
      /ettercap|arpspoof|bettercap/i,
      /nikto/i,
      /xmrig|cpuminer|minerd/i
    ];

    const analyzed = analyzeShellCommand(command);
    if (hasLinearPipeToShell(normalized) || hasRansomwareKeyword(normalized)) return 'forbidden';
    for (const rawUnit of analyzed.allRawUnits) {
      const lowerUnit = rawUnit.toLowerCase();
      if (hasLinearPipeToShell(lowerUnit) || hasRansomwareKeyword(lowerUnit)) return 'forbidden';
    }
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(normalized)) return 'forbidden';
      for (const rawUnit of analyzed.allRawUnits) {
        if (pattern.test(rawUnit.toLowerCase())) return 'forbidden';
      }
    }
    if (isFetchAndExecPipeline(analyzed.normalizedPipelines)) return 'forbidden';

    const masked = analyzed.maskedTopLevel;

    if (
      redirectsIntoSensitiveTarget(masked) ||
      analyzed.writeTargets.some(target => isSensitiveWriteTarget(target))
    ) {
      return 'extreme';
    }

    const executesQuotedText = analyzed.allMaskedUnits.some(unit => INTERPRETER_INVOCATION.test(unit));
    const scanUnits = executesQuotedText
      ? analyzed.allRawUnits.map(u => u.toLowerCase())
      : analyzed.allMaskedUnits;

    const EXTREME_PATTERNS: readonly RegExp[] = [
      /rm\s+(-rf|-fr)\s+[\/~]/,
      /rm\s+(-rf|-fr)\s+\*/,
      /mkfs/,
      /dd\s+if=/,
      /shutdown|reboot|init\s+[06]/,
      /passwd|useradd|userdel/,
      /iptables|ufw\s+delete/,
      /format\s+[a-z]:/i,
      /diskpart/i
    ];

    for (const unit of scanUnits) {
      for (const pattern of EXTREME_PATTERNS) {
        if (pattern.test(unit)) return 'extreme';
      }
    }
    for (const seg of analyzed.normalizedSegments) {
      if (isExtremeRemovalSegment(seg)) return 'extreme';
    }
    for (const seg of analyzed.unwrappedRawSegments) {
      if (isExtremeRemovalSegment(seg)) return 'extreme';
    }

    const DANGEROUS_PREFIXES = [
      'rm ', 'sudo ', 'su ', 'chmod ', 'chown ',
      'apt ', 'apt-get ', 'brew ', 'yum ', 'dnf ',
      'git reset', 'git push --force', 'git push -f', 'git rebase',
      'kill ', 'pkill ', 'killall ',
      'ssh ', 'scp ', 'rsync ',
      'mv ', 'crontab ', 'systemctl ', 'service '
    ];

    for (const seg of analyzed.normalizedSegments) {
      if (seg.isReadOnlyLookup) continue;
      if (seg.executable === 'su') return 'dangerous';
      for (const prefix of DANGEROUS_PREFIXES) {
        if (seg.normalized.startsWith(prefix) && !isReadOnlyInvocation(seg.normalized)) {
          return 'dangerous';
        }
      }
    }

    for (const unit of scanUnits) {
      if (hasDangerousFindAction(unit)) return 'dangerous';
    }

    const MODERATE_PREFIXES = [
      'npm i', 'npm run', 'npx ', 'yarn ', 'pnpm ',
      'pip install', 'pip uninstall', 'pip3 ',
      'python', 'python3', 'node ', 'deno ', 'bun ',
      'perl ', 'ruby ', 'awk ', 'gawk ', 'php ', 'lua ', 'tclsh ', 'rscript ',
      'pwsh ', 'powershell ',
      'git add', 'git commit', 'git push', 'git pull', 'git checkout',
      'git merge', 'git branch', 'git tag',
      'mkdir', 'touch', 'cp ',
      'cargo ', 'go ', 'make', 'cmake', 'gcc', 'g++',
      'docker ', 'docker-compose ', 'podman ',
      'code ', 'open ', 'xdg-open ',
      'curl ', 'wget '
    ];

    for (const seg of analyzed.normalizedSegments) {
      if (seg.isReadOnlyLookup) continue;
      for (const prefix of MODERATE_PREFIXES) {
        if (seg.normalized.startsWith(prefix)) return 'moderate';
      }
    }

    return 'safe';
  }
}
