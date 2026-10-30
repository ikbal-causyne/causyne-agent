/**
 * @file src/toolsList.ts
 * ToolsList — stage 1 of the tool pipeline.
 *
 *   user intent -> ToolsList -> decideTools -> SmartTools -> saveTools -> AgentLoop
 *
 * This is the one place that tells a model what Causyne Agent owns. Each tool is
 * a single dense line written for a model, not a person: a name and the shortest
 * phrase that lets the model decide whether it needs it. It is NOT a schema.
 * Schemas are expensive and are loaded only for the tools decideTools admits.
 *
 * Every provider receives this compact catalog beside selected full schemas.
 * ACP native tools remain independent of this host-tool discovery surface.
 *
 * Authorship: Strict TypeScript (Causyne Agent).
 */
/**
 * Curated one-line purposes. Order inside a group is the order shown, and is
 * stable on purpose: the list sits in the cached prompt prefix, so reshuffling
 * it would invalidate the cache for every request of every task.
 */
const CATALOGUE = {
    core: {
        sysRun: 'run shell command and wait',
        sysRunBg: 'start long-running process (server, watcher)',
        terminal_persistent_shell: 'stateful shell, cd/env persist',
        fs_read: 'read file or line range',
        fs_write: 'create or overwrite file',
        fs_edit: 'replace a block in a file',
        MultiEdit: 'several edits to one file',
        fs_list: 'directory tree',
        fs_search: 'text search across files',
        fs_find: 'find files by name',
        fs_move: 'move or rename',
        fs_delete: 'delete to trash',
        gitOp: 'git command',
        code_search_ripgrep: 'regex or symbol search in codebase',
        codebase_search: 'semantic code lookup',
        code_verify_syntax: 'syntax or compile check of a file',
        web_search: 'search the web',
        web_fetch: 'fetch a public URL',
        update_plan: 'visible checklist, one active step',
        request_decision: 'ask the user to pick a direction',
        memory_write: 'save durable user fact or design pattern',
        fs_read_skill: 'read a bundled skill by id',
        skill_create: 'save a reusable skill',
        tool_search: 'find and load any tool on this list'
    },
    system: {
        process_list: 'list processes',
        proc_term: 'terminate a process',
        desktop_open: 'open file, URL or app natively',
        clipboard: 'read or write clipboard',
        ax_snapshot: 'read an app window as accessibility text',
        desktop_act: 'press, type or click in a GUI app',
        computer_use: 'vision-grounded GUI actions',
        archive: 'zip, unzip, tar',
        printer_print: 'print a file',
        printer_list_printers: 'list printers',
        printer_get_status: 'printer status'
    },
    web: {
        browser_act: 'browse, preview local HTML, snapshot, interact',
        screenshot: 'capture screen for visual check',
        vision_inspect_ui: 'look at a live screen with vision',
        view_image: 'view an image file',
        astryx_oracle: 'Astryx design-system docs',
        ui_forge: 'generate accessible UI components'
    },
    media: {
        generate_media_via_api: 'image, audio or video from a paid or free API',
        execute_procedural_media: 'make media with code (SVG, canvas, numpy)',
        check_system_specs: 'RAM, CPU, GPU, disk',
        manage_local_dependencies: 'request capabilities, local dependencies',
        blender_act: 'Blender 3D scene and render',
        creative_apps: 'drive installed creative apps',
        native_engine: 'headless film, photo, sound, CAD, deck engines',
        resolve_act: 'DaVinci Resolve',
        palmier_act: 'Palmier automation',
        document_forge: 'produce PDF, documents, screenplays',
        open_source_tool_provisioner: 'discover and install open-source AI tools'
    },
    advanced: {
        tool_forge: 'create a custom tool',
        plugin_manager: 'manage plugins',
        pdf_read: 'read PDF text',
        code_list_symbols: 'list symbols in a file',
        code_search_ast: 'AST definition search',
        agent_subagent_orchestrate: 'delegate a bounded sub-task',
        peer_agent_delegate: 'delegate to an external ACP agent'
    },
    game: {
        godot_act: 'Godot 4 project automation',
        game_build_html5: 'build an HTML5 game',
        game_asset_fetch: 'download CC0 assets',
        game_asset_harvest: 'harvest CC0 3D, 2D, audio',
        game_lore_forge: 'lore and worldbuilding',
        game_dialogue_tree_gen: 'NPC dialogue trees',
        game_quest_arc_builder: 'quest arcs',
        game_animation_rig: 'rigging and animation',
        game_ai_behavior_tree: 'enemy AI, behavior trees',
        game_cinematic_sequencer: 'cutscenes, camera',
        game_audio_synth: 'synthesize WAV audio',
        game_vfx_emitter_gen: 'particle effects',
        game_shader_forge: 'gdshader',
        game_scene_build: 'build or inspect .tscn scenes',
        game_entity_spawner: 'entity prefabs',
        game_tilemap_gen: 'maps and dungeons',
        game_ui_hud_builder: 'menu and HUD scenes',
        game_economy_balancer: 'balance stats and economy',
        game_data_forge: 'item and enemy data JSON',
        game_web_runtime_inspector: 'headless runtime error gate',
        game_canvas_audit: 'canvas render audit'
    }
};
const GROUP_ORDER = ['core', 'system', 'web', 'media', 'advanced', 'game'];
const CURATED_NAMES = new Set(GROUP_ORDER.flatMap((group) => Object.keys(CATALOGUE[group])));
/** All registered plugin and MCP IDs remain discoverable; only their hints are shortened. */
export const MAX_CUSTOM_TOOLS = Number.POSITIVE_INFINITY;
const MAX_CUSTOM_HINT = 56;
function firstSentence(text) {
    const flat = text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
    const stop = flat.search(/[.!?](?:\s|$)/);
    const sentence = stop > 0 ? flat.slice(0, stop) : flat;
    return sentence.length > MAX_CUSTOM_HINT ? `${sentence.slice(0, MAX_CUSTOM_HINT - 1).trimEnd()}…` : sentence;
}
/** True when a tool has a hand-written line, which every native tool must. */
export function isCuratedTool(name) {
    return CURATED_NAMES.has(name);
}
export function curatedToolNames() {
    return [...CURATED_NAMES];
}
/**
 * Build the list. Native tools come first in curated order; anything else the
 * registry reports (plugins, MCP servers, forged tools) follows as `custom`.
 */
