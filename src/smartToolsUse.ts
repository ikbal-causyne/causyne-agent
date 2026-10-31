/**
 * @file src/smartToolsUse.ts
 * SmartToolsUse & LazyPlaybook Engine.
 *
 * Provides intent-based tool preloading and lazy playbook disclosure.
 * Other capabilities remain discoverable through tool_search.
 *
 * Authorship: Strict TypeScript (Causyne Agent).
 */

import { PACK_PLAYBOOKS, isWebIntent } from './toolPacks.js';
import { isMutatingToolCall } from './decisionPolicy.js';
import type { ToolDecision } from './decideTools.js';

export type ExecutionPhase = 'inspection' | 'synthesis' | 'execution' | 'verification';

export interface ToolPhaseSnapshot {
  phase: ExecutionPhase;
  consecutiveInspections: number;
  mutationAttempted: boolean;
  verificationObserved: boolean;
}

const INSPECTION_TOOLS = new Set([
  'fs_read', 'fs_list', 'fs_find', 'fs_search', 'grep_search', 'code_searcher',
  'codebase_search', 'web_search', 'web_fetch', 'browser_snapshot',
  'browser_get_dom', 'view_image', 'pdf_read', 'dir_list',
  'read', 'read_file', 'view_file', 'viewfile', 'cat', 'glob', 'grep', 'search', 'list_dir', 'ls'
]);
const VERIFICATION_TOOLS = new Set([
  'screenshot', 'vision_inspect_ui', 'browser_console', 'ax_snapshot'
]);

function isInspection(toolName: string, args: Record<string, unknown>): boolean {
  if (INSPECTION_TOOLS.has(toolName)) return true;
  if (!['sysRun', 'bash', 'terminal', 'execute', 'sh', 'zsh'].includes(toolName)) return false;
  return /^\s*(?:pwd|ls|find|rg|grep|cat|sed|head|tail|git\s+(?:status|diff|log|show)|npm\s+(?:view|audit))\b/i
    .test(String(args.command ?? args.cmd ?? ''));
}

function isVerification(toolName: string, args: Record<string, unknown>): boolean {
  if (VERIFICATION_TOOLS.has(toolName)) return true;
  if (toolName === 'browser_act') {
    const actions = Array.isArray(args.actions) ? args.actions : [args];
    return actions.some((item: unknown) => item !== null && typeof item === 'object'
      && ['preview', 'screenshot', 'inspect', 'snapshot'].includes(String((item as Record<string, unknown>).action ?? (item as Record<string, unknown>).type ?? '')));
  }
  if (!['sysRun', 'bash', 'terminal', 'execute', 'sh', 'zsh'].includes(toolName)) return false;
  return /^\s*(?:npm\s+(?:test|run\s+(?:test|typecheck|build))|node\s+--check|pytest|cargo\s+test|go\s+test|python(?:3)?\s+-m\s+unittest|vitest|jest|playwright|cypress)\b/i
    .test(String(args.command ?? args.cmd ?? ''));
}

/**
 * Bound each inspection batch to two calls, then yield to a synthesis step.
 * Further evidence remains available after that planning boundary, so long
 * research tasks do not deadlock. Exact repeated calls also use StallGuard.
 */
export class SmartToolsGovernor {
  private phase: ExecutionPhase = 'inspection';
  private consecutiveInspections = 0;
  private mutationAttempted = false;
  private verificationObserved = false;
  private nudgeIssued = false;

  get inspectionCapacity(): number { return Math.max(0, 2 - this.consecutiveInspections); }

  beginModelStep(): void {
    // A synthesis checkpoint yields to the planner; it does not prohibit
    // additional evidence on research or long engineering tasks forever.
    if (this.phase === 'synthesis') {
      this.phase = 'inspection';
      this.consecutiveInspections = 0;
      this.nudgeIssued = false;
    }
  }

  interceptAction(toolName: string, args: Record<string, unknown>): { allowed: boolean; reason?: string } {
    if (!isInspection(toolName, args) || isVerification(toolName, args)) return { allowed: true };
    if (this.consecutiveInspections < 2) return { allowed: true };
    this.phase = 'synthesis';
    return { allowed: false, reason: 'Inspection batch complete (2 actions). Synthesize the observations before another batch. '
      + 'Continue with a targeted edit or verification when evidence is sufficient; further research remains available in the next planning step.' };
  }

