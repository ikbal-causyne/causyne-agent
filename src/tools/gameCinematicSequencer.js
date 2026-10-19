import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

export const gameCinematicSequencer = {
  schema: {
    name: 'game.cinematic_sequencer',
    description: 'Engineers cinematic cutscenes, camera interpolation sequences (`Camera2D/3D`), screen shake, and dialogue triggers along Godot `AnimationPlayer` timelines.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create_cutscene', 'generate_camera_shake', 'add_dialogue_track'],
          description: 'Action: create_cutscene (generate complete cinematic sequence), generate_camera_shake (reusable screen shake script), or add_dialogue_track (embed dialogue box calls inside timeline).'
        },
        sequenceName: {
          type: 'string',
          description: 'Name of the cinematic sequence (`IntroAwakening`, `BossEntrance_Vaelen`).'
        },
        cameraType: {
          type: 'string',
          enum: ['2d', '3d'],
          description: 'Camera node type (`2d` or `3d`).'
        },
        durationSeconds: {
          type: 'number',
          description: 'Total duration of the cutscene in seconds (default 8.0).'
        },
        waypoints: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              time: { type: 'number' },
              pos_x: { type: 'number' },
              pos_y: { type: 'number' },
              pos_z: { type: 'number' },
              zoom: { type: 'number' }
            }
          },
          description: 'Camera position/zoom keyframes across the timeline.'
        },
        outputPath: {
          type: 'string',
          description: 'Optional path to save `.tscn` or `.gd` sequence file.'
        }
      },
      required: ['action', 'sequenceName']
    }
  },

  async execute(args) {
    try {
      const { action, sequenceName, cameraType = '2d', durationSeconds = 8.0, waypoints = [], outputPath } = args;

      if (action === 'create_cutscene') {
        const pts = waypoints.length > 0 ? waypoints : [
          { time: 0.0, pos_x: 0, pos_y: 0, zoom: 1.0 },
          { time: 3.0, pos_x: 250, pos_y: -100, zoom: 1.5 },
          { time: 6.0, pos_x: 500, pos_y: 0, zoom: 1.2 },
          { time: durationSeconds, pos_x: 0, pos_y: 0, zoom: 1.0 }
        ];

        const camNode = cameraType === '3d' ? 'Camera3D' : 'Camera2D';
        const posProperty = cameraType === '3d' ? 'position' : 'position';

        const keysPos = pts.map(p => `${p.time.toFixed(2)}: Vector2(${p.pos_x}, ${p.pos_y})`).join(', ');
        const keysZoom = pts.map(p => `${p.time.toFixed(2)}: Vector2(${p.zoom || 1.0}, ${p.zoom || 1.0})`).join(', ');

        const animContent = `[sub_resource type="Animation" id="Animation_cutscene"]
resource_name = "${sequenceName}"
length = ${durationSeconds.toFixed(2)}
tracks/0/type = "value"
tracks/0/imported = false
tracks/0/enabled = true
tracks/0/path = NodePath("CutsceneCamera:${posProperty}")
tracks/0/interp = 2
tracks/0/loop_wrap = true
tracks/0/keys = {
"times": PackedFloat32Array(${pts.map(p => p.time.toFixed(2)).join(', ')}),
"transitions": PackedFloat32Array(${pts.map(() => '1').join(', ')}),
"update": 0,
"values": [${pts.map(p => `Vector2(${p.pos_x}, ${p.pos_y})`).join(', ')}]
}
${cameraType === '2d' ? `tracks/1/type = "value"
tracks/1/imported = false
tracks/1/enabled = true
tracks/1/path = NodePath("CutsceneCamera:zoom")
tracks/1/interp = 2
tracks/1/loop_wrap = true
tracks/1/keys = {
"times": PackedFloat32Array(${pts.map(p => p.time.toFixed(2)).join(', ')}),
"transitions": PackedFloat32Array(${pts.map(() => '1').join(', ')}),
"update": 0,
"values": [${pts.map(p => `Vector2(${p.zoom || 1.0}, ${p.zoom || 1.0})`).join(', ')}]
}` : ''}
`;

        if (outputPath) {
          await fs.mkdir(path.dirname(outputPath), { recursive: true });
          await fs.writeFile(outputPath, animContent, 'utf8');
        }

        return {
          success: true,
          output: JSON.stringify({
            status: 'CREATED_CUTSCENE',
            sequence: sequenceName,
            camera_type: camNode,
            duration: durationSeconds,
            waypoints_count: pts.length,
            output_file: outputPath || 'Returned in payload',
            animation_snippet: animContent.slice(0, 1000)
          }, null, 2)
        };
      }

      if (action === 'generate_camera_shake') {
        const shakeScript = `extends ${cameraType === '3d' ? 'Camera3D' : 'Camera2D'}

# Reusable Screen Shake Controller
var shake_strength: float = 0.0
var shake_decay: float = 5.0

func apply_shake(strength: float = 15.0) -> void:
\tshake_strength = strength

func _process(delta: float) -> void:
\tif shake_strength > 0.1:
\t\tshake_strength = lerp(shake_strength, 0.0, shake_decay * delta)
\t\t${cameraType === '3d' ? `h_offset = randf_range(-shake_strength, shake_strength) * 0.01\n\t\tv_offset = randf_range(-shake_strength, shake_strength) * 0.01` : `offset = Vector2(randf_range(-shake_strength, shake_strength), randf_range(-shake_strength, shake_strength))`}
\telse:
\t\t${cameraType === '3d' ? `h_offset = 0.0\n\t\tv_offset = 0.0` : `offset = Vector2.ZERO`}
`;
        return {
          success: true,
          output: JSON.stringify({
            status: 'GENERATED_CAMERA_SHAKE',
            camera_type: cameraType,
            script_snippet: shakeScript
          }, null, 2)
        };
      }

      return { success: false, error: `Unknown action: ${action}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
