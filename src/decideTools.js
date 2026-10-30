/**
 * @file src/decideTools.ts
 * decideTools — stage 2 of the tool pipeline.
 *
 *   user intent -> ToolsList -> decideTools -> SmartTools -> saveTools -> AgentLoop
 *
 * Decides WHICH listed tools a task needs. It never loads anything and never
 * runs a model: it is a pure function over the intent, the task shape and the
 * ToolsList, so it costs no tokens and is identical on every provider.
 *
 * It is entered again whenever the work changes shape — the model asks for a
 * tool, an implementation plan is accepted, verification needs evidence, or a
 * failure demands a different route — and always from the same list.
 *
 * Authorship: Strict TypeScript (Causyne Agent).
 */
import { determineToolScope, filterSuppressedPacks } from './smartToolsUse.js';
import { routePacks, packForTool, PACK_NAMES } from './toolPacks.js';
import { packsFromShape } from './taskShape.js';
import { buildToolsList } from './toolsList.js';
/** A single decision from free text never admits more than this many tools. */
export const MAX_TEXT_TOOLS = 8;
/** A Three.js, WebGL, canvas or Python game needs no engine pack. */
export function isDirectGameTask(text) {
    return /\b(three?\.?js|3js|webgl|canvas|html5|pygame)\b/i.test(text)
        && !/\b(godot|unity|unreal|full engine)\b/i.test(text);
}
/**
 * What a plan step, a verification need or a failure implies. Every name here
 * is checked against the ToolsList before use, so a stale entry is inert.
 */
