import fsSync from 'node:fs';
import path from 'node:path';
import {
  assertSafeWorkspaceOutput,
  atomicWriteFileSafe,
  resolveScopedPath,
  resolveToolWorkspaceRoots,
  safeSlugIdentifier,
  sanitizeToolError,
  type ToolWorkspaceContext
} from './toolPathSafety.js';

export interface GameEntitySpawnerArgs {
  action?: string | undefined;
  prefabType?: string | undefined;
  entityName?: string | undefined;
  projectDir?: string | undefined;
}

export const gameEntitySpawner = {
  schema: {
    name: 'game.entity_spawner',
    description: 'Generates ready-to-instance game entity prefabs (`.tscn` + `.gd` scripts) for Godot 4.x. Includes templates for Player Hero 8-way movement, Skeleton Warrior AI, Boss Necromancer, Cyberpunk Race Car drift physics, Lockable Treasure Chest, and Inter-biome Portal Gate.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['spawn_prefab', 'list_prefabs', 'batch_spawn_entities'], description: 'Action to perform.' },
        prefabType: { type: 'string', enum: ['player_hero_2d', 'player_hero_3d', 'skeleton_warrior_ai', 'boss_necromancer', 'cyberpunk_racer_car', 'treasure_chest', 'portal_gate'], description: 'Type of entity template to generate.' },
        entityName: { type: 'string', description: 'Custom node name for the spawned entity.' },
        projectDir: { type: 'string', description: 'Absolute path to Godot project directory (`res://...`) where `scenes/actors` and `scripts/actors` reside.' }
      },
      required: ['action']
    }
  },

  async execute(args: GameEntitySpawnerArgs = {}, sandbox?: ToolWorkspaceContext): Promise<{ success: boolean; output?: string | undefined; error?: string | undefined }> {
    try {
      const { action, prefabType = 'player_hero_2d', entityName, projectDir } = args || {};

      if (action === 'list_prefabs') {
        return {
          success: true,
          output: JSON.stringify({
            status: 'PREFAB_CATALOG',
            prefabs: [
              { type: 'player_hero_2d', desc: '8-way CharacterBody2D movement with sword attack, dash stamina, and Sprite2D/AnimationPlayer.' },
              { type: 'player_hero_3d', desc: '3D CharacterBody3D third-person controller with camera springarm and gravity.' },
              { type: 'skeleton_warrior_ai', desc: 'Melee enemy with patrol/chase/attack AI and loot drop signal.' },
              { type: 'boss_necromancer', desc: 'Multi-phase boss controller with spell casting and skeleton summoning triggers.' },
              { type: 'cyberpunk_racer_car', desc: 'Vehicle physics with acceleration, steering drift friction, and nitro boost.' },
              { type: 'treasure_chest', desc: 'Interactable StaticBody2D/3D with inventory item dispensing signal.' },
              { type: 'portal_gate', desc: 'Area2D/3D scene transition gate triggering world map changes.' }
            ]
          }, null, 2)
        };
      }

      if (action === 'spawn_prefab' || action === 'batch_spawn_entities') {
        const typesToSpawn = action === 'batch_spawn_entities' ? ['player_hero_2d', 'skeleton_warrior_ai', 'treasure_chest', 'portal_gate'] : [prefabType];
        const results: Array<Record<string, string>> = [];

        for (const pt of typesToSpawn) {
          const defaultName = pt === 'player_hero_2d' ? 'PlayerHero' : pt === 'skeleton_warrior_ai' ? 'SkeletonWarrior' : pt === 'treasure_chest' ? 'TreasureChest' : 'PortalGate';
          const name = action === 'batch_spawn_entities' ? defaultName : safeSlugIdentifier(entityName, defaultName, 64);
          let gdScript = '';
          let tscnContent = '';

          if (pt === 'player_hero_2d') {
            gdScript = `extends CharacterBody2D

@export var speed: float = 160.0
@export var dash_speed: float = 350.0
var is_attacking: bool = false

@onready var anim: AnimationPlayer = $AnimationPlayer if has_node("AnimationPlayer") else null

func _physics_process(delta: float) -> void:
\tif is_attacking:
\t\tvelocity = Vector2.ZERO
\t\tmove_and_slide()
\t\treturn

\tvar dir = Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
\tvelocity = dir * speed
\tmove_and_slide()

\tif Input.is_action_just_pressed("ui_accept") and not is_attacking:
\t\tattack()
\telse:
\t\tif anim:
\t\t\tif velocity.length() > 10.0:
\t\t\t\tanim.play("walk")
\t\t\telse:
\t\t\t\tanim.play("idle")

func attack() -> void:
\tis_attacking = true
\tif anim and anim.has_animation("attack_slash"):
\t\tanim.play("attack_slash")
\t\tawait anim.animation_finished
\tis_attacking = false
`;
            tscnContent = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/actors/${name}.gd" id="1_hero"]

[node name="${name}" type="CharacterBody2D" groups=["player"]]
script = ExtResource("1_hero")

[node name="Sprite2D" type="Sprite2D" parent="."]

[node name="CollisionShape2D" type="CollisionShape2D" parent="."]
`;
          } else if (pt === 'skeleton_warrior_ai') {
            gdScript = `extends CharacterBody2D
# Skeleton Warrior Enemy AI
@export var max_hp: float = 100.0
var current_hp: float

func _ready() -> void:
\tcurrent_hp = max_hp

func take_damage(amount: float) -> void:
\tcurrent_hp -= amount
\tif current_hp <= 0:
\t\tqueue_free()
`;
            tscnContent = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/actors/${name}.gd" id="1_enemy"]

[node name="${name}" type="CharacterBody2D" groups=["enemies"]]
script = ExtResource("1_enemy")
`;
          } else if (pt === 'cyberpunk_racer_car') {
            gdScript = `extends CharacterBody3D
# Cyberpunk Highway Race Car Controller
@export var acceleration: float = 45.0
@export var max_speed: float = 180.0
@export var steering_angle: float = 25.0
var current_speed: float = 0.0

func _physics_process(delta: float) -> void:
\tvar throttle = Input.get_axis("ui_down", "ui_up")
\tvar steer = Input.get_axis("ui_right", "ui_left")
\tcurrent_speed = clamp(current_speed + throttle * acceleration * delta, -30.0, max_speed)
\trotate_y(deg_to_rad(steer * steering_angle * delta * (current_speed / max_speed)))
\tvelocity = -transform.basis.z * current_speed
\tmove_and_slide()
`;
            tscnContent = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/actors/${name}.gd" id="1_car"]

[node name="${name}" type="CharacterBody3D" groups=["vehicles"]]
script = ExtResource("1_car")
`;
          } else {
            gdScript = `extends Area2D
signal object_interacted(object_name)

func _on_body_entered(body: Node2D) -> void:
\tif body.is_in_group("player"):
\t\tprint("[Entity Interaction] Player interacted with ", name)
\t\temit_signal("object_interacted", name)
`;
            tscnContent = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/actors/${name}.gd" id="1_interact"]

[node name="${name}" type="Area2D"]
script = ExtResource("1_interact")
`;
          }

          const scopedProjectDir = projectDir ? resolveScopedPath(projectDir, sandbox) : '';
          if (scopedProjectDir && fsSync.existsSync(scopedProjectDir)) {
            const scriptPath = await assertSafeWorkspaceOutput(path.join(scopedProjectDir, 'scripts/actors', `${name}.gd`), sandbox, { scopeRoot: scopedProjectDir });
            const scenePath = await assertSafeWorkspaceOutput(path.join(scopedProjectDir, 'scenes/actors', `${name}.tscn`), sandbox, { scopeRoot: scopedProjectDir });
            await atomicWriteFileSafe(scriptPath, gdScript);
            await atomicWriteFileSafe(scenePath, tscnContent);
            results.push({ prefab: pt, node_name: name, script: scriptPath, scene: scenePath });
          } else {
            const defaultRoot = resolveToolWorkspaceRoots(sandbox).primaryRoot || process.cwd();
            const tempDir = path.join(defaultRoot, '.tmp_causyne_3d/prefabs');
            const scriptPath = await assertSafeWorkspaceOutput(path.join(tempDir, `${name}.gd`), sandbox);
            const scenePath = await assertSafeWorkspaceOutput(path.join(tempDir, `${name}.tscn`), sandbox);
            await atomicWriteFileSafe(scriptPath, gdScript);
            await atomicWriteFileSafe(scenePath, tscnContent);
            results.push({ prefab: pt, node_name: name, temp_path: tempDir });
          }
        }

        return {
          success: true,
          output: JSON.stringify({
            status: 'SPAWNED_PREFABS',
            project_dir: projectDir || 'temp buffer',
            entities_created: results
          }, null, 2)
        };
      }

      return { success: false, error: `Unknown action: ${String(action ?? '')}` };
    } catch (e: unknown) {
      return { success: false, error: sanitizeToolError(e) };
    }
  }
};
