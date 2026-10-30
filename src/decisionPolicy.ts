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
  'gitOp', 'manage_local_dependencies', 'plugin_manage', 'tool_forge', 'create_skill',
  'write_file', 'write_to_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content',
  'write', 'edit', 'multiedit', 'bash', 'terminal', 'execute'
]);

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

export function requiresImplementationPlan(prompt: string, archetype = '', confidence = ''): boolean {
  const text = String(prompt ?? '').toLowerCase();
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
  if (toolName === 'creative_apps') return args.action !== 'status';
  if (toolName === 'native_engine') return !['status', 'catalog', 'describe', 'inspect', 'probe'].includes(String(args.action ?? ''));
  if (MUTATING_TOOLS.has(toolName)) {
    if (['sysRun', 'sysRunBg', 'bash', 'terminal', 'execute', 'sh', 'zsh'].includes(toolName)) {
      const command = String(args.command ?? args.cmd ?? '');
      return !/^\s*(?:pwd|ls|find|rg|grep|cat|sed|head|tail|git\s+(?:status|diff|log|show)|npm\s+(?:view|audit|test)|node\s+--check)\b/i.test(command);
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
