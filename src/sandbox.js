import path from 'path';
import os from 'os';
import { loadConfig } from './config.js';
import { isDevEmulator } from './devMode.js';


function maskQuotedSpans(text) {
  return text
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * Split a command line into the individual commands the shell will run.
 *
 * Prefix matching only ever inspected the FIRST word of the whole line, so any
 * leading token disguised everything after it: `cd ~/Documents && rm -f x` was
 * classified from `cd` and auto-executed with no approval. Each segment must be
 * judged on its own.
 */
function splitShellSegments(text) {
  return text
    .split(/&&|\|\||[;\n|&]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Read-only invocations of tools whose NAME is dangerous but whose subcommand
 * is not. Keyed by the leading word; the pattern must match the whole segment.
 *
 * WHY THIS EXISTS. `brew` is in DANGEROUS_PREFIXES because `brew install` runs
 * arbitrary install scripts. The prefix rule cannot tell that from
 * `brew --version`, so asking Blender's version escalated a chain to
 * DANGEROUS and put a red approval modal in front of the user. That is not a
 * cosmetic problem: a gate that cries wolf on `--version` is a gate people
 * learn to approve without reading, and then it is not a gate at all.
 *
 * THE RULE FOR ADDING TO THIS TABLE: the subcommand must be incapable of
 * changing anything — no install, no remove, no start/stop, no write. When in
 * doubt, leave it out; a false alarm is cheap and a missed one is not.
 *
 * `sudo` and `su` are deliberately absent and must stay absent: `sudo brew
 * --version` is a privilege escalation whatever follows it.
 */
const READ_ONLY_INVOCATIONS = {
  brew: /^brew\s+(--version|-v|list|info|search|config|outdated|deps|home|--prefix|--cellar)\b/,
  apt: /^apt\s+(--version|list|show|search|policy)\b/,
  'apt-get': /^apt-get\s+(--version|-v)\b/,
  yum: /^yum\s+(--version|list|info|search)\b/,
  dnf: /^dnf\s+(--version|list|info|search)\b/,
  systemctl: /^systemctl\s+(status|show|cat|is-active|is-enabled|is-failed|list-units|list-unit-files|--version)\b/,
  service: /^service\s+[\w.@-]+\s+status\b/,
  crontab: /^crontab\s+-l\b/,
  // `kill -l` lists signal names; `kill -0 PID` only probes whether a process
  // exists. Neither delivers a terminating signal.
  kill: /^kill\s+(-l|-0)\b/,
  git: /^git\s+reset\s+(--\s*)?$/
};

/**
 * True when a segment is a read-only use of an otherwise dangerous command.
 *
 * @param   {string} segment  One shell segment, already quote-masked.
 * @returns {boolean}
 */
function isReadOnlyInvocation(segment) {
  const text = String(segment || '').trim();
  const leadingWord = text.split(/\s+/)[0];
  const pattern = READ_ONLY_INVOCATIONS[leadingWord];
  return Boolean(pattern && pattern.test(text));
}

/**
 * Does this command line hand a string to something that will execute it?
 *
 * Quote masking is right for `echo "rm -rf /"` and wrong for
 * `bash -c "rm -rf ~"` — in the second the quoted text IS the payload. When an
 * interpreter is present we judge the raw line instead, so masking can never
 * downgrade a real destructive command.
 */
// Includes the scripting interpreters (perl/ruby/awk/python/node/…) so that a
// `python3 -c "import os; os.system('rm -rf ~')"` or `perl -e '...'` is judged on
// the RAW line: the destructive payload lives in the quoted argument, and without
// these an attacker could hide any command inside an interpreter string and have
// it read as merely 'moderate' (auto-run in Mode C). Matching only forces the raw
// line to be scanned — a benign `python3 script.py` still classifies as before.
const INTERPRETER_INVOCATION = /(^|\s)(sh|bash|zsh|ksh|dash|fish|eval|xargs|ssh|sudo|env|nohup|command|perl|ruby|awk|gawk|mawk|tclsh|php|lua|luajit|python3|python|pwsh|powershell|node|deno|bun|rscript)(\s|$)/i;

/**
 * Files where a single appended line changes what the machine does next, or who
 * can log into it. Written out plainly and unencoded — this is Vision section 10
 * defence code and must stay auditable.
 */
/**
 * Credential stores and key material.
 *
 * L4 (local-path audit): the DEFAULT workspace scope ends with the home
 * directory itself as a fallback, which silently puts ~/.ssh, ~/.aws and
 * ~/.causyne (the encrypted API key AND the .vault_key that decrypts it) inside
 * the agent's reach with no prompt. Vision section 4 asks for freedom WITH a
 * human in the loop rather than a wall, so these are not blocked — touching one
 * is classified 'extreme', which always requires explicit approval in every
 * autonomy mode, including Mode C.
 */
const CREDENTIAL_PATHS = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.kube(\/|$)/,
  /(^|\/)Library\/Keychains(\/|$)/i,
  // Causyne's own vault: config.json holds the encrypted provider key and
  // .vault_key is the key that decrypts it.
  /(^|\/)\.causyne(\/|$)/
];

export function isCredentialPath(targetPath) {
  if (typeof targetPath !== 'string' || targetPath.length === 0) return false;
  const normalized = targetPath.replace(/\\/g, '/');
  return CREDENTIAL_PATHS.some(pattern => pattern.test(normalized));
}

const SENSITIVE_WRITE_TARGETS = [
  // Shell startup files: an appended line runs on the user's next shell.
  /(^|\/)\.(bashrc|bash_profile|bash_login|profile|zshrc|zprofile|zshenv|zlogin)$/,
  /(^|\/)\.config\/fish\/config\.fish$/,
  // SSH: authorized_keys grants login; config can silently reroute connections.
  /(^|\/)\.ssh\//,
  // Scheduled execution.
  /(^|\/)(crontab|cron\.d)(\/|$)/,
  /\/etc\//,
  // Causyne's own state: config.json holds the encrypted API key and .vault_key
  // is the key that decrypts it.
  /(^|\/)\.causyne\//
];

/**
 * Extract the file targets a command line redirects into.
 *
 * Context-aware per rule ZM-09: `2>&1` and `>&2` are descriptor duplications,
 * not files, and must not be reported as write targets — a guard that fires on
 * those would be disabled within a day.
 */
function redirectionTargets(maskedCommand) {
  const targets = [];
  const pattern = /(?:^|[^0-9&>])>>?\s*([^\s;|&<>]+)/g;
  let match;
  while ((match = pattern.exec(maskedCommand)) !== null) {
    const target = match[1];
    if (!target || target.startsWith('&')) continue;
    targets.push(target);
  }
  return targets;
}

function redirectsIntoSensitiveTarget(maskedCommand) {
  for (const target of redirectionTargets(maskedCommand)) {
    const normalizedTarget = target.replace(/^~/, '/home/user');
    for (const pattern of SENSITIVE_WRITE_TARGETS) {
      if (pattern.test(normalizedTarget)) return true;
    }
  }
  return false;
}

export class Sandbox {
  constructor() {
    this.config = loadConfig();
    
    // V5 Upgrade: Expanded default workspace paths
    // Instead of only os.homedir() (which was too restrictive and caused path errors),
    // we now default to common user directories while still blocking system dirs.
    const home = os.homedir();
    this.workspacePaths = this.config.workspacePaths || [
      path.join(home, 'Desktop'),
      path.join(home, 'Documents'),
      path.join(home, 'Downloads'),
      path.join(home, 'Projects'),
      path.join(home, 'CausyneWorkspace'),
      path.join(home, 'Causyne'),
      home  // Fallback: allow home dir itself (covers edge cases like ~/scripts, ~/.config)
    ];
    
    // Developer emulator mode (hardened, secret-gated — see devMode.js) grants
    // full local access for agent development on a Fast-tier emulator. It cannot
    // be triggered by a bare env flag in the published package.
    const devMode = isDevEmulator(this.config);
    this.grantAllAccess = devMode ? true : (this.config.grantAllAccess || false);
    this.allowedTools = devMode ? ['*'] : (this.config.allowedTools || ['*']);
  }

  
  updateWorkspacePaths(newPaths) {
    if (Array.isArray(newPaths) && newPaths.length > 0) {
      // Validate: reject any system-critical paths
      const BLOCKED_ROOTS = ['/etc', '/usr', '/bin', '/sbin', '/System', '/var', '/private', '/Library'];
      const safePaths = newPaths.filter(p => {
        const resolved = path.resolve(p);
        return !BLOCKED_ROOTS.some(blocked => resolved.startsWith(blocked));
      });
      
      if (safePaths.length > 0) {
        this.workspacePaths = safePaths;
        return { success: true, paths: this.workspacePaths };
      }
    }
    return { success: false, reason: 'Invalid or blocked paths provided' };
  }

  // V5: Add a single workspace path
  addWorkspacePath(newPath) {
    const resolved = path.resolve(newPath);
    if (!this.workspacePaths.includes(resolved)) {
      this.workspacePaths.push(resolved);
    }
    return this.workspacePaths;
  }

  validate(toolName, args) {
    // 1. Tool availability check
    if (!this.allowedTools.includes('*') && !this.allowedTools.includes(toolName)) {
      return { allowed: false, reason: `Tool ${toolName} not allowed on current tier`, risk: 'forbidden' };
    }

    // 2. Path scoping.
    // Tools do not agree on what to call their path argument: MultiEdit uses
    // file_path, the Blender/Godot automators use filepath and directory, the
    // media tools use outputPath. Checking only `path` let all of those write
    // outside the workspace unchallenged.
    const PATH_ARGUMENTS = ['path', 'cwd', 'source', 'destination', 'file_path', 'filepath', 'directory', 'targetFile', 'outputFile', 'outputPath'];
    const pathsToCheck = [];
    for (const field of PATH_ARGUMENTS) {
      if (args[field]) pathsToCheck.push(args[field]);
    }

    for (const p of pathsToCheck) {
      if (typeof p === 'string' && !this.isPathAllowed(p)) {
        return { allowed: false, reason: `Path outside allowed workspace: ${p}`, risk: 'dangerous' };
      }
    }

    // L4: a credential store is in reach by default (the home fallback), so it
    // gets a human in the loop rather than a wall. 'extreme' is the one risk
    // level Mode C cannot auto-approve.
    for (const p of pathsToCheck) {
      if (typeof p === 'string' && isCredentialPath(p)) {
        return { allowed: true, risk: 'extreme', reason: `Touches credential material: ${p}` };
      }
    }

    // 3. Command classification (for terminal tools).
    // terminal_persistent_shell runs arbitrary commands exactly like sysRun does
    // and must go through the same classifier — it previously bypassed it.
    if (toolName === 'sysRun' || toolName === 'sysRunBg' || toolName === 'terminal_persistent_shell') {
      const command = args.command || args.input;
      if (command) {
        const risk = this.classifyCommandRisk(command);
        if (risk === 'forbidden') {
          return { allowed: false, reason: 'Command is permanently blocked for safety', risk: 'forbidden' };
        }
        return { allowed: true, risk };
      }
      return { allowed: true, risk: 'moderate' };
    }

    // 4. SSRF protection (for web fetch)
    if (toolName === 'web_fetch' && args.url) {
      if (this.isInternalUrl(args.url)) {
        return { allowed: false, reason: 'Cannot access internal/local network URLs (SSRF Protection)', risk: 'forbidden' };
      }
      if (args.outputFile) {
        return { allowed: true, risk: 'extreme', reason: 'Downloads network content to disk' };
      }
    }

    if (toolName === 'game_asset_fetch' && args.action === 'download_asset') {
      if (!args.url || this.isInternalUrl(args.url)) {
        return { allowed: false, reason: 'Cannot download from an internal or invalid URL', risk: 'forbidden' };
      }
      return { allowed: true, risk: 'extreme', reason: 'Downloads a third-party asset to disk' };
    }
    
    // Heavy AI downloads ALWAYS require consent (even in Mode C)
    if (toolName === 'manage_local_dependencies') {
      // grant_capability installs third-party packages into the user's home
      // directory, so it belongs in exactly the same consent class as the other
      // download actions. Routing it here is what keeps ZM-01 true: nothing is
      // ever installed without an explicit human approval.
      const heavyActions = ['pipInst', 'grant_capability', 'grant_mcp_server'];
      if (heavyActions.includes(args.action)) {
        return { allowed: true, risk: 'extreme' }; // Upgraded from dangerous to extreme for safe C Mode handling
      }
      return { allowed: true, risk: 'moderate' };
    }
    
    // Tools that overwrite or delete are inherently dangerous.
    // These comparisons used the dotted schema names (`fs.delete`, `proc.term`,
    // `fs.write`) while validate() is always called with the canonical wire name
    // (`fs_delete`, ...), so none of them ever matched: the Human-in-the-Loop
    // approval gate for destructive operations had never once fired.
    if (toolName === 'fs_delete') {
      // If wiping an entire directory tree, flag as extreme
      if (args.path && !args.path.includes('.')) {
         return { allowed: true, risk: 'extreme' };
      }
      return { allowed: true, risk: 'dangerous' };
    }
    if (toolName === 'proc_term') {
      return { allowed: true, risk: 'dangerous' };
    }
    // Driving the mouse and keyboard reaches every application the user is
    // signed into — mail, banking, anything with a session open. There is no
    // safe subset and no autonomy mode in which it should run unannounced, so
    
    // Mode C. Section 4 says gated, not walled — the capability is real, the
    // human just says yes first.
    if (toolName === 'desktop_act') {
      return { allowed: true, risk: 'extreme' };
    }
    if (toolName === 'fs_write' || toolName === 'fs_move' || toolName === 'fs_edit' || toolName === 'MultiEdit') {
      return { allowed: true, risk: 'moderate' };
    }

    return { allowed: true, risk: 'safe' };
  }

  isPathAllowed(targetPath) {
    // Expand ~
    let resolved = targetPath;
    if (resolved.startsWith('~/')) {
      resolved = path.join(os.homedir(), resolved.slice(2));
    }
    resolved = path.resolve(resolved);
    
    // V5: Block system-critical paths BEFORE checking allowed paths (OS Protection)
    const isWindows = os.platform() === 'win32';
    let isBlocked = false;
    
    if (isWindows) {
      const WIN_BLOCKED = ['C:\\Windows', 'C:\\Program Files', 'C:\\ProgramData'];
      isBlocked = WIN_BLOCKED.some(blocked => resolved.toLowerCase().startsWith(blocked.toLowerCase()));
    } else {
      const UNIX_BLOCKED = ['/etc', '/usr/bin', '/usr/sbin', '/sbin', '/bin', '/System', '/private/var'];
      isBlocked = UNIX_BLOCKED.some(blocked => resolved.startsWith(blocked));
    }

    if (isBlocked) {
      return false;
    }
    
    // V7 Ultimate Self-Preservation: Block access to the agent's own source code
    // The AGI cannot read, modify, or delete causyne-agent itself.
    const agentBinOrScript = process.argv[1] || '';
    let agentRoot = '';
    if (agentBinOrScript && agentBinOrScript.includes('causyne-agent')) {
      const idx = agentBinOrScript.lastIndexOf('causyne-agent');
      agentRoot = path.resolve(agentBinOrScript.slice(0, idx + 'causyne-agent'.length));
    } else if (typeof __dirname !== 'undefined') {
      agentRoot = path.resolve(__dirname, '..');
    }
    if (agentRoot && resolved.startsWith(agentRoot) && resolved !== path.resolve(os.homedir())) {
      return false;
    }
    
    // V6: Override workspace limits if grantAllAccess is active
    if (this.grantAllAccess) {
      return true;
    }
    
    // Check if resolved path is inside any allowed workspace path.
    //
    // L2 (local-path audit): this was a bare `resolved.startsWith(allowedBase)`,
    // which is a STRING prefix test, not a PATH containment test. With the scope
    // set to /Users/x/Projects it also accepted /Users/x/Projects-secret and
    // /Users/x/ProjectsBACKUP — any sibling whose name merely begins with the
    // workspace name. The separator check is what makes it a directory boundary.
    return this.workspacePaths.some(workspace => {
      let allowedBase = workspace;
      if (allowedBase.startsWith('~/')) {
        allowedBase = path.join(os.homedir(), allowedBase.slice(2));
      }
      allowedBase = path.resolve(allowedBase);
      return resolved === allowedBase || resolved.startsWith(allowedBase + path.sep);
    });
  }

  isInternalUrl(urlString) {
    try {
      const url = new URL(urlString);
      const host = url.hostname;
      
      // Block localhost, private IPs, cloud metadata
      const blockedRegex = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0)$/;
      if (blockedRegex.test(host)) return true;
      
      return false;
    } catch(e) {
      return true; // If URL is unparseable, block it to be safe
    }
  }

  classifyCommandRisk(command) {
    if (!command) return 'safe';
    const normalized = command.trim().toLowerCase();

    // FORBIDDEN — absolute blocklist (Technical + Ethical Safety Net Layer 3)
    const FORBIDDEN_PATTERNS = [
      /:\(\)\s*\{\s*:\|:&\s*\};/,
      /curl\s+.*\|\s*(sh|bash)/,
      /wget\s+.*\|\s*(sh|bash)/,
      // Process substitution — `bash <(curl …)` / `sh <(wget …)` fetch-and-run,
      // the pipe-to-shell trick's twin that the `| sh` patterns above miss.
      /<\(\s*(curl|wget)\b/,
      />\s*\/dev\/sda/,
      // Ethical Safety Gate: Offensive security attack tools & ransomware patterns
      /nmap\s+-s[STUVFN]/i,
      /sqlmap/i,
      /metasploit|msfconsole|msfvenom/i,
      /hydra\s+/i,
      /john\s+/i,
      /hashcat/i,
      /aircrack|airmon|aireplay/i,
      /ettercap|arpspoof|bettercap/i,
      /nikto/i,
      /xmrig|cpuminer|minerd/i,
      /ransomware|encrypt.*ransom/i
    ];

    // FORBIDDEN is matched against the WHOLE line, never against segments:
    // several of these patterns deliberately span shell separators (the fork
    // bomb contains ; and |, the pipe-to-shell patterns contain |), so
    // splitting first would stop them matching at all.
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(normalized)) return 'forbidden';
    }

    // Everything below judges what the shell will actually execute.
    const masked = maskQuotedSpans(normalized);


    // L3 (local-path audit): classify the REDIRECTION TARGET, not just the verb.
    //
    // sandbox.validate() path-scopes tool ARGUMENTS, but a shell redirection
    // target is invisible to it, and the classifier only ever looked at the
    // command word. So `echo evil >> ~/.bashrc` and
    // `cat payload >> ~/.ssh/authorized_keys` both classified as SAFE and
    // auto-executed in every autonomy mode — persistence and remote access with
    // no approval prompt. Writing to these files is escalated regardless of
    // which harmless-looking command does the writing.
    if (redirectsIntoSensitiveTarget(masked)) return 'extreme';
    const executesQuotedText = INTERPRETER_INVOCATION.test(masked);
    const destructiveScanTarget = executesQuotedText ? normalized : masked;

    
    const EXTREME_PATTERNS = [
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

    for (const pattern of EXTREME_PATTERNS) {
      if (pattern.test(destructiveScanTarget)) return 'extreme';
    }

    // DANGEROUS — requires approval in Mode B, auto-executes in Mode C
    const DANGEROUS_PREFIXES = [
      'rm ', 'sudo ', 'su ', 'chmod ', 'chown ', 
      'apt ', 'apt-get ', 'brew ', 'yum ', 'dnf ',
      'git reset', 'git push --force', 'git push -f', 'git rebase',
      'kill ', 'pkill ', 'killall ',
      'ssh ', 'scp ', 'rsync ',
      'mv ', 'crontab ', 'systemctl ', 'service '
    ];

    // Prefix rules are per-segment: `cd x && rm -f y` must be judged on `rm`,
    // not on `cd`. Highest risk across all segments wins.
    const segments = splitShellSegments(masked);

    for (const segment of segments) {
      for (const prefix of DANGEROUS_PREFIXES) {
        if (segment.startsWith(prefix) && !isReadOnlyInvocation(segment)) return 'dangerous';
      }
    }

    // DANGEROUS — pattern form, for commands whose risk is in a flag rather than
    // the leading word. `find … -exec/-delete` runs an arbitrary command against
    // (or removes) every match, so it is at least as risky as a bare `rm`.
    const DANGEROUS_PATTERNS = [
      /\bfind\b[\s\S]*\s-(exec|execdir|delete)\b/,
    ];
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(destructiveScanTarget)) return 'dangerous';
    }

    // MODERATE — auto-execute + notify in Mode B
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

    for (const segment of segments) {
      for (const prefix of MODERATE_PREFIXES) {
        if (segment.startsWith(prefix)) return 'moderate';
      }
    }

    return 'safe';
  }
}