  reset(): void {
    this.phase = 'inspection';
    this.consecutiveInspections = 0;
    this.mutationAttempted = false;
    this.verificationObserved = false;
    this.nudgeIssued = false;
  }

  snapshot(): ToolPhaseSnapshot {
    return {
      phase: this.phase,
      consecutiveInspections: this.consecutiveInspections,
      mutationAttempted: this.mutationAttempted,
      verificationObserved: this.verificationObserved
    };
  }

  observe(toolName: string, args: Record<string, unknown>, result: unknown): string | null {
    if (isVerification(toolName, args)) {
      this.phase = 'verification';
      this.consecutiveInspections = 0;
      if (result !== null && typeof result === 'object'
        && (result as Record<string, unknown>).success === true) {
        this.verificationObserved = true;
      }
      return null;
    }
    if (isMutatingToolCall(toolName, args)) {
      this.phase = 'execution';
      this.mutationAttempted = true;
      this.consecutiveInspections = 0;
      this.nudgeIssued = false;
      return null;
    }
    if (!isInspection(toolName, args)) return null;
    this.consecutiveInspections++;
    this.phase = this.consecutiveInspections >= 2 ? 'synthesis' : 'inspection';
    if (this.consecutiveInspections === 2 && !this.nudgeIssued) {
      this.nudgeIssued = true;
      return 'Inspection batch complete. Synthesize what is known and choose the next useful step. Continue inspecting if the task still needs evidence; avoid repeating unchanged probes.';
    }
    return null;
  }
}

export interface SmartToolsScopeResult {
  readonly toolScope: Set<string> | null;
  readonly archetype: string;
  readonly suppressedPacks: readonly string[];
  readonly reason?: string;
}

export interface LazyPlaybookResult {
  readonly fullPlaybooks: string;
  readonly microAnnouncements: string;
  readonly activePlaybookDomains: string[];
  readonly tokenSavingsEstimate: number;
}

// ---------------------------------------------------------------------------
// Intent Matchers & Negative Filters
// ---------------------------------------------------------------------------

// Personalization / desktop actions (setting wallpaper, changing desktop background)
const DESKTOP_PERSONALIZATION_PATTERN =
  /\b(desktop (picture|wallpaper|background|image)|set wallpaper|change wallpaper)\b/i;

// Pure web search / retrieval without UI/frontend construction
const PURE_WEB_SEARCH_PATTERN =
  /\b(search(ing)? (the )?web|web search|look up online|find on google|brows(e|ing) (the )?web)\b/i;

const WEB_CONSTRUCTION_EXCLUSION =
  /\b(build|create|make|design|develop|scaffold|code|program|css|html|tailwind|component|frontend|front-end|landing page|website|webpage|dashboard)\b/i;

// System admin / process & terminal operations
const SYSTEM_ADMIN_PATTERN =
  /\b(kill process|kill port|check port|port \d+|lsof|ps aux|terminate process|zip folder|unzip file|extract archive|compress folder)\b/i;

// Simple file management operations
const SIMPLE_FILE_OP_PATTERN =
  /\b(list (the )?files|show files|count files|rename file(s)?|delete file(s)?|move file(s)?|clean (up )?folder)\b/i;

// Media generation intent (explicit creation of 3D, video, audio, or synthesized speech)
const EXPLICIT_MEDIA_GENERATION_PATTERN =
  /\b(blender|3d model|render 3d|render frame|render animation|da vinci|resolve|audio synth|synthesizer|text to speech|tts|voiceover|dubbing)\b|\.blend\d*\b/i;

// Explicit web engineering intent
const EXPLICIT_WEB_ENGINEERING_PATTERN =
  /\b(build|create|make|design|develop|implement|redesign|buat\w*)\b[\s\S]*\b(web|website|webpage|webapp|landing page|dashboard|ui|frontend|threejs|three\.js|thre\.?js|3js|webgl|canvas)\b/i;

