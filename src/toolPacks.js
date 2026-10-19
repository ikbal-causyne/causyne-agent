// Sovereign Progressive Disclosure — Capability Packs
//
// Causyne ships 69 native tools. Sending every schema on every LLM call costs
// ~14,700 tokens per step before the agent has done any work, and half of that
// is game tooling that a "rename my files" task never touches.
//
// This module does NOT remove any capability. It only controls *when* a schema
// enters the context window. Every tool stays reachable through three routes:
//   1. Intent pre-warm      — routePacks() unlocks the right packs before step 1
//   2. tool_search          — the agent discovers and unlocks any pack on demand
//   3. Auto-unlock recovery — calling a locked-but-real tool unlocks its pack
//
// Set config.grantAllTools = true to disable deferral entirely.

// ---------------------------------------------------------------------------
// Pack membership. Names match the `name` field of each tool schema, with dots
// already normalised to underscores (see tools/registry.js TOOL_DEFINITIONS).
// ---------------------------------------------------------------------------

export const CORE_TOOLS = [
  'sysRun',
  'sysRunBg',
  'terminal_persistent_shell',
  'fs_read',
  'fs_write',
  'fs_edit',
  'MultiEdit',
  'fs_list',
  'fs_search',
  'fs_find',
  'fs_move',
  'fs_delete',
  'gitOp',
  'code_search_ripgrep',
  'codebase_search',
  'code_verify_syntax',
  'web_search',
  'web_fetch',
  'TodoWrite',
  'update_plan',
  'memory_write',
  'fs_read_skill',
  'skill_create',
  'tool_search'
];

export const PACKS = {
  game: [
    // Stage 1 of the game cascade calls check_system_specs to verify the
    // engine, so it must travel with this pack as well as with media.
    'check_system_specs',
    'godot_act',
    'game_build_html5',
    'game_asset_fetch',
    'game_asset_harvest',
    'game_lore_forge',
    'game_dialogue_tree_gen',
    'game_quest_arc_builder',
    'game_animation_rig',
    'game_ai_behavior_tree',
    'game_cinematic_sequencer',
    'game_audio_synth',
    'game_vfx_emitter_gen',
    'game_shader_forge',
    'game_scene_build',
    'game_entity_spawner',
    'game_tilemap_gen',
    'game_ui_hud_builder',
    'game_economy_balancer',
    'game_data_forge',
    'game_web_runtime_inspector',
    'game_canvas_audit'
  ],
  web: [
    'browser_act',
    'screenshot',
    'vision_inspect_ui',
    'view_image',
    'astryx_oracle'
  ],
  media: [
    'generate_media_via_api',
    'execute_procedural_media',
    'check_system_specs',
    'manage_local_dependencies',
    'blender_act',
    'resolve_act',
    'palmier_act'
  ],
  system: [
    // Channel B of the Three-Channel Doctrine: reading the screen as structured
    // text instead of pixels. Lives here rather than in core because most tasks
    // never touch a GUI, and tool_search brings it in the moment one does.
    'ax_snapshot',
    // Channel C. Ships beside its observer on purpose: acting on a screen you
    // have not read is how an agent clicks the wrong button confidently.
    'desktop_act',
    'process_list',
    'proc_term',
    'archive',
    'clipboard',
    'desktop_open',
    'printer_print',
    'printer_list_printers',
    'printer_get_status'
  ],
  advanced: [
    'tool_forge',
    'agent_subagent_orchestrate',
    'code_search_ast',
    'code_list_symbols',
    'pdf_read'
  ]
};

export const PACK_NAMES = Object.keys(PACKS);

