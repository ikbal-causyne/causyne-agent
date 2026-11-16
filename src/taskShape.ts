import {
  isPureSkillOrCapabilityLookup,
  redactSkillAndQueryLiterals
} from './decisionPolicy.js';
import type {
  TaskPackScore,
  TaskPhase,
  TaskShape,
  WorkspaceContext
} from './types/contracts.js';

interface SignalSet {
  strong: string[];
  weak: string[];
}

interface ArchetypeDefinition {
  label: string;
  match: SignalSet;
  phases: TaskPhase[];
}

const PACK_SIGNALS: Record<string, SignalSet> = {
  game: {
    strong: ['game', 'gamedev', 'godot', 'unity', 'unreal', 'rpg', 'platformer', 'roguelike', 'arcade', 'voxel', 'minecraft', 'tilemap', 'spritesheet', 'boss fight', 'level design', 'simulator', 'simulation', 'simulasi', 'tinder-3d', '3d'],
    weak: ['sprite', 'player', 'enemy', 'quest', 'npc', 'gameplay', 'multiplayer', 'leaderboard', 'character']
  },
  web: {
    strong: ['web app', 'webapp', 'website', 'landing page', 'homepage', 'frontend', 'front-end', 'dashboard', 'portfolio', 'react', 'vue', 'svelte', 'angular', 'nextjs', 'next.js', 'nuxt', 'astro', 'tailwind', 'html', 'css'],
    weak: ['web', 'ui', 'ux', 'page', 'responsive', 'browser', 'dom', 'component', 'layout', 'design']
  },
  media: {
    strong: ['generate image', 'generate video', 'generate music', 'text to speech', 'voiceover', 'blender', 'davinci', 'resolve', 'render', '3d model', 'animation'],
    weak: ['image', 'photo', 'video', 'audio', 'sound', 'music', 'thumbnail', 'poster', 'logo', 'illustration']
  },
  system: {
    strong: ['kill process', 'port', 'zip', 'unzip', 'tar', 'archive', 'clipboard', 'printer', 'print'],
    weak: ['process', 'compress', 'extract', 'open app', 'launch']
  },
  advanced: {
    strong: ['pdf', 'forge a tool', 'custom tool', 'plugin', 'plugins', 'custom plugin', 'subagent', 'sub-agent', 'parallel agent'],
    weak: ['symbols', 'ast', 'refactor', 'orchestrate', 'swarm']
  }
};

const STRONG_WEIGHT = 3;
const WEAK_WEIGHT = 1;
const PACK_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Task archetypes. Each one carries the phase plan the agent should follow and
// the tools that matter in each phase.
// ---------------------------------------------------------------------------

