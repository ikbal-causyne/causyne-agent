import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

export const gameAnimationRig = {
  schema: {
    name: 'game.animation_rig',
    description: 'Configures character rigging and animation setups for Godot 4.x. Supports 2D SpriteSheet animations (`AnimationPlayer`, `AnimatedSprite2D` frame slices) and 3D Skeletal rigs (`Skeleton3D`, `BoneAttachment3D`, `AnimationTree` state machines and 1D/2D blend spaces).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['rig_2d_spritesheet', 'rig_3d_skeleton', 'create_animation_tree', 'attach_weapon_bone'],
          description: 'Action: rig_2d_spritesheet (setup 2D frame animation), rig_3d_skeleton (setup 3D bone bindings), create_animation_tree (build state machine/blend tree), or attach_weapon_bone (bind prop/sword to hand bone).'
        },
        characterName: {
          type: 'string',
          description: 'Name of the character node (`PlayerHero`, `SkeletonWarrior`, `BossNecromancer`).'
        },
        animationList: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              anim_name: { type: 'string' },
              loop: { type: 'boolean' },
              fps: { type: 'number' },
              frames: { type: 'array', items: { type: 'number' } }
            }
          },
          description: 'List of animations (e.g. `idle`, `walk`, `attack_slash`, `hit`, `death`).'
        },
        spriteSheetPath: {
          type: 'string',
          description: 'Path to 2D texture sheet (`res://assets/2d/player_sheet.png`).'
        },
        hFrames: { type: 'number', description: 'Horizontal frames in sprite sheet.' },
        vFrames: { type: 'number', description: 'Vertical frames in sprite sheet.' },
        boneName: { type: 'string', description: 'Bone name for 3D attachment (`Hand_R`, `Spine`, `Head`).' },
        propScenePath: { type: 'string', description: 'Path to prop scene to attach (`res://assets/3d/weapons/iron_sword.tscn`).' },
        outputPath: { type: 'string', description: 'Output `.tscn` or `.tres` path to write the rigging definitions.' }
      },
      required: ['action', 'characterName']
    }
  },

  async execute(args) {
    try {
      const { action, characterName, animationList = [], spriteSheetPath = 'res://assets/2d/hero.png', hFrames = 6, vFrames = 4, boneName = 'Hand_R', propScenePath = 'res://assets/3d/sword.tscn', outputPath } = args;

      if (action === 'rig_2d_spritesheet') {
        const anims = animationList.length > 0 ? animationList : [
          { anim_name: 'idle', loop: true, fps: 8, frames: [0, 1, 2, 3] },
          { anim_name: 'walk', loop: true, fps: 12, frames: [6, 7, 8, 9, 10, 11] },
          { anim_name: 'attack_slash', loop: false, fps: 16, frames: [12, 13, 14, 15] },
          { anim_name: 'hit', loop: false, fps: 10, frames: [18, 19] },
          { anim_name: 'death', loop: false, fps: 8, frames: [20, 21, 22, 23] }
        ];

        // Generate Godot AnimationPlayer tracks for Sprite2D frame indexing
        let animSubresources = '';
        let animLibEntries = '';
        let stepCount = 1;

        for (const anim of anims) {
          const duration = (anim.frames.length / (anim.fps || 10)).toFixed(3);
          const loopMode = anim.loop ? '1' : '0';
          const keys = anim.frames.map((f, idx) => `${(idx / (anim.fps || 10)).toFixed(3)}: ${f}`).join(', ');

          animSubresources += `[sub_resource type="Animation" id="Animation_${stepCount}"]
resource_name = "${anim.anim_name}"
length = ${duration}
loop_mode = ${loopMode}
tracks/0/type = "value"
tracks/0/imported = false
tracks/0/enabled = true
tracks/0/path = NodePath("Sprite2D:frame")
tracks/0/interp = 1
tracks/0/loop_wrap = true
tracks/0/keys = {
"times": PackedFloat32Array(${anim.frames.map((_, idx) => (idx / (anim.fps || 10)).toFixed(3)).join(', ')}),
"transitions": PackedFloat32Array(${anim.frames.map(() => '1').join(', ')}),
"update": 1,
"values": [${anim.frames.join(', ')}]
}

`;
          animLibEntries += `"${anim.anim_name}": SubResource("Animation_${stepCount}"),\n`;
          stepCount++;
        }

        animSubresources += `[sub_resource type="AnimationLibrary" id="AnimationLibrary_rig"]
_data = {
${animLibEntries.trim()}
}
`;

        const sceneTree = `[gd_scene load_steps=${stepCount + 2} format=3]

[ext_resource type="Texture2D" path="${spriteSheetPath}" id="1_tex"]

${animSubresources}
[node name="${characterName}" type="CharacterBody2D"]

[node name="Sprite2D" type="Sprite2D" parent="."]
texture = ExtResource("1_tex")
hframes = ${hFrames}
vframes = ${vFrames}

[node name="AnimationPlayer" type="AnimationPlayer" parent="."]
libraries = {
"": SubResource("AnimationLibrary_rig")
}
`;

        if (outputPath) {
          await fs.mkdir(path.dirname(outputPath), { recursive: true });
          await fs.writeFile(outputPath, sceneTree, 'utf8');
        }

        return {
          success: true,
          output: JSON.stringify({
            status: 'RIGGED_2D_SPRITESHEET',
            character: characterName,
            sprite_sheet: spriteSheetPath,
            animations_configured: anims.map(a => a.anim_name),
            output_file: outputPath || 'Returned in payload',
            scene_snippet: sceneTree.slice(0, 1000)
          }, null, 2)
        };
      }

      if (action === 'create_animation_tree') {
        const treeConfig = {
          character: characterName,
          tree_type: 'AnimationTree',
          state_machine: {
            states: ['Idle', 'Walk', 'AttackSlash', 'Hit', 'Death'],
            transitions: [
              { from: 'Idle', to: 'Walk', condition: 'is_moving' },
              { from: 'Walk', to: 'Idle', condition: '!is_moving' },
              { from: 'Idle', to: 'AttackSlash', condition: 'attack_trigger' },
              { from: 'Walk', to: 'AttackSlash', condition: 'attack_trigger' },
              { from: 'AttackSlash', to: 'Idle', condition: 'auto_finish' },
              { from: 'Any', to: 'Hit', condition: 'take_damage' },
              { from: 'Any', to: 'Death', condition: 'hp_zero' }
            ]
          },
          gdscript_integration: `
# Paste into ${characterName}.gd
@onready var anim_tree: AnimationTree = $AnimationTree
@onready var state_machine = anim_tree.get("parameters/playback")

func _physics_process(delta: float) -> void:
\tvar velocity_length = velocity.length()
\tvar is_moving = velocity_length > 10.0
\tanim_tree.set("parameters/conditions/is_moving", is_moving)
\tanim_tree.set("parameters/conditions/not_moving", not is_moving)
`
        };

        return {
          success: true,
          output: JSON.stringify(treeConfig, null, 2)
        };
      }

      if (action === 'attach_weapon_bone') {
        const attachmentSnippet = `[node name="BoneAttachment_${boneName}" type="BoneAttachment3D" parent="Skeleton3D"]
bone_name = "${boneName}"

[node name="EquippedWeapon" parent="Skeleton3D/BoneAttachment_${boneName}" instance=ExtResource("${propScenePath}")]
position = Vector3(0, 0.1, 0)
rotation_degrees = Vector3(90, 0, 0)
`;
        return {
          success: true,
          output: JSON.stringify({
            status: 'ATTACHED_WEAPON_BONE',
            bone: boneName,
            prop: propScenePath,
            scene_snippet: attachmentSnippet
          }, null, 2)
        };
      }

      return { success: false, error: `Unknown action: ${action}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