/**
 * The core tools that ship in EVERY request on a provider with no native
 * schema deferral. The rest of CORE_TOOLS is withheld until the model asks for
 * it with `tool_search`, exactly as a capability pack is.
 *
 * WHY: Anthropic can hold schemas server-side (`defer_loading` +
 * `tool_search_tool_regex`), so on Claude the full core costs nothing to
 * advertise. That is one provider out of eleven. On OpenAI, Gemini, DeepSeek,
 * Qwen, Muse, xAI, Moonshot, Ollama and the two BYOK paths, all 24 core
 * schemas were serialised into every single request — 3,341 tokens, of which a
 * typical turn calls two.
 *
 * WHAT IS IN, AND WHY EXACTLY THESE: read, write, edit, list and search cover
 * every file operation a first turn can need; `sysRun` is the escape hatch that
 * can reach anything the other seven cannot; `TodoWrite` is how a multi-step
 * task announces its plan on step one; `tool_search` is the door to the other
 * 62. With this set the agent is never stuck — worst case it spends one call
 * discovering the tool it wants, and the tool it discovers stays loaded for the
 * rest of the task.
 *
 * WHAT WITHHOLDING DOES NOT DO: it does not remove capability. `resolveTool()`
 * still resolves a withheld core tool by name, so a model that calls one from
 * memory simply gets it. Only the schema is absent, never the tool.
 */
export const RESIDENT_TOOLS = [
  'fs_read',
  'fs_write',
  'fs_edit',
  'fs_list',
  'fs_search',
  'sysRun',
  'TodoWrite',
  'tool_search'
];

const RESIDENT_TOOL_SET = new Set(RESIDENT_TOOLS);

/** True when this core tool ships in every request even without native deferral. */
export function isResidentTool(toolName) {
  return RESIDENT_TOOL_SET.has(toolName);
}

// A tool may legitimately belong to more than one pack — check_system_specs is
// Stage 1 of the game cascade and Stage 2 of the media hierarchy — so
// membership is a set, not a single value.
const TOOL_TO_PACKS = (() => {
  const map = new Map();
  for (const packName of PACK_NAMES) {
    for (const toolName of PACKS[packName]) {
      if (!map.has(toolName)) map.set(toolName, new Set());
      map.get(toolName).add(packName);
    }
  }
  return map;
})();

const CORE_TOOL_SET = new Set(CORE_TOOLS);

/** Every pack a tool belongs to. Empty for core and forged tools. */
export function packsForTool(toolName) {
  return TOOL_TO_PACKS.get(toolName) || null;
}

/** Primary pack for a tool, or 'core' if it is always loaded. */
export function packForTool(toolName) {
  if (CORE_TOOL_SET.has(toolName)) return 'core';
  const packs = TOOL_TO_PACKS.get(toolName);
  return packs ? [...packs][0] : null;
}

export function isCoreTool(toolName) {
  return CORE_TOOL_SET.has(toolName);
}

// ---------------------------------------------------------------------------
// Pack playbooks. These were previously hardcoded into the always-on
// SYSTEM_PROMPT, costing every task ~2,000 tokens of instructions about game
// cascades and media hierarchies it would never use. They now travel with their
// pack, so they arrive exactly when they become relevant.
// ---------------------------------------------------------------------------