const ARCHETYPES: Record<string, ArchetypeDefinition> = {
  integrate: {
    label: 'Build an application that integrates live external data',
    match: {
      strong: ['realtime', 'real-time', 'real time', 'api', 'rest', 'webhook', 'integration', 'sync', 'automation', 'automate', 'booking', 'ticket', 'calendar', 'schedule', 'payment'],
      weak: ['live', 'stream', 'fetch', 'data', 'third party', 'oauth', 'token']
    },
    phases: [
      { name: 'Research the data sources FIRST', tools: ['web_search', 'web_fetch'], note: 'Identify the exact official REST APIs, their auth model, rate limits and response shape before writing any code. Prefer documented JSON APIs over browser scraping — reading JSON always beats reading DOM.' },
      { name: 'Verify access and versions', tools: ['sysRun', 'web_fetch'], note: 'Probe one real endpoint and check current package versions with `npm view <pkg> version` before pinning anything. Never assume a version from memory.' },
      { name: 'Scaffold', tools: ['fs_write', 'sysRun'], note: 'Create the project structure and dependency manifest.' },
      { name: 'Implement', tools: ['fs_read', 'fs_edit', 'MultiEdit'], note: 'Build the integration layer first, the UI second. Handle auth failures and rate limits explicitly.' },
      { name: 'Verify', tools: ['code_verify_syntax', 'sysRun'], note: 'Run the build, lint and type-check. Exercise the live data path end to end, not just the happy path.' }
    ]
  },
  build_app: {
    label: 'Build a new application from scratch',
    match: {
      strong: ['build me', 'create a', 'make me', 'develop a', 'new app', 'from scratch', 'buatkan', 'buat', 'bikin', 'bangun', 'ciptakan'],
      weak: ['app', 'project', 'tool', 'system', 'game', 'simulator', 'aplikasi']
    },
    phases: [
      { name: 'Plan', tools: ['update_plan'], note: 'Create a visible atomic implementation plan before touching the filesystem.' },
      { name: 'Scaffold', tools: ['fs_write', 'sysRun'], note: 'Create structure and install dependencies at verified current versions.' },
      { name: 'Implement', tools: ['fs_write', 'fs_edit', 'MultiEdit'], note: 'Write runnable code with every import and dependency present.' },
      { name: 'Verify', tools: ['code_verify_syntax', 'sysRun'], note: 'Build, lint and run it. Never assume code works.' }
    ]
  },
  debug: {
    label: 'Diagnose and fix a defect in existing code',
    match: {
      strong: ['bug', 'error', 'crash', 'fix', 'broken', 'not working', 'failing', 'exception', 'stack trace', 'regression', 'perbaiki', 'betulkan', 'rusak'],
      weak: ['issue', 'problem', 'wrong', 'debug', 'masalah']
    },
    phases: [
      { name: 'Reproduce', tools: ['sysRun', 'fs_read'], note: 'Reproduce the failure and capture the exact error before changing anything.' },
      { name: 'Locate', tools: ['code_search_ripgrep', 'codebase_search', 'fs_read'], note: 'Search several phrasings in parallel. Read the file before patching it.' },
      { name: 'Fix', tools: ['fs_edit', 'MultiEdit'], note: 'Make the smallest correct change. Do not touch unrelated code.' },
      { name: 'Verify', tools: ['sysRun', 'code_verify_syntax'], note: 'Confirm the original reproduction now passes.' }
    ]
  },
  research: {
    label: 'Investigate and report, without changing the system',
    match: {
      strong: [
        'explain', 'analyse', 'analyze', 'research', 'compare', 'what is', 'what skills',
        'which skills', 'list skills', 'available skills', 'read the skill',
        'using fs_read_skill', 'use tool_search', 'capabilities matching',
        'how does', 'review', 'audit', 'analisa', 'jelaskan', 'cek', 'periksa'
      ],
      weak: ['understand', 'find out', 'summarize', 'skill', 'skills', 'tool_search']
    },
    phases: [
      { name: 'Gather', tools: ['fs_read_skill', 'tool_search', 'code_search_ripgrep', 'fs_read', 'web_search', 'web_fetch'], note: 'Search broadly with several phrasings in parallel before concluding.' },
      { name: 'Report', tools: [], note: 'Answer concisely and cite exact file paths or URLs. Do not modify anything unless asked.' }
    ]
  },
  modify_repo: {
    label: 'Inspect and update an existing project or build release artifact',
    match: {
      strong: ['bump', 'version code', 'version name', 'aab', 'apk', 'release', 'export', 'synchronize', 'sync', 'upgrade', 'migrate', 'rebuild'],
      weak: ['version', 'bundle', 'existing', 'repo', 'repository', 'docs']
    },
    phases: [
      { name: 'Orient in docs and structure', tools: ['fs_read', 'fs_list'], note: 'Read the workspace README, docs/ guides (e.g. ANDROID_RELEASE.md, ENGINEERING.md), and build scripts/manifests FIRST to follow the repository conventions.' },
      { name: 'Apply targeted updates', tools: ['fs_read', 'fs_edit', 'MultiEdit'], note: 'Modify only the exact configuration, version fields, or source files required by the user request.' },
      { name: 'Run documented build', tools: ['sysRun'], note: 'Execute the project’s documented build/export command for the requested deliverable only. Do not build unrelated web or side targets.' },
      { name: 'Verify artifact', tools: ['sysRun', 'fs_read'], note: 'Verify the exact produced output (version, signature, alignment, tests) before reporting.' }
    ]
  },
  maintain: {
    label: 'Operate on files, processes or the machine itself',
    match: {
      strong: ['organize', 'clean up', 'rename', 'move', 'backup', 'delete', 'install', 'deploy', 'commit', 'merge'],
      weak: ['folder', 'directory', 'file', 'desktop', 'downloads']
    },
    phases: [
      { name: 'Survey', tools: ['fs_list', 'fs_find'], note: 'List and count what you are about to touch, and report it, before acting.' },
      { name: 'Act', tools: ['fs_move', 'fs_write', 'sysRun'], note: 'Prefer reversible operations. Flag anything destructive for approval.' },
      { name: 'Confirm', tools: ['fs_list'], note: 'Verify the end state matches what the user asked for.' }
    ]
  }
};

