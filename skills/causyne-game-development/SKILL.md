---
name: causyne-game-development
description: Authoritative 20-tool workflow guide and best practices for developing commercial, production-ready games using Godot 4.x or standalone HTML5 Web engines (`cyberpunk_racer_3d`, `topdown_rpg_2d`) with Causyne Agent.
---

# Causyne Game Development Mastery & 20-Tool Production Pipeline

When tasked with creating, expanding, or troubleshooting games (`Chronicles of Aetheria`, `Cyberpunk Highway 3D`, etc.), you **MUST** follow this structured, multi-phase production methodology utilizing the 20 specialized game automation tools.

## 1. Engine & Environment Protocol (`check_system_specs` -> `godot.act` -> `game.build_html5`)
1. **Pre-Check**: Run `check_system_specs` with `action: "verify_game_engine"` (`engine: "godot"` or `"blender"`).
2. **Auto-Download / Install**: If Godot is missing and internet/permissions allow, `check_system_specs` (`autoDownload: true`) downloads and installs Godot 4.x to `~/Causyne/causyne-agent/.engine_cache/`.
3. **Primary Engine (`godot.act`)**: When Godot is present or installed, create and manage `.godot` projects using `godot.act` (`create_project`, `validate_project`, `test_scene`, `export_project`).
4. **Standalone Web Fallback (`game.build_html5`)**: If Godot installation is impossible or the user requests an instant playable web game, use `game.build_html5` (`threejs` or `canvas2d` with templates `space_defense_3d`, `cyberpunk_racer_3d`, `topdown_rpg_2d`, or `arcade_platformer_2d`). All web games include the offline **Sovereign Audio Engine** for procedural SFX & looping Synthwave BGM.

## 2. The 20-Tool Production Suite & Phase Breakdown

### Phase 1: Core Engine & Automation
- `check_system_specs`: Verifies hardware, downloads missing Godot binaries, and tests display dependencies.
- `godot.act`: Executes Godot CLI commands (`--headless`, `--validate`, `--export`) and WebSocket live scene inspection.
- `game.build_html5`: Instant standalone Three.js WebGL & Canvas 2D engine with procedural audio (`audio: true`).

### Phase 2: Narrative & Worldbuilding Suite
- `game.lore_forge`: Generates multi-era historical codexes (`world_bible.json`), faction geopolitics, and biome climates.
- `game.dialogue_tree_gen`: Engineers multi-branching NPC dialogue trees (`dialogue_trees.json`) with conditional check headers and quest triggers.
- `game.quest_arc_builder`: Builds multi-stage main/side quests (`quest_database.json`) with prerequisite locks, objectives, and item reward bundles.

### Phase 3: Character Rigging, Animation & State Machines
- `game.animation_rig`: Generates 2D SpriteFrames / 3D Skeleton3D node configurations and `AnimationPlayer` clips (`idle`, `walk`, `attack_slash`, `hit`, `death`).
- `game.ai_behavior_tree`: Engineers NPC and enemy state machines (`PatrolState`, `ChaseState`, `AttackState`, `BossPhaseController`) with `NavigationAgent` pathfinding.
- `game.cinematic_sequencer`: Builds cutscene timelines, `Camera2D/3D` position/zoom interpolation keyframes, screen shake controllers, and dialogue synchronization.

### Phase 4: Asset Harvesting, Audio Synthesis & VFX Emitters
- `game.asset_harvest`: Searches and downloads CC0 3D models (`knight`, `race_car`), 2D sprite sheets, and dungeon tilesets (`Kenney`, `Poly Pizza`) into `res://assets/` with procedural fallbacks.
- `game.audio_synth`: Offline mathematical 16-bit PCM WAV synthesizer generating 15+ game SFX (`sword_slash`, `spell_cast`, `car_drift`, `explosion`, `boss_roar`) and looping BGM (`synthwave_racer`, `medieval_battle`).
- `game.vfx_emitter_gen`: Generates procedural `GPUParticles2D/3D` particle systems (`spell_sparkle`, `raging_fire`, `toxic_smoke`, `explosion_burst`, `laser_sparks`) with custom `ParticleProcessMaterial` resources.

### Phase 5: Shaders, Scene Construction & Entity Spawners
- `game.shader_forge`: Generates custom Godot `.gdshader` files (`water_ripple_2d`, `hit_flash_2d`, `hologram_3d`, `dissolve_burn_3d`, `speed_blur_canvas`).
- `game.scene_build`: Programmatically constructs Godot `.tscn` and `.tres` hierarchies, formats node definitions, attaches scripts (`ExtResource`), and binds signals.
- `game.entity_spawner`: Spawns ready-to-instance entity prefabs (`player_hero_2d/3d`, `skeleton_warrior_ai`, `boss_necromancer`, `cyberpunk_racer_car`, `treasure_chest`, `portal_gate`).

### Phase 6: Procedural World Maps, UI/HUD & Economy Balancing
- `game.tilemap_gen`: Procedurally generates 2D dungeon/village grids (`TileMapLayer`) and 3D highway road networks (`GridMap`, `CSGPolygon3D`) with collision boundaries.
- `game.ui_hud_builder`: Constructs responsive UI/HUD screens (`MainMenu.tscn`, `HUD.tscn` with health/stamina/gold bars, `InventoryGrid.tscn`, `DialogueBox.tscn`, `ShopMenu.tscn`).
- `game.economy_balancer`: Balances enemy stat scaling curves (`enemy_scaling.json`), item drop probability loot tables (`loot_tables.json`), item pricing formulas, and XP progression thresholds.

### Phase 7: Data Forge & Verification
- `game.data_forge`: Generates rich structured RPG JSON databases (`item_catalog.json` with 40+ swords/armors/potions/relics, `crafting_recipes.json`).
- `game.test_benchmark`: Validates game performance, AST syntax, and scene load times across engine configurations.

## 3. Strict Quality & Workspace Boundaries
1. **Clean Code & AST Verification**: Every generated `.js` tool or script must pass `node -c` syntax verification before being deployed.
2. **Workspace Enclosure**: All engine builds, project files, assets, and databases **MUST** remain inside the current workspace URI (`~/Causyne/causyne-agent/` or project folder). Never write to outside root directories.
3. **Readable Release Verification**: After any update to `src/agentLoop.js` or `src/tools/`, run `npm run build`, `npm test`, and `npm run check:release`. The release must contain auditable source and must not generate concealed bytecode.