export const PACK_PLAYBOOKS = {
  web: `# FRONTEND ENGINEERING MANDATE (CREATIVE DIVERSITY ENGINE)
When building websites, UIs, dashboards, or web applications, follow this design system hierarchy:
## Design System Selection
1. **If the user specifies a design system** (Tailwind, Material-UI, Astryx, etc.) — use it without question.
2. **If the project already has a design system installed** (detected via package.json) — use the existing one. Never mix systems.
3. **If building from scratch with no preference stated** — You have CREATIVE FREEDOM. Intelligently choose the approach that best fits the project's personality and user intent:
   - **Astryx (@astryxdesign/core)**: Use the 'astryx_oracle' tool for docs. Best for enterprise dashboards, SaaS products, and design-system-heavy projects. If you choose Astryx, never hallucinate props — always query the oracle first.
   - **Tailwind CSS**: Best for rapid prototyping, marketing sites, and projects needing maximum customization speed.
   - **Vanilla CSS**: Best for artistic, portfolio, and showcase sites where every pixel is intentional.
   - **CSS Modules / Styled Components**: Best for React component libraries and design-token-driven architectures.
## ANTI-AI-SLOP DIRECTIVE (MANDATORY)
You MUST produce visually UNIQUE output on every project. Specifically:
- **BANNED**: Purple-to-blue gradients as the primary color scheme. This is the #1 AI slop signature.
- **BANNED**: Generic hero sections with centered text + gradient background + "Get Started" button.
- **REQUIRED**: Before writing any CSS, internally decide on a SPECIFIC design movement to draw from. Examples: Swiss/International Style, Brutalism, Art Deco, Japanese Minimalism, Neomorphism, Glassmorphism, Memphis Design, Bauhaus, Editorial/Magazine, Retro-Futurism, Scandinavian Minimal. Commit to one. Don't blend 5 styles into mush.
- **REQUIRED**: Choose a curated, harmonious color palette (NOT random defaults). Use HSL for precision. Reference real-world brands known for outstanding design (Stripe's clean whites, Linear's deep darks, Notion's warm neutrals, Vercel's stark monochrome).
- **REQUIRED**: Use modern web fonts (Inter, Outfit, Space Grotesk, JetBrains Mono, etc.) — NEVER browser defaults.
- **REQUIRED**: After building, use 'screenshot' or 'browser_act' to VISUALLY VERIFY your work. If it looks like every other AI-generated site, tear it down and rebuild with a different approach.
- **REQUIRED**: Once the design is finished, call 'memory_write' with the creativePattern argument (project, designApproach, colorPalette, fonts). This is what lets the next project deliberately differ from this one instead of drifting back into the same house style.
- **ENFORCED, NOT ADVISORY**: every HTML/CSS file you write is read back and scored by an automatic gate before the task can finish (src/slopDetector.js). It looks for the stock gradient hexes, purple-to-blue ramps, placeholder marketing copy, emoji used as icons, default-only typography, the centered-hero/3-cards/"Get Started" skeleton and the stock soft shadow. Score too high and you will be sent back to rebuild with a named design movement. Design it properly the first time; the gate is not fooled by swapping one gradient for another.`,

  media: `# Media Generation Protocol (Sovereign 5-Stage Hierarchy & Seamless Consent Routing)
When the user asks you to generate images, audio, music, video, or any creative media, you MUST navigate this exact 5-Stage priority chain:

## Stage 1: Specialized Paid APIs (Primary / Auto-Router)
Always attempt calling \`generate_media_via_api\` FIRST.
- **Capabilities**: Auto-routes to Gemini Veo 2 / Imagen 3, OpenAI DALL-E 3 / Sora 2 / TTS, or Qwen Wan based on configured keys.
- **Interactive Pre-Flight Consent**: \`generate_media_via_api\` will automatically show exact Cost Estimation ($) and Token Usage Estimation (~Equivalent MEU Tokens) to the user before spending credits.
- **Seamless Denial Routing**: If the user denies or rejects the cost modal (\`approved: false\`) OR if no paid API keys exist, do NOT crash or stop. Immediately transition to Stage 2.

## Stage 2: Local AI Models / Binaries (Mode B & C — First Fallback)
When Stage 1 is denied or unconfigured, you MUST evaluate local processing on the user's PC:
1. **Mandatory Gatekeeper**: Call \`check_system_specs\` FIRST right now to verify hardware.
2. **Eligibility & Action**: If RAM >= 8GB and Free Disk > 10GB, use \`manage_local_ai_dependencies\` (\`pipInst\` or \`fetchBin\`) + \`sysRun\` to run:
   - **Audio / Voice / Music**: Kokoro TTS, XTTS, MusicGen (\`pipInst\`), or Whisper (\`whisper.cpp\` / \`bark.cpp\`).
   - **Image / Art**: Stable Diffusion via \`diffusers\` or \`stable-diffusion.cpp\`.
3. **Download Consent**: Present exact model/binary size to the user before downloading multi-GB files.
4. **Seamless Denial Routing**: If \`check_system_specs\` shows RAM < 8GB OR the user denies multi-GB local downloads, immediately transition to Stage 3.

## Stage 3: Free Cloud APIs / Pollinations.ai (Mode D — Second Fallback)
When Stage 2 is impossible or denied, fall back to free cloud APIs via \`generate_media_via_api\` (\`provider: 'pollinations'\`).
- **Capabilities**: High-quality images (\`flux\`, \`turbo\`) and audio TTS (\`nova\`, \`alloy\`) at $0 Cost and 0 MB local storage.
- **Seamless Denial/Failure Routing**: If Pollinations fails (\`HTTP 500\`) OR does not natively support the format (e.g., instrumental music tracks or complex video animations), immediately transition to Stage 4.

## Stage 4: Targeted Web Search & Asset Retrieval (Third Fallback)
When Stage 3 fails or does not support the format:
- Use \`web_search\` + \`web_fetch\` to search the internet for royalty-free stock videos, public domain images, sound effects, or instrumental background music tracks matching the user's exact intent and prompt. Download and verify the asset locally.
- **Seamless Failure Routing**: If no satisfactory asset can be retrieved online, immediately transition to Stage 5.

## Stage 5: Sandboxed Procedural Code Generation (Mode A — Ultimate Fallback)
When all previous stages are unavailable or fail, generate the media procedurally from scratch using \`execute_procedural_media\`:
- **Image / Art**: Write SVG vector graphics or HTML5 Canvas scripts.
- **Video / Animation**: Write HTML5 Canvas animation scripts that capture frames to video, or Python mathematical video scripts (\`matplotlib.animation\` / \`cv2\`). If frames need encoding and Blender is present, \`blender_act\` -> \`render_animation\` encodes them without any external binary; never conclude from a failed \`which ffmpeg\` that encoding is impossible.
- **Audio / Music**: Write mathematical Python scripts (\`numpy\` + \`scipy.io.wavfile\` or \`wave\`) generating custom waveforms, chiptune melodies, or sound effects.

## CRITICAL MULTIMEDIA MANDATE:
Never stop or say "I cannot generate video/music" without traversing this entire 5-Stage hierarchy from Stage 1 down to Stage 5! Every stage denial (\`approved: false\`) is a signal to immediately trigger the next stage.
# BLENDER / 3D MANDATE — READ BEFORE ANY blender_act CALL

THE ONE RULE THAT DECIDES WHETHER THE RESULT IS GOOD:
**Use the smart actions. Do NOT write raw bpy Python for anything they cover.**
\`smartGeometry\`, \`smartMaterial\`, \`setupStudioLighting\`, \`cinematicAtmosphere\`
and \`autoFrameCamera\` already carry the craft — bevel widths, subdivision,
three-point key/fill/rim ratios, volumetric fog, a 65mm lens at a studio angle.
Hand-written bpy re-derives all of that badly and is why AI 3D looks like AI 3D:
default grey material, one flat lamp, camera at the origin. \`executePython\` is
for the gaps between these, never a replacement for them.

## Order of operations — do not reorder, do not skip

1. Verify the local Blender binary and use \`runHeadless\` for automation.
2. \`clearScene\`. Blender starts with a cube, a lamp and a camera. Shipping the
   default cube in frame is the single most common failure.
3. Geometry via \`smartGeometry\`. Build the silhouette first and only then the
   detail; a shape that does not read in a 64px thumbnail will not read at 4K.
4. \`smartMaterial\` on EVERY visible object. Untouched objects render as default
   grey plastic, and one grey object in an otherwise dressed scene is what makes
   a render read as unfinished.
5. \`setupStudioLighting\`, then \`cinematicAtmosphere\`. Lighting before atmosphere:
   fog scatters the lights you have, so adding it first means tuning blind.
6. \`autoFrameCamera\`. Never leave the camera where Blender put it.
7. LOOK AT IT. Produce a single \`renderFrame\` at low samples, then
   \`view_image\` or \`vision_inspect_ui\`. **A render you
   have not looked at is not a finished render.** If it reads as flat, grey or
   empty, fix it and look again — that loop is the whole difference.
8. Only now \`renderAnimation\`.

## Cinematic defaults that are not negotiable

- **Never one light.** \`setupStudioLighting\` gives key/fill/rim; a single lamp is
  the signature of an unfinished scene.
- **Never the default camera angle.** Slightly above eye line, subject off-centre.
- **Motion must be motivated.** An 8-second shot is ONE move — a slow orbit, a
  push-in, or a rise. Three moves in eight seconds reads as a screensaver.
- **Frame rate and length are arithmetic, so state them.** 8s at 24fps is frames
  1-192. Set the range explicitly; do not leave Blender's 250-frame default.
- **Render settings:** EEVEE for anything under a minute of work — Cycles at
  default samples on a laptop is how a task burns its whole budget on one frame.

## Never infer installation from PATH alone

Do NOT run \`which blender\`. It fails on macOS for every ordinary .app install
because nothing is symlinked onto PATH — Blender can be sitting in /Applications
and \`which\` will still say "command not found". Acting on that has already cost
a real user a multi-hundred-megabyte re-download of software they already had.

**The same trap applies to every other tool, and \`ffmpeg\` is the one you will
reach for next.** \`which ffmpeg\` failing does NOT mean this machine cannot
encode video. It usually means the encoder is bundled inside an application
rather than installed on PATH.

## You already have an encoder: Blender is one

Blender links FFmpeg internally. If you can render frames, you can encode video
— with no external binary, no install, and no PATH lookup.

Use \`blender_act\` with the \`render_animation\` action and an \`.mp4\` target. It
sets \`image_settings.file_format = 'FFMPEG'\` with an H.264/MPEG4 container, and
it ALREADY falls back to a PNG sequence plus a probed external encoder if the
direct path fails. Hand-writing an encode script and shelling out to \`ffmpeg\`
re-solves a solved problem and, on a machine without it on PATH, fails where the
tool would have succeeded.

Check the exact API against the running build before writing Python by hand —
Blender renames render and sequencer attributes between major versions, and a
script written from memory for an older release will exit non-zero.

Only when the Blender tool's local executable check reports no valid binary is
Blender genuinely missing. Then say so plainly, offer the two options — install it, or produce the shot
with \`execute_procedural_media\` — and let the user choose. Never start a large
download on your own initiative.
`,

  game: `# Sovereign Game Development Cascade & Enforcement Engine
When the user asks you to build, create, test, expand, or develop ANY game, you MUST strictly follow this mandatory 7-stage production methodology using specialized game tools. YOU MUST NOT SKIP STAGES.
**CRITICAL MANDATE**: You are building a **FULL PRODUCTION GAME**. It is completely unacceptable to finish a game in under 50-100 steps. A full game requires multiple levels, complex AI states, numerous sound effects, shaders, and rich tilemaps. You MUST iterate heavily and expand the scope to reach production scale.

1. **Stage 1 (Engine Verification)**: Run \`check_system_specs\` (\`engine: 'godot'\`). If valid, use \`godot_act\` for project creation/validation.
2. **Stage 2 (Narrative & Worldbuilding)**: Use \`game_lore_forge\`, \`game_dialogue_tree_gen\`, and \`game_quest_arc_builder\`. Expand this stage massively.
3. **Stage 3 (Character Rigging & AI)**: Use \`game_animation_rig\`, \`game_ai_behavior_tree\`, and \`game_cinematic_sequencer\`. Create 5+ enemy types.
4. **Stage 4 (Harvesting, Audio & VFX)**: Use \`game_asset_harvest\`, \`game_audio_synth\`, and \`game_vfx_emitter_gen\`.
5. **Stage 5 (Shaders, Scenes & Spawners)**: Use \`game_shader_forge\`, \`game_scene_build\`, and \`game_entity_spawner\`. Design at least 3 sprawling levels.
6. **Stage 6 (Maps, UI & Economy)**: Use \`game_tilemap_gen\`, \`game_ui_hud_builder\`, and \`game_economy_balancer\`.
7. **Stage 7 (Assembly & Verification)**: If building a browser/WebGL game, invoke \`game_build_html5\`. **CRITICAL**: You MUST NOT inject 200+ lines of monolithic physics/logic inside \`game_build_html5.customScript\` until you have modularly completed Stages 1-6. After Assembly, you MUST execute \`game_web_runtime_inspector\` and \`game_canvas_audit\` to verify runtime integrity (FPS >= 30, no syntax errors, visual canvas rendering) before declaring Task completed.`
};