const ARCHETYPE_NAMES = Object.keys(ARCHETYPES);

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreSignals(text: string, signals: SignalSet): { score: number; hits: string[] } {
  let score = 0;
  const hits: string[] = [];

  for (const term of signals.strong || []) {
    if (text.includes(term)) {
      score += STRONG_WEIGHT;
      hits.push(term);
    }
  }
  for (const term of signals.weak || []) {
    // Word-boundary check for short weak terms so 'ui' cannot match 'build'
    // and 'race' cannot match 'trace' — the exact class of false positive that
    // used to drag ordinary tasks into game and web enforcement.
    const pattern = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'i');
    if (pattern.test(text)) {
      score += WEAK_WEIGHT;
      hits.push(term);
    }
  }

  return { score, hits };
}

function isPureGreeting(prompt: string): boolean {
  const cleaned = String(prompt || '').trim().toLowerCase().replace(/[!?.]+$/g, '');
  if (!cleaned) return false;
  return /^(?:hi+|hello+|hey+|yo+|sup|greetings|good\s+(?:morning|afternoon|evening)|thanks|thank\s+you|ok(?:ay)?)$/.test(cleaned);
}

/**
 * Analyse a request into the shape of the work it implies.
 *
 */
export function analyzeTask(prompt: string, workspaceContext: WorkspaceContext | null = null): TaskShape {
  const rawPrompt = String(prompt || '');
  const pureSkillLookup = isPureSkillOrCapabilityLookup(rawPrompt);
  const pureGreeting = !pureSkillLookup && isPureGreeting(rawPrompt);
  const lightweightLookup = pureSkillLookup || pureGreeting;
  const text = (pureSkillLookup ? redactSkillAndQueryLiterals(rawPrompt) : rawPrompt).toLowerCase();

  // Which capability packs are worth their token cost for this request.
  const packScores: TaskPackScore[] = [];
  if (!lightweightLookup) {
    for (const packName of Object.keys(PACK_SIGNALS)) {
      const signals = PACK_SIGNALS[packName];
      if (!signals) continue;
      const { score } = scoreSignals(text, signals);
      if (score >= PACK_THRESHOLD) {
        packScores.push({ name: packName, score });
      }
    }
  }

  // Workspace evidence outranks keywords: a Godot project on disk is far more
  // reliable than any phrasing in the prompt. Pure skill/capability lookups
  // stay lightweight and never preload workspace app packs.
  if (workspaceContext && !lightweightLookup) {
    const signals = [
      workspaceContext.framework,
      workspaceContext.projectType,
      workspaceContext.designSystem,
      Array.isArray(workspaceContext.keyFiles) ? workspaceContext.keyFiles.join(' ') : '',
      Array.isArray(workspaceContext.subprojectStacks) ? workspaceContext.subprojectStacks.join(' ') : '',
      Array.isArray(workspaceContext.buildFiles) ? workspaceContext.buildFiles.join(' ') : ''
    ].filter(Boolean).join(' ').toLowerCase();

    const bump = (name: string, amount: number): void => {
      const existing = packScores.find(p => p.name === name);
      if (existing) existing.score += amount;
      else packScores.push({ name, score: amount });
    };

    const hasGameProject = /godot|project\.godot|unity|\.tscn/.test(signals);
    const hasExplicitWebFramework = /\b(react|vue|svelte|next|nuxt|astro|angular|tailwind|vite)\b/.test(signals);
    const explicitNonWebTarget = /\b(aab|apk|gradle|android|godot|export_presets|tscn|gdscript|xcode|ipa|ios|rust|cargo)\b/.test(text);
    const hasPromptWebSignal = /\b(web|website|html|css|browser|frontend|page|ui|dom|react|vue|svelte|vite|next|playwright|lighthouse|localhost)\b/.test(text);
    if (hasGameProject) bump('game', 5);
    if (!explicitNonWebTarget && (hasExplicitWebFramework || (!hasGameProject && /index\.html/.test(signals)) || (hasGameProject && /index\.html/.test(signals) && hasPromptWebSignal))) {
      bump('web', 4);
    }
  }

  packScores.sort((a, b) => b.score - a.score);

  // Which archetype the work follows.
  let bestArchetype: string | null = null;
  let bestScore = 0;
  for (const name of ARCHETYPE_NAMES) {
    const definition = ARCHETYPES[name];
    if (!definition) continue;
    const { score } = scoreSignals(text, definition.match);
    if (score > bestScore) {
      bestScore = score;
      bestArchetype = name;
    }
  }

  // A build request that also talks about live external data is an integration
  // job first and a build job second — that ordering is what stops the agent
  // scaffolding a UI before it knows whether the API even exists.
  const integrate = ARCHETYPES.integrate;
  if (!integrate) throw new Error('integrate task archetype is unavailable');
  const integrationScore = scoreSignals(text, integrate.match).score;
  if (integrationScore >= STRONG_WEIGHT && bestArchetype === 'build_app') {
    bestArchetype = 'integrate';
    bestScore = integrationScore;
  }

  const hasExistingRepo = Boolean(
    workspaceContext && (
      (Array.isArray(workspaceContext.keyFiles) && workspaceContext.keyFiles.length > 0)
      || (Array.isArray(workspaceContext.buildFiles) && workspaceContext.buildFiles.length > 0)
      || (Array.isArray(workspaceContext.docFiles) && workspaceContext.docFiles.length > 0)
      || (Array.isArray(workspaceContext.subprojectStacks) && workspaceContext.subprojectStacks.length > 0)
      || (workspaceContext.framework && !/^(?:none|unknown)$/i.test(String(workspaceContext.framework)))
      || (workspaceContext.projectType && !/^(?:none|unknown)$/i.test(String(workspaceContext.projectType)))
    )
  );
  const explicitGreenfield = /\b(?:from\s+scratch|new\s+app(?:lication)?|new\s+project|greenfield|scaffold)\b/.test(text);
  const explicitRepoReleaseOrModify = /\b(?:aab|apk|gradle|android|release|bump|versioncode|version|export|rebuild|update|upgrade|modify|extend|add\s+feature|existing|script)\b/.test(text);
  if (!lightweightLookup && hasExistingRepo && (bestArchetype === 'build_app' || !bestArchetype) && !explicitGreenfield) {
    if (bestArchetype !== 'build_app' || explicitRepoReleaseOrModify) {
      bestArchetype = 'modify_repo';
      bestScore = Math.max(bestScore, STRONG_WEIGHT);
    }
  }

  if (lightweightLookup) {
    bestArchetype = 'research';
    bestScore = Math.max(bestScore, STRONG_WEIGHT);
  }

  const archetype = bestArchetype || (hasExistingRepo ? 'modify_repo' : 'build_app');
  const confidence = bestScore >= 6 ? 'high' : (bestScore >= 3 ? 'medium' : 'low');

  const definition = ARCHETYPES[archetype];
  if (!definition) throw new Error(`task archetype ${archetype} is unavailable`);
  return {
    archetype,
    archetypeLabel: definition.label,
    packs: packScores,
    phases: definition.phases,
    confidence
  };
}

