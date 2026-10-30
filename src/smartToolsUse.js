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
const INSPECTION_TOOLS = new Set([
    'fs_read', 'fs_list', 'fs_find', 'fs_search', 'grep_search', 'code_searcher',
    'codebase_search', 'web_search', 'web_fetch', 'browser_snapshot',
    'browser_get_dom', 'view_image', 'pdf_read', 'dir_list'
]);
const VERIFICATION_TOOLS = new Set([
    'screenshot', 'vision_inspect_ui', 'browser_console', 'ax_snapshot'
]);
function isInspection(toolName, args) {
    if (INSPECTION_TOOLS.has(toolName))
        return true;
    if (toolName !== 'sysRun')
        return false;
    return /^\s*(?:pwd|ls|find|rg|grep|cat|sed|head|tail|git\s+(?:status|diff|log|show)|npm\s+(?:view|audit))\b/i
        .test(String(args.command ?? ''));
}
function isVerification(toolName, args) {
    if (VERIFICATION_TOOLS.has(toolName))
        return true;
    if (toolName !== 'sysRun')
        return false;
    return /^\s*(?:npm\s+(?:test|run\s+(?:test|typecheck|build))|node\s+--check|pytest|cargo\s+test|go\s+test)\b/i
        .test(String(args.command ?? ''));
}
/**
 * Bound each inspection batch to two calls, then yield to a synthesis step.
 * Further evidence remains available after that planning boundary, so long
 * research tasks do not deadlock. Exact repeated calls also use StallGuard.
 */