// ---------------------------------------------------------------------------
// Intent routing.
//
// The previous implementation used bare substring matching, which produced
// catastrophic false positives: 'ui' matched "build", "quick" and
// "requirements"; 'race' matched "trace". Those false positives triggered
// completion-blocking guards that forced dozens of extra LLM round trips on
// tasks that had nothing to do with games or web UI.
//
// Every matcher below is anchored on word boundaries and tested against the
// raw prompt only.
// ---------------------------------------------------------------------------

const GAME_INTENT = /\b(game|games|gamedev|permainan|godot|unity|unreal|rpg|platformer|roguelike|arcade|sprite|spritesheet|tilemap|voxel|minecraft|aetheria|voxellia|nes|snes|gameplay|player character|level design|boss fight)\b|\.(tscn|gd)\b/i;

const WEB_INTENT = /\b(web|webpage|website|situs|frontend|front-end|landing page|homepage|dashboard|portfolio|html|css|scss|tailwind|bootstrap|react|vue|svelte|angular|next\.?js|nuxt|astro|ui|ux|user interface|web app|webapp|spa|dom|responsive)\b/i;

const MEDIA_INTENT = /\b(image|images|picture|photo|gambar|render|3d model|blender|animation|animate|video|movie|film|klip|audio|sound|sfx|music|musik|song|lagu|voice|suara|tts|text.to.speech|narration|podcast|thumbnail|poster|illustration|logo)\b/i;