export function buildToolsList(definitions) {
    const entries = [];
    const filterAvailable = Array.isArray(definitions);
    const available = filterAvailable ? new Set(definitions.map((definition) => definition.name)) : null;
    for (const group of GROUP_ORDER) {
        for (const [name, hint] of Object.entries(CATALOGUE[group])) {
            if (!available || available.has(name))
                entries.push({ name, group, hint });
        }
    }
    const seen = new Set(entries.map((entry) => entry.name));
    let custom = 0;
    for (const definition of (definitions ? [...definitions] : []).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = String(definition.name || '');
        if (!/^[A-Za-z0-9_.:@/-]{1,200}$/.test(name) || seen.has(name))
            continue;
        seen.add(name);
        if (custom >= MAX_CUSTOM_TOOLS)
            continue;
        custom += 1;
        entries.push({ name, group: 'custom', hint: firstSentence(definition.description || '') || 'custom tool' });
    }
    return entries;
}
/** Names the registry reports that exceed the bound and are reachable only through tool_search. */
export function omittedCustomCount(definitions) {
    const unknown = new Set();
    for (const definition of definitions) {
        const name = String(definition.name || '');
        if (name && !CURATED_NAMES.has(name))
            unknown.add(name);
    }
    return Math.max(0, unknown.size - MAX_CUSTOM_TOOLS);
}
/**
 * The compact form injected into the first request of every provider. One line
 * per group; names and purposes only.
 */
export function renderToolsList(entries, omitted = 0) {
    const lines = [
        '# TOOLS LIST — everything Causyne Agent owns, as `name: purpose`.',
        'Names/purposes only; these are not argument schemas or grants. Choose the needed names with `tool_search` (names array), then use their loaded schemas. Revisit this catalog when the task changes. Peer-native tools remain available independently.'
    ];
    const groups = [...GROUP_ORDER, 'custom'];
    for (const group of groups) {
        const members = entries.filter((entry) => entry.group === group);
        if (members.length === 0)
            continue;
        lines.push(`${group}: ${members.map((entry) => `${entry.name}: ${entry.hint}`).join(' | ')}`);
    }
    if (omitted > 0)
        lines.push(`+${omitted} more custom tools: reach them with tool_search.`);
    return lines.join('\n');
}
/** The same list as a Markdown table, for docs and for humans reading a transcript. */
export function renderToolsListMarkdown(entries) {
    const rows = entries.map((entry) => `| \`${entry.name}\` | ${entry.group} | ${entry.hint} |`);
    return ['| Tool | Group | Purpose |', '| --- | --- | --- |', ...rows].join('\n');
}
/** Resolve a free-text need against the list. Used by decideTools for plan and request text. */
export function findListedTool(entries, name) {
    const wanted = String(name || '').trim().toLowerCase();
    if (!wanted)
        return null;
    return entries.find((entry) => entry.name.toLowerCase() === wanted) ?? null;
}