// Explicit game development intent
const EXPLICIT_GAME_DEV_PATTERN =
  /(?:\b(?:build|create|make|design|develop|scaffold|render|animate|code|program|buat\w*|bikin\w*)[\s\S]*(?:game|simulation|simulator|simulasi|interactive|3d|three\.?js|threejs|webgl|canvas3d|babylonjs|godot|unity|unreal|platformer|rpg|arcade)\b|\b(?:game|gamedev|godot|unity|unreal|platformer|rpg|arcade|simulator|simulation|simulasi|interactive)\b|\b3d\s*(?:game|app|simulator|simulation|scene|city|world|view|body|human|anatomy|model|mesh|character|rendering|visualization|experience|space|environment)\b|\bin 3d\b|[-_]3d\b|\b3d[-_]|\b(?:threejs|three\.js|webgl|canvas3d|babylonjs)\b)/i;

/**
 * Select tools to preload based on prompt intent. This is never an allowlist:
 * tool_search can add capabilities as the task develops.
 */
export function determineToolScope(
  prompt: string,
  _taskShape?: unknown
): SmartToolsScopeResult {
  const text = (prompt || '').trim();
  if (!text) {
    return { toolScope: null, archetype: 'empty', suppressedPacks: [] };
  }

  // 1. Desktop personalization (e.g. wallpaper / desktop background)
  if (DESKTOP_PERSONALIZATION_PATTERN.test(text)) {
    const tools = new Set([
      'sysRun',
      'web_search',
      'web_fetch',
      'fs_read',
      'fs_write',
      'fs_list',
      'update_plan',
      'tool_search'
    ]);
    return {
      toolScope: tools,
      archetype: 'desktop_personalization',
      suppressedPacks: ['media', 'web', 'game', 'advanced', 'system'],
      reason: 'Start with search and system execution; discover desktop or browser tools if direct execution is unsuitable.'
    };
  }

  // 2. Pure web research (searching/fetching online information without web app construction)
  if (PURE_WEB_SEARCH_PATTERN.test(text) && !WEB_CONSTRUCTION_EXCLUSION.test(text)) {
    const tools = new Set([
      'web_search',
      'web_fetch',
      'sysRun',
      'fs_read',
      'fs_write',
      'update_plan',
      'tool_search'
    ]);
    return {
      toolScope: tools,
      archetype: 'web_research_only',
      suppressedPacks: ['media', 'game', 'web', 'advanced'],
      reason: 'Pure information retrieval requires web search tools; suppresses UI forge and creative packs.'
    };
  }

  // 3. System process or archive administration
  if (SYSTEM_ADMIN_PATTERN.test(text)) {
    const tools = new Set([
      'sysRun',
      'proc_term',
      'process_list',
      'archive',
      'fs_read',
      'fs_list',
      'update_plan',
      'tool_search'
    ]);
    return {
      toolScope: tools,
      archetype: 'system_admin',
      suppressedPacks: ['media', 'game', 'web'],
      reason: 'System administration uses process and archive utilities; suppresses creative packs.'
    };
  }

  // 4. Simple local file manipulation
  if (SIMPLE_FILE_OP_PATTERN.test(text) && !EXPLICIT_WEB_ENGINEERING_PATTERN.test(text) && !EXPLICIT_GAME_DEV_PATTERN.test(text)) {
    const tools = new Set([
      'fs_read',
      'fs_write',
      'fs_edit',
      'fs_list',
      'fs_search',
      'sysRun',
      'update_plan',
      'tool_search'
    ]);
    return {
      toolScope: tools,
      archetype: 'simple_file_op',
      suppressedPacks: ['media', 'game', 'web', 'advanced'],
      reason: 'Simple filesystem operation; suppresses external domain packs.'
    };
  }

  // 5. Web engineering intent (websites, web applications, landing pages, Three.js web scenes)
  if (EXPLICIT_WEB_ENGINEERING_PATTERN.test(text)) {
    const tools = new Set([
      'fs_write',
      'fs_edit',
      'fs_read',
      'fs_list',
      'sysRun',
      'browser_act',
      'screenshot',
      'vision_inspect_ui',
      'update_plan',
      'tool_search'
    ]);
    return {
      toolScope: tools,
      archetype: 'web_engineering',
      suppressedPacks: ['media', 'game', 'advanced', 'system'],
      reason: 'Web engineering intent focuses on filesystem authoring, terminal execution, and browser verification; suppresses unrelated media and game packs.'
    };
  }

  // 6. Media / 3D generation & creative audio intent
  if (EXPLICIT_MEDIA_GENERATION_PATTERN.test(text)) {
    const tools = new Set([
      'blender_act',
      'creative_apps',
      'execute_procedural_media',
      'fs_read',
      'fs_write',
      'sysRun',
      'view_image',
      'update_plan',
      'tool_search'
    ]);
    return {
      toolScope: tools,
      archetype: 'media_3d_generation',
      suppressedPacks: ['web', 'game', 'advanced', 'system'],
      reason: 'Media generation intent prioritizes 3D studio, procedural media, and image inspection; suppresses web and game packs.'
    };
  }

  // 7. Game development and interactive simulation intent (simulators, 3D worlds, games)
  if (EXPLICIT_GAME_DEV_PATTERN.test(text)) {
    const tools = new Set([
      'fs_write',
      'fs_edit',
      'fs_read',
      'fs_list',
      'sysRun',
      'browser_act',
      'screenshot',
      'vision_inspect_ui',
      'update_plan',
      'tool_search'
    ]);
    return {
      toolScope: tools,
      archetype: 'game_development',
      suppressedPacks: ['media', 'advanced', 'system'],
      reason: 'Game development and simulation intent focuses on game code, assets, terminal execution, and browser/screen verification.'
    };
  }

  // Default: unconstrained (standard progressive disclosure and packs apply)
  return {
    toolScope: null,
    archetype: 'generalist',
    suppressedPacks: []
  };
}