const SYSTEM_INTENT = /\b(process|processes|pid|kill|port|zip|unzip|tar|archive|compress|extract|clipboard|copy to clipboard|print|printer|cetak|open in browser|launch app)\b/i;

const ADVANCED_INTENT = /\b(pdf|forge a tool|custom tool|new tool|subagent|sub-agent|parallel agent|swarm|ast|symbols|refactor across)\b/i;

const INTENT_MATCHERS = {
  game: GAME_INTENT,
  web: WEB_INTENT,
  media: MEDIA_INTENT,
  system: SYSTEM_INTENT,
  advanced: ADVANCED_INTENT
};

/** True when the prompt genuinely describes game development work. */
export function isGameIntent(prompt) {
  return GAME_INTENT.test(prompt || '');
}

/** True when the prompt genuinely describes web/UI work. */
export function isWebIntent(prompt) {
  return WEB_INTENT.test(prompt || '');
}

/**
 * Decide which packs to unlock before the first LLM call, so the common case
 * costs zero discovery round trips.
 *
 * @param {string} prompt            The user's task text.
 * @param {object} workspaceContext  Optional perception output; its detected
 *                                   frameworks and files are strong signals.
 * @returns {string[]} pack names to unlock
 */
export function routePacks(prompt, workspaceContext = null) {
  const unlocked = new Set();
  const text = prompt || '';

  for (const packName of PACK_NAMES) {
    if (INTENT_MATCHERS[packName].test(text)) {
      unlocked.add(packName);
    }
  }

  // Workspace signals. A Godot project on disk is far more reliable evidence of
  // game work than any keyword, and a detected web framework means the agent
  // will eventually need to look at what it built.
  if (workspaceContext) {
    const signals = [
      workspaceContext.framework,
      workspaceContext.projectType,
      workspaceContext.designSystem,
      Array.isArray(workspaceContext.keyFiles) ? workspaceContext.keyFiles.join(' ') : ''
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    if (/godot|project\.godot|unity|\.tscn/.test(signals)) unlocked.add('game');
    if (/react|vue|svelte|next|nuxt|astro|angular|tailwind|vite|html/.test(signals)) unlocked.add('web');
  }

  return [...unlocked];
}

/**
 * Resolve the tool schemas that should enter the context window.
 * Core tools always load; pack tools load only once their pack is unlocked.
 *
 * Ordering is APPEND-ONLY and this matters a great deal for cost. Every
 * provider's prompt cache binds on an identical prefix, and tool definitions
 * sit at the very front of that prefix — so if unlocking a pack mid-task
 * reshuffles the array, the cache is invalidated from the first changed byte
 * onward, taking the system prompt and the whole message history with it.
 * Sorting pack tools alphabetically did exactly that: unlocking `system`
 * inserted `archive` ahead of `astryx_oracle` and truncated the stable prefix
 * to 82%. Ordering by unlock sequence instead keeps 100% of the previously
 * cached prefix intact and appends only the new tail.
 *
 * @param {Array}  allDefinitions  Full TOOL_DEFINITIONS list.
 * @param {Set}    unlockedPacks   Pack names unlocked for this task.
 * @param {Set}    unlockedTools   Individually unlocked tool names.
 * @param {Array}  unlockOrder     Pack names in the order they were unlocked.
 * @returns {Array} filtered definitions, deterministically ordered
 */
export function resolveActiveTools(allDefinitions, unlockedPacks, unlockedTools, unlockOrder = null, options = {}) {
  const packs = unlockedPacks || new Set();
  const tools = unlockedTools || new Set();
  // Providers with native schema deferral (Anthropic) leave this off — server
  // side deferral is strictly better, since it costs no discovery round trip.
  const residentOnly = options.residentOnly === true;

  const active = allDefinitions.filter(def => {
    if (isCoreTool(def.name)) {
      if (!residentOnly) return true;
      return isResidentTool(def.name) || tools.has(def.name);
    }
    if (tools.has(def.name)) return true;
    const memberOf = packsForTool(def.name);
    // A tool with no declared pack is a forged/custom tool: always available,
    // because the user explicitly created it for this machine.
    if (!memberOf) return true;
    for (const pack of memberOf) {
      if (packs.has(pack)) return true;
    }
    return false;
  });

  // The stable head of the array. Without residentOnly that is the whole core;
  // with it, only the resident subset — and that distinction matters for the
  // prompt cache, not just for token count.
  //
  // A core tool unlocked mid-task must NOT be slotted back into its CORE_TOOLS
  // position: that inserts into the middle of the array and invalidates the
  // cached prefix from that point on, every time. It is appended to the tail
  // below instead, so the head stays byte-identical for the whole task.
  const isHead = (name) => !residentOnly || isResidentTool(name);
  const coreFirst = active.filter(d => isCoreTool(d.name) && isHead(d.name));
  coreFirst.sort((a, b) => CORE_TOOLS.indexOf(a.name) - CORE_TOOLS.indexOf(b.name));

  // Pack tools grouped by unlock sequence, alphabetical only within a group so
  // the tail added by any single unlock is itself deterministic.
  const sequence = Array.isArray(unlockOrder) && unlockOrder.length > 0
    ? unlockOrder
    : [...packs];
  const rankOfPack = new Map(sequence.map((name, index) => [name, index]));

  const rankOf = (def) => {
    // A non-resident core tool the model discovered via tool_search. Ranked
    // ahead of every pack so the tail stays grouped, but behind the fixed head.
    if (isCoreTool(def.name)) return -1;
    const memberOf = packsForTool(def.name);
    if (!memberOf) return Number.MAX_SAFE_INTEGER; // forged tools last
    let best = Number.MAX_SAFE_INTEGER;
    for (const pack of memberOf) {
      const rank = rankOfPack.get(pack);
      if (rank !== undefined && rank < best) best = rank;
    }
    return best;
  };

  const rest = active.filter(d => !isCoreTool(d.name) || !isHead(d.name));
  rest.sort((a, b) => {
    const diff = rankOf(a) - rankOf(b);
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  });

  return [...coreFirst, ...rest];
}

/** Human-readable catalogue injected into the system prompt so the model knows what it can unlock. */
export function getPackCatalogue(unlockedPacks) {
  const packs = unlockedPacks || new Set();
  const lines = PACK_NAMES.map(name => {
    const state = packs.has(name) ? 'LOADED' : 'available';
    return `- ${name} (${PACKS[name].length} tools, ${state})`;
  });

  return `# EXTENDED CAPABILITY PACKS
Beyond the tools currently in your context you have access to specialised capability packs. Nothing is disabled — packs load on demand to keep your context focused.
${lines.join('\n')}
To load a pack, call \`tool_search\` with a query describing what you need (for example "godot scene", "generate music", "kill process on port"). The matching tool schemas become available immediately on your next turn. Never claim a capability is missing without searching first.`;
}