/**
 * Render the analysis as a compact brief for the system prompt.
 *
 * This is the piece that turns "here are 28 tools" into "here is the order to
 * use them in". It costs roughly 150-200 tokens and routinely saves whole
 * exploratory steps, each of which costs thousands.
 */
export function buildTaskBrief(
  shape: TaskShape | null | undefined,
  availableToolNames: readonly string[] | null | undefined
): string {
  if (!shape) return '';

  const available = new Set(availableToolNames || []);
  const lines: string[] = [];

  lines.push('# TASK SHAPE (analysed from your request)');
  lines.push(`Work type: ${shape.archetypeLabel}.`);
  lines.push('Follow this sequence. Do not skip ahead — each phase de-risks the next.');

  shape.phases.forEach((phase, index) => {
    const tools = (phase.tools || []).filter(name => available.has(name));
    const toolList = tools.length > 0 ? ` [${tools.join(', ')}]` : '';
    lines.push(`${index + 1}. ${phase.name}${toolList} — ${phase.note}`);
  });

  lines.push('Tools outside this list remain fully available; search for them with tool_search when a phase genuinely needs one.');

  return lines.join('\n');
}

/** Pack names above threshold, highest score first. */
export function packsFromShape(shape: TaskShape | null | undefined): string[] {
  return shape && Array.isArray(shape.packs) ? shape.packs.map(p => p.name) : [];
}