/**
 * Filter out packs that have been explicitly suppressed for a given prompt intent.
 */
export function filterSuppressedPacks(
  candidatePacks: Iterable<string>,
  prompt: string
): Set<string> {
  const result = new Set<string>();
  const scopeResult = determineToolScope(prompt);
  const suppressed = new Set(scopeResult.suppressedPacks);

  for (const pack of candidatePacks) {
    if (!suppressed.has(pack)) {
      result.add(pack);
    }
  }

  return result;
}

/**
 * Resolve lazy playbooks. Discloses full multi-page mandates only when tools from that
 * domain have been actively invoked or explicitly demanded. Otherwise generates micro-indicators.
 */
export function resolveLazyPlaybooks(
  unlockedPacks: Iterable<string>,
  observedTools: Iterable<string> = [],
  prompt = ''
): LazyPlaybookResult {
  const packs = new Set(unlockedPacks);
  const tools = new Set(observedTools);
  const text = prompt || '';

  const activePlaybooks: string[] = [];
  const microAnnouncements: string[] = [];
  const activeDomains: string[] = [];
  let tokenSavings = 0;

  // 1. Web Domain
  const webExplicitDemand = EXPLICIT_WEB_ENGINEERING_PATTERN.test(text)
    || (isWebIntent(text) && WEB_CONSTRUCTION_EXCLUSION.test(text));
  if (packs.has('web') || webExplicitDemand || tools.has('ui_forge') || tools.has('astryx_oracle')) {
    const webToolInvoked =
      tools.has('ui_forge') ||
      tools.has('browser_act') ||
      tools.has('vision_inspect_ui') ||
      tools.has('screenshot') ||
      tools.has('astryx_oracle');

    if ((webToolInvoked || webExplicitDemand) && PACK_PLAYBOOKS.web) {
      activePlaybooks.push(PACK_PLAYBOOKS.web);
      activeDomains.push('web');
    } else {
      microAnnouncements.push('- web: browser automation & UI forge available on demand via tool_search.');
      tokenSavings += Math.round((PACK_PLAYBOOKS.web?.length || 0) / 4);
    }
  }

  // 2. Media Domain
  if (packs.has('media')) {
    const mediaToolInvoked =
      tools.has('blender_act') ||
      tools.has('creative_apps') ||
      tools.has('native_engine') ||
      tools.has('execute_procedural_media') ||
      tools.has('generate_media_via_api') ||
      tools.has('open_source_tool_provisioner');
    const mediaExplicitDemand = EXPLICIT_MEDIA_GENERATION_PATTERN.test(text);

    if ((mediaToolInvoked || mediaExplicitDemand) && PACK_PLAYBOOKS.media) {
      activePlaybooks.push(PACK_PLAYBOOKS.media);
      activeDomains.push('media');
    } else {
      microAnnouncements.push('- media: 3D Blender, audio synthesis & creative engines available on demand via tool_search.');
      tokenSavings += Math.round((PACK_PLAYBOOKS.media?.length || 0) / 4);
    }
  }

  // 3. Game Domain
  if (packs.has('game')) {
    const gameToolInvoked =
      tools.has('godot_act') ||
      tools.has('game_build_html5') ||
      tools.has('game_scene_build') ||
      tools.has('game_asset_harvest');
    const gameExplicitDemand = EXPLICIT_GAME_DEV_PATTERN.test(text);

    if ((gameToolInvoked || gameExplicitDemand) && PACK_PLAYBOOKS.game) {
      activePlaybooks.push(PACK_PLAYBOOKS.game);
      activeDomains.push('game');
    } else {
      microAnnouncements.push('- game: Godot 2D/3D & HTML5 game development cascade available on demand via tool_search.');
      tokenSavings += Math.round((PACK_PLAYBOOKS.game?.length || 0) / 4);
    }
  }

  return {
    fullPlaybooks: activePlaybooks.join('\n\n'),
    microAnnouncements: microAnnouncements.join('\n'),
    activePlaybookDomains: activeDomains,
    tokenSavingsEstimate: tokenSavings
  };
}