export class SmartToolsGovernor {
    phase = 'inspection';
    consecutiveInspections = 0;
    mutationAttempted = false;
    verificationObserved = false;
    nudgeIssued = false;
    get inspectionCapacity() { return Math.max(0, 2 - this.consecutiveInspections); }
    beginModelStep() {
        // A synthesis checkpoint yields to the planner; it does not prohibit
        // additional evidence on research or long engineering tasks forever.
        if (this.phase === 'synthesis') {
            this.phase = 'inspection';
            this.consecutiveInspections = 0;
            this.nudgeIssued = false;
        }
    }
    interceptAction(toolName, args) {
        if (!isInspection(toolName, args) || isVerification(toolName, args))
            return { allowed: true };
        if (this.consecutiveInspections < 2)
            return { allowed: true };
        this.phase = 'synthesis';
        return { allowed: false, reason: 'Inspection batch complete (2 actions). Synthesize the observations before another batch. '
                + 'Continue with a targeted edit or verification when evidence is sufficient; further research remains available in the next planning step.' };
    }
    reset() {
        this.phase = 'inspection';
        this.consecutiveInspections = 0;
        this.mutationAttempted = false;
        this.verificationObserved = false;
        this.nudgeIssued = false;
    }
    snapshot() {
        return {
            phase: this.phase,
            consecutiveInspections: this.consecutiveInspections,
            mutationAttempted: this.mutationAttempted,
            verificationObserved: this.verificationObserved
        };
    }
    observe(toolName, args, result) {
        if (isVerification(toolName, args)) {
            this.phase = 'verification';
            this.consecutiveInspections = 0;
            if (result !== null && typeof result === 'object'
                && result.success === true) {
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
        if (!isInspection(toolName, args))
            return null;
        this.consecutiveInspections++;
        this.phase = this.consecutiveInspections >= 2 ? 'synthesis' : 'inspection';
        if (this.consecutiveInspections === 2 && !this.nudgeIssued) {
            this.nudgeIssued = true;
            return 'Inspection batch complete. Synthesize what is known and choose the next useful step. Continue inspecting if the task still needs evidence; avoid repeating unchanged probes.';
        }
        return null;
    }
}
// ---------------------------------------------------------------------------
// Intent Matchers & Negative Filters
// ---------------------------------------------------------------------------
// Personalization / desktop actions (setting wallpaper, changing desktop background)
const DESKTOP_PERSONALIZATION_PATTERN = /\b(desktop (picture|wallpaper|background|image)|set wallpaper|change wallpaper)\b/i;
// Pure web search / retrieval without UI/frontend construction
const PURE_WEB_SEARCH_PATTERN = /\b(search(ing)? (the )?web|web search|look up online|find on google|brows(e|ing) (the )?web)\b/i;
const WEB_CONSTRUCTION_EXCLUSION = /\b(build|create|make|design|develop|scaffold|code|program|css|html|tailwind|component|frontend|front-end|landing page|website|webpage|dashboard)\b/i;
// System admin / process & terminal operations
const SYSTEM_ADMIN_PATTERN = /\b(kill process|kill port|check port|port \d+|lsof|ps aux|terminate process|zip folder|unzip file|extract archive|compress folder)\b/i;
// Simple file management operations
const SIMPLE_FILE_OP_PATTERN = /\b(list (the )?files|show files|count files|rename file(s)?|delete file(s)?|move file(s)?|clean (up )?folder)\b/i;
// Media generation intent (explicit creation of 3D, video, audio, or synthesized speech)
const EXPLICIT_MEDIA_GENERATION_PATTERN = /\b(blender|3d model|render 3d|render frame|render animation|da vinci|resolve|audio synth|synthesizer|text to speech|tts|voiceover|dubbing)\b|\.blend\d*\b/i;
// Explicit web engineering intent
const EXPLICIT_WEB_ENGINEERING_PATTERN = /\b(build|create|make|design|develop|implement|redesign|buat\w*)\b[\s\S]*\b(web|website|webpage|webapp|landing page|dashboard|ui|frontend|threejs|three\.js|thre\.?js|3js|webgl)\b/i;
// Explicit game development intent
const EXPLICIT_GAME_DEV_PATTERN = /\b(build.*game|create.*game|develop.*game|godot|unity|unreal|platformer 2d|rpg game|arcade game)\b/i;
/**
 * Select tools to preload based on prompt intent. This is never an allowlist:
 * tool_search can add capabilities as the task develops.
 */
export function determineToolScope(prompt, _taskShape) {
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
    // 5. Media / 3D generation & creative audio intent
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
export function filterSuppressedPacks(candidatePacks, prompt) {
    const result = new Set();
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
export function resolveLazyPlaybooks(unlockedPacks, observedTools = [], prompt = '') {
    const packs = new Set(unlockedPacks);
    const tools = new Set(observedTools);
    const text = prompt || '';
    const activePlaybooks = [];
    const microAnnouncements = [];
    const activeDomains = [];
    let tokenSavings = 0;
    // 1. Web Domain
    if (packs.has('web')) {
        const webToolInvoked = tools.has('ui_forge') ||
            tools.has('browser_act') ||
            tools.has('vision_inspect_ui') ||
            tools.has('screenshot') ||
            tools.has('astryx_oracle');
        const webExplicitDemand = EXPLICIT_WEB_ENGINEERING_PATTERN.test(text)
            || (isWebIntent(text) && WEB_CONSTRUCTION_EXCLUSION.test(text));
        if ((webToolInvoked || webExplicitDemand) && PACK_PLAYBOOKS.web) {
            activePlaybooks.push(PACK_PLAYBOOKS.web);
            activeDomains.push('web');
        }
        else {
            microAnnouncements.push('- web: browser automation & UI forge available on demand via tool_search.');
            tokenSavings += Math.round((PACK_PLAYBOOKS.web?.length || 0) / 4);
        }
    }
    // 2. Media Domain
    if (packs.has('media')) {
        const mediaToolInvoked = tools.has('blender_act') ||
            tools.has('creative_apps') ||
            tools.has('native_engine') ||
            tools.has('execute_procedural_media') ||
            tools.has('generate_media_via_api') ||
            tools.has('open_source_tool_provisioner');
        const mediaExplicitDemand = EXPLICIT_MEDIA_GENERATION_PATTERN.test(text);
        if ((mediaToolInvoked || mediaExplicitDemand) && PACK_PLAYBOOKS.media) {
            activePlaybooks.push(PACK_PLAYBOOKS.media);
            activeDomains.push('media');
        }
        else {
            microAnnouncements.push('- media: 3D Blender, audio synthesis & creative engines available on demand via tool_search.');
            tokenSavings += Math.round((PACK_PLAYBOOKS.media?.length || 0) / 4);
        }
    }
    // 3. Game Domain
    if (packs.has('game')) {
        const gameToolInvoked = tools.has('godot_act') ||
            tools.has('game_build_html5') ||
            tools.has('game_scene_build') ||
            tools.has('game_asset_harvest');
        const gameExplicitDemand = EXPLICIT_GAME_DEV_PATTERN.test(text);
        if ((gameToolInvoked || gameExplicitDemand) && PACK_PLAYBOOKS.game) {
            activePlaybooks.push(PACK_PLAYBOOKS.game);
            activeDomains.push('game');
        }
        else {
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
