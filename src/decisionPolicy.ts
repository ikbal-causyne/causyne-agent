export type DecisionKind = 'architecture' | 'product' | 'data' | 'security' | 'workflow' | 'other';

export interface DecisionOption {
  id: string;
  label: string;
  description: string;
}

export interface DecisionRequest {
  id: string;
  kind: DecisionKind;
  header: string;
  question: string;
  reason: string;
  options: DecisionOption[];
  allowCustom: boolean;
}

export interface DecisionAnswer {
  requestId: string;
  optionId: string | null;
  label: string;
  custom: boolean;
}

export interface DecisionRequirement {
  required: boolean;
  kind: DecisionKind;
  reason: string;
}

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

function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
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
        if (current.trim()) segments.push(current.trim());
        current = '';
        continue;
      }
      if (ch === '&' && command[i + 1] === '&') {
        if (current.trim()) segments.push(current.trim());
        current = '';
        i++;
        continue;
      }
      if (ch === '|' && command[i + 1] === '|') {
        if (current.trim()) segments.push(current.trim());
        current = '';
        i++;
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

const READ_ONLY_CMD_PATTERNS = [
  String.raw`^\s*(?:pwd|ls|find|rg|grep|cat|sed|awk|head|tail|wc|diff|file|stat|which|whereis|type|du|df|pdfinfo|pdftotext|identify|mediainfo|ffprobe|otool|readelf|nm|ps|lsof|top|uptime|whoami|id|uname|env|printenv|echo|printf|pytest)\b`,
  String.raw`(?:\.\/)?gradlew?\s+(?:test\S*|check\S*|lint\S*)\b`,
  String.raw`mvn\s+(?:test\S*|verify\S*)\b`,
  String.raw`git\s+(?:status|diff|log|show|branch|tag|remote|rev-parse|describe)\b`,
  String.raw`npm\s+(?:view|audit|test|ls|list|explain|run\s+(?:test|check|lint|typecheck|verify))\b`,
  String.raw`pnpm\s+(?:test|view|audit|ls|list|run\s+(?:test|check|lint|typecheck|verify))\b`,
  String.raw`yarn\s+(?:test|audit|list|run\s+(?:test|check|lint|typecheck|verify))\b`,
  String.raw`bun\s+(?:test|pm)\b`,
  String.raw`npx\s+(?:jest|vitest|mocha|ava|playwright\s+test|cypress\s+run|tsc\s+--noEmit)\b`,
  String.raw`tsc\s+--noEmit\b`,
  String.raw`node\s+(?:--check|--test|-e\b|--eval\b|-p\b|--print\b|.*?(?:test|spec|verify|check))`,
  String.raw`(?:python3?|py)\s+(?:-m\s+(?:unittest|pytest|doctest|py_compile)|-c\b|.*?(?:test|spec|verify))`,
  String.raw`cargo\s+(?:test|check)\b`,
  String.raw`go\s+test\b`,
  String.raw`curl\s+(?:-I|-sI|-s\b|--head)\b`
];
const READ_ONLY_CMD_REGEX = new RegExp(READ_ONLY_CMD_PATTERNS.join('|'), 'i');

export function isReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return true;
  const segments = splitCommandSegments(trimmed);
  return segments.length > 0 && segments.every(seg => {
    const s = seg.trim();
    if (!s) return true;
    const stripped = s.replace(/^(?:[a-zA-Z_][a-zA-Z0-9_]*=[^\s]+\s+)+/, '');
    return READ_ONLY_CMD_REGEX.test(stripped);
  });
}

function containsAny(text: string, terms: readonly string[]): boolean {
  return terms.some(term => text.includes(term));
}