const TRIGGERS = [
    { pattern: /\b(preview|screenshot|visual(?:ly)?|rendered? (?:page|output|ui)|browser|snapshot|look at (?:the )?(?:ui|page|screen))\b/i,
        tools: ['browser_act', 'screenshot', 'view_image'], why: 'rendered output must be looked at' },
    { pattern: /\b(vision|ocr|inspect (?:the )?(?:ui|screen))\b/i, tools: ['vision_inspect_ui'], why: 'screen inspection' },
    { pattern: /\b(blender(?:_act)?|3d\b|mesh|render (?:frame|animation|model)?)\b/i, tools: ['blender_act', 'view_image'], why: '3D work' },
    { pattern: /\b(pdf|docx?|document|proposal|screenplay|shot ?list|report)\b/i, tools: ['document_forge', 'pdf_read'], why: 'document production' },
    { pattern: /\b(image|illustration|logo|poster|thumbnail|music|song|voice|tts|narration|video)\b/i,
        tools: ['generate_media_via_api', 'execute_procedural_media'], why: 'media generation' },
    { pattern: /\b(kill|terminate|port \d+|processes?)\b/i, tools: ['process_list', 'proc_term'], why: 'process control' },
    { pattern: /\b(zip|unzip|archive|extract|tarball)\b/i, tools: ['archive'], why: 'archive handling' },
    { pattern: /\b(sub-?agents?|in parallel|delegate)\b/i, tools: ['agent_subagent_orchestrate'], why: 'delegation' },
    { pattern: /\b(symbols?|definitions?|ast)\b/i, tools: ['code_list_symbols', 'code_search_ast'], why: 'structural code search' },
    { pattern: /\b(syntax|compile|typecheck|lint)\b/i, tools: ['code_verify_syntax'], why: 'static check' },
    { pattern: /\b(godot|\.tscn|gdscript)\b/i, tools: ['godot_act', 'game_scene_build'], why: 'Godot work' },
    { pattern: /\b(clipboard)\b/i, tools: ['clipboard'], why: 'clipboard' },
    { pattern: /\b(gui|desktop app|accessibility|click (?:the )?button)\b/i, tools: ['ax_snapshot', 'desktop_act'], why: 'GUI control' },
    { pattern: /\b(commit|branch|merge|rebase)\b/i, tools: ['gitOp'], why: 'version control' },
    { pattern: /\b(search the web|look up|latest version|official docs?|documentation)\b/i, tools: ['web_search', 'web_fetch'], why: 'external facts' },
    { pattern: /\b(ask the user|decide between|which (?:option|approach))\b/i, tools: ['request_decision'], why: 'user decision' },
    { pattern: /\b(hardware|gpu|disk space|ram)\b/i, tools: ['check_system_specs'], why: 'hardware check' }
];
function listed(list) {
    const entries = Array.isArray(list) ? list : buildToolsList();
    const byLower = new Map();
    for (const entry of entries)
        byLower.set(entry.name.toLowerCase(), entry.name);
    return byLower;
}
function unique(values) {
    return [...new Set(values)];
}
/** Match free text against the triggers, restricted to tools that are actually listed. */
export function toolsForText(text, list) {
    const known = listed(list);
    const tools = [];
    const reasons = [];
    for (const trigger of TRIGGERS) {
        if (!trigger.pattern.test(text))
            continue;
        const present = trigger.tools.filter((name) => known.has(name.toLowerCase()));
        if (present.length === 0)
            continue;
        for (const name of present)
            if (!tools.includes(name))
                tools.push(name);
        reasons.push(trigger.why);
        if (tools.length >= MAX_TEXT_TOOLS)
            break;
    }
    return { tools: tools.slice(0, MAX_TEXT_TOOLS), reasons };
}
export function decideTools(input) {
    const known = listed(input.list);
    const reasons = [];
    const tools = [];
    const packs = [];
    let archetype = 'generalist';
    let suppressedPacks = [];
    // Names the model asked for are honoured; a listed name is canonicalised.
    for (const raw of input.requested ?? []) {
        const name = String(raw ?? '').trim();
        if (!name)
            continue;
        const canonical = known.get(name.toLowerCase());
        if (canonical)
            tools.push(canonical);
    }
    if (tools.length > 0)
        reasons.push(`requested: ${tools.join(', ')}`);
    const validPacks = new Set(PACK_NAMES);
    for (const pack of input.requestedPacks ?? []) {
        if (validPacks.has(pack))
            packs.push(pack);
    }
    const effectiveSource = input.source ?? (input.prompt ? 'intent' : 'request');
    if (effectiveSource === 'intent') {
        const prompt = input.prompt ?? '';
        const scope = determineToolScope(prompt, input.taskShape);
        archetype = scope.archetype;
        suppressedPacks = scope.suppressedPacks;
        if (scope.toolScope) {
            for (const name of scope.toolScope) {
                const canonical = known.get(name.toLowerCase());
                if (canonical)
                    tools.push(canonical);
            }
            reasons.push(`scope ${scope.archetype}`);
        }
        const scored = packsFromShape(input.taskShape ?? null);
        const fallback = routePacks(prompt, input.workspace ?? null);
        const candidates = filterSuppressedPacks([...scored, ...fallback], prompt);
        for (const pack of candidates) {
            if (!validPacks.has(pack))
                continue;
            if (pack === 'game' && isDirectGameTask(prompt))
                continue;
            packs.push(pack);
        }
        // Intent suggests individual tools; only an explicit model pack request expands a whole pack.
        if (packs.length > 0)
            reasons.push(`suggested domains ${packs.join(', ')}`);
        packs.length = 0;
        for (const name of input.cachedTools ?? []) {
            const canonical = known.get(name.toLowerCase());
            if (!canonical)
                continue;
            tools.push(canonical);
            // A cached route admits IDs only, never an entire domain or permissions.
        }
        if ((input.cachedTools?.length ?? 0) > 0)
            reasons.push('proven route');
    }
    if (input.text) {
        const found = toolsForText(input.text, input.list);
        for (const name of found.tools)
            tools.push(name);
        for (const why of found.reasons)
            reasons.push(why);
    }
    return {
        source: input.source,
        tools: unique(tools),
        packs: unique(packs),
        archetype,
        suppressedPacks,
        reasons
    };
}