// ---------------------------------------------------------------------------
// Pipeline stage 3: refine a decideTools decision before it is saved.
//
//   user intent -> ToolsList -> decideTools -> SmartTools -> saveTools -> AgentLoop
// ---------------------------------------------------------------------------

/** What the loop must do before it may mutate: nothing, plan, or ask the user. */
export type ToolRoute = 'direct' | 'plan' | 'decision';

export interface SmartToolsContext {
  /** True when the task is complex enough to require an implementation plan. */
  readonly planRequired?: boolean | undefined;
  /** True when the task crosses a durable choice the user must make. */
  readonly decisionRequired?: boolean | undefined;
  readonly admittedTools?: ReadonlySet<string> | undefined;
  readonly admittedPacks?: ReadonlySet<string> | undefined;
}

export interface RefinedToolDecision {
  readonly source: ToolDecision['source'];
  readonly tools: string[];
  readonly packs: string[];
  /** Tools held back this step to protect the context window; the next decision sees them again. */
  readonly deferred: string[];
  readonly route: ToolRoute;
  readonly reasons: string[];
}

/** A mid-task decision may load at most this many schemas at once. */
export const MAX_ADMIT_PER_STEP = 8;

/**
 * The smart part: admit only the delta, bound what one step may load, and say
 * what the loop owes before it changes anything. A task the user must decide
 * or plan first keeps the tool for that step reachable, so the checkpoint can
 * never be demanded of a model that was not given the means to meet it.
 */
export function refineToolDecision(decision: ToolDecision, context: SmartToolsContext): RefinedToolDecision {
  const admittedTools = context.admittedTools ?? new Set<string>();
  const admittedPacks = context.admittedPacks ?? new Set<string>();
  const fresh = decision.tools.filter((name) => !admittedTools.has(name));
  const packs = decision.packs.filter((name) => !admittedPacks.has(name));
  const reasons = [...decision.reasons];

  let tools = fresh;
  let deferred: string[] = [];
  if (decision.source !== 'intent' && fresh.length > MAX_ADMIT_PER_STEP) {
    tools = fresh.slice(0, MAX_ADMIT_PER_STEP);
    deferred = fresh.slice(MAX_ADMIT_PER_STEP);
    reasons.push(`deferred ${deferred.length} to protect context`);
  }

  const route: ToolRoute = context.decisionRequired ? 'decision' : context.planRequired ? 'plan' : 'direct';
  if (decision.source === 'intent') {
    const needed = route === 'decision' ? 'request_decision' : route === 'plan' ? 'update_plan' : '';
    if (needed && !admittedTools.has(needed) && !tools.includes(needed)) tools = [...tools, needed];
  }

  return { source: decision.source, tools, packs, deferred, route, reasons };
}