export function assessDecisionRequirement(prompt: string): DecisionRequirement {
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

function extractPreviousCueWord(beforeRaw: string): string {
  let end = beforeRaw.length;
  while (end > 0) {
    const c = beforeRaw[end - 1]!;
    if (c === ':' || c === '=' || /\s/.test(c)) end--;
    else break;
  }
  let start = end;
  while (start > 0) {
    const c = beforeRaw[start - 1]!;
    if (/\s/.test(c) || c === '(') break;
    start--;
  }
  return beforeRaw.slice(start, end).toLowerCase();
}

function stripTokenEdgePunctuation(token: string): string {
  const leading = new Set(['`', '"', "'", '(']);
  const trailing = new Set(['`', '"', "'", ',', '.', ';', ':', '!', '?', ')']);
  let start = 0;
  let end = token.length;
  while (start < end && leading.has(token[start]!)) start++;
  while (end > start && trailing.has(token[end - 1]!)) end--;
  return token.slice(start, end);
}

function redactDelimitedLiteralAfterKeyword(text: string): string {
  const cues = new Set(['skill', 'skill_id', 'fs_read_skill', 'fs_read_skil', 'read_skill', 'matching', 'pattern', 'query']);
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '`' || ch === '"') {
      const lastWord = extractPreviousCueWord(out);
      const close = text.indexOf(ch, i + 1);
      if (close !== -1 && cues.has(lastWord)) {
        out += '<lookup_literal>';
        i = close + 1;
        continue;
      }
    }
    if (ch === "'" && (i === 0 || /[\s:=(\[]/.test(text[i - 1]!))) {
      const lastWord = extractPreviousCueWord(out);
      const close = text.indexOf("'", i + 1);
      if (close !== -1 && cues.has(lastWord)) {
        out += '<lookup_literal>';
        i = close + 1;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

const KNOWN_FILE_EXT_RE =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|swift|c|cc|cpp|h|hpp|json|yaml|yml|toml|xml|html|htm|css|scss|md|txt|sql|sh|bash|gradle|properties|apk|aab|dex|so|dylib|dll|exe|wasm|asar|png|jpe?g|webp|pdf|blend\d*|psd|aep|prproj)$/i;

/**
 * Redact inline skill identifiers and tool_search query/regex literals in O(n) time
 * so intent classifiers never mistake skill names (e.g. `mobile-development/android-build-optimization`)
 * or search patterns (e.g. `android/.*gradle`) for software engineering/build commands.
 */
export function redactSkillAndQueryLiterals(raw: string): string {
  const input = String(raw ?? '');
  if (!input.trim()) return input;
  const hasSkillOrSearchContext =
    /\b(?:skills?|fs_read_skill|fs_read_skil|read_skill|tool_search|tool\.search|tool_deferred_mcp_search|capabilities\s+matching)\b/i.test(input);
  if (!hasSkillOrSearchContext) return input;

  const afterQuoted = redactDelimitedLiteralAfterKeyword(input);
  return afterQuoted.replace(/\S+/g, (token) => {
    const core = stripTokenEdgePunctuation(token);
    if (!core || core === '<lookup_literal>') return token;
    const isFileLikePath = /^(?:\.{0,2}\/|~\/|https?:\/\/)/i.test(core) || KNOWN_FILE_EXT_RE.test(core);
    if (isFileLikePath) return token;
    const isSlashSkillOrPattern = core.includes('/') && /[a-z0-9]/i.test(core);
    const hasRegexMeta = /[*+?^$[\]\\]/.test(core) && /[a-z0-9]/i.test(core);
    if (isSlashSkillOrPattern || hasRegexMeta) {
      return '<lookup_literal>';
    }
    return token;
  });
}

const NON_LOOKUP_ACTION_RE =
  /\b(?:create|write|edit|modify|update|delete|remove|rename|move|build|make|implement|refactor|fix|debug|patch|install|deploy|scaffold|generate|compile|execute|decompile|disassemble|launch|apply)\b/;

export function isPureSkillOrCapabilityLookup(raw: string): boolean {
  const text = String(raw ?? '').trim();
  if (!text) return false;
  const cleaned = redactSkillAndQueryLiterals(text).toLowerCase().trim();
  if (!cleaned) return false;

  if (
    NON_LOOKUP_ACTION_RE.test(cleaned) ||
    /\b(?:run|execute)\s+(?:tests?|commands?|scripts?|code)\b/.test(cleaned) ||
    KNOWN_FILE_EXT_RE.test(cleaned)
  ) {
    return false;
  }

  const isSkillReadRequest =
    /\b(?:fs_read_skill|fs_read_skil|read_skill|read_skil|skill_read)\b/i.test(text) ||
    /\b(?:read|load|open|show|get|inspect|fetch|view)\s+(?:the\s+|this\s+|a\s+|compiled\s+|native\s+|user\s+)?skills?\b/i.test(text) ||
    /\bskill(?:_id|\s+id)\s*[:=]/i.test(text) ||
    /^\/skills?\b/i.test(text);

  const isSkillInventoryQuestion =
    /\b(?:what|which|list|show|available|browse)\s+(?:all\s+|the\s+|any\s+)?skills?\b/i.test(text) ||
    /\bwhat\s+skills?\s+(?:do\s+you\s+have|are\s+available)\b/i.test(text) ||
    /\bskills?\s+(?:available|catalog|inventory|list)\b/i.test(text);

  const isToolSearchLookup =
    /\b(?:tool_search|tool\.search|tool_deferred_mcp_search)\b/i.test(text) ||
    (/\b(?:search|discover|find|lookup|list|show)\b/i.test(text) &&
      /\bcapabilit(?:y|ies)\b|\bcapability\s+packs?\b/i.test(text));

  return isSkillReadRequest || isSkillInventoryQuestion || isToolSearchLookup;
}

export function requiresImplementationPlan(prompt: string, archetype = '', confidence = ''): boolean {
  if (archetype === 'skill_lookup' || isPureSkillOrCapabilityLookup(prompt)) {
    return false;
  }
  const text = redactSkillAndQueryLiterals(String(prompt ?? '')).toLowerCase();
  if (archetype === 'research' && !/\b(?:implement|build|create|migrate|rewrite|refactor|integrate|write|edit|fix|modify|delete|remove|update)\b/.test(text)) {
    return false;
  }
  // A classifier can label any "create" request build_app. A single plain
  // text/data-file operation needs no checklist or rejected mutation round trip.
  const namedFiles = new Set([...text.matchAll(/\b[\w./-]+\.(?:txt|md|csv|json)\b/g)].map(match => match[0]));
  const simpleFileOperation = text.length < 700 && namedFiles.size === 1
    && /\b(?:create|write|save)\b/.test(text)
    && !/\b(?:research|search|scrap\w*|codebase|migrat\w*|refactor|integrat\w*|application|website|database|security|authentication|authorization|framework|architecture|runtime)\b/.test(text)
    && !/\b(?:package(?:-lock)?\.json|tsconfig\w*\.json|permissions?\.json|policy\.json)\b/.test(text);
  if (simpleFileOperation) return false;
  if (archetype === 'build_app' || archetype === 'integrate') return true;
  if (confidence === 'high' && /\b(?:implement|build|create|migrate|rewrite|refactor|integrate)\b/i.test(text)) {
    return true;
  }
  return containsAny(text, ARCHITECTURE_TERMS) && containsAny(text, CHANGE_TERMS);
}

export function isMutatingToolCall(toolName: string, args: Record<string, unknown> = {}): boolean {
  if (toolName === 'creative_apps') {
    return (
      args.action !== 'status' &&
      args.action !== 'verify_bridge' &&
      !(args.action === 'live_bridge' && args.liveOperation === 'inspect_active')
    );
  }
  if (toolName === 'native_engine') return !['status', 'catalog', 'describe', 'inspect', 'probe'].includes(String(args.action ?? ''));
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
  if (toolName.startsWith('plugin__') || toolName.startsWith('mcp__')) return false;
  return false;
}
