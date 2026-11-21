import fs from 'node:fs/promises';
import path from 'node:path';
import { getErrorMessage, type ToolWorkspaceContext } from './toolPathSafety.js';

export interface CinematicWaypoint {
  time?: number | undefined;
  pos_x?: number | undefined;
  pos_y?: number | undefined;
  pos_z?: number | undefined;
  zoom?: number | undefined;
}

export interface GameCinematicArgs {
  action?: string | undefined;
  sequenceName?: string | undefined;
  cameraType?: string | undefined;
  durationSeconds?: number | undefined;
  waypoints?: CinematicWaypoint[] | undefined;
  outputPath?: string | undefined;
}

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
        sequenceName: { type: 'string', description: 'Name of the cinematic sequence (`IntroAwakening`, `BossEntrance_Vaelen`).' },
        cameraType: { type: 'string', enum: ['2d', '3d'], description: 'Camera node type (`2d` or `3d`).' },
        durationSeconds: { type: 'number', description: 'Total duration of the cutscene in seconds (default 8.0).' },
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
        outputPath: { type: 'string', description: 'Optional path to save `.tscn` or `.gd` sequence file.' }
      },
      required: ['action', 'sequenceName']
    }
  },

  async execute(args: GameCinematicArgs = {}, _sandbox?: ToolWorkspaceContext): Promise<{ success: boolean; output?: string | undefined; error?: string | undefined }> {
    try {
      const { action, sequenceName = 'Cutscene', cameraType = '2d', durationSeconds = 8.0, waypoints = [], outputPath } = args || {};
      const safeDuration = Number.isFinite(Number(durationSeconds)) ? Math.max(0.1, Math.min(300, Number(durationSeconds))) : 8.0;

      if (action === 'create_cutscene') {
        const rawPts = Array.isArray(waypoints) && waypoints.length > 0 ? waypoints.slice(0, 128) : [
          { time: 0.0, pos_x: 0, pos_y: 0, pos_z: 0, zoom: 1.0 },
          { time: 3.0, pos_x: 250, pos_y: -100, pos_z: 0, zoom: 1.5 },
          { time: 6.0, pos_x: 500, pos_y: 0, pos_z: 0, zoom: 1.2 },
          { time: safeDuration, pos_x: 0, pos_y: 0, pos_z: 0, zoom: 1.0 }
        ];
        const pts = rawPts.map((p) => ({
          time: Number.isFinite(Number(p?.time)) ? Number(p?.time) : 0,
          pos_x: Number.isFinite(Number(p?.pos_x)) ? Number(p?.pos_x) : 0,
          pos_y: Number.isFinite(Number(p?.pos_y)) ? Number(p?.pos_y) : 0,
          pos_z: Number.isFinite(Number(p?.pos_z)) ? Number(p?.pos_z) : 0,
          zoom: Number.isFinite(Number(p?.zoom)) ? Number(p?.zoom) : 1.0
        }));

        const camNode = cameraType === '3d' ? 'Camera3D' : 'Camera2D';
        const posProperty = 'position';

        const animContent = `[sub_resource type="Animation" id="Animation_cutscene"]
resource_name = "${sequenceName}"
length = ${safeDuration.toFixed(2)}
tracks/0/type = "value"
tracks/0/imported = false
tracks/0/enabled = true
tracks/0/path = NodePath("CutsceneCamera:${posProperty}")
tracks/0/interp = 2
tracks/0/loop_wrap = true
tracks/0/keys = {
"times": PackedFloat32Array(${pts.map((p) => p.time.toFixed(2)).join(', ')}),
"transitions": PackedFloat32Array(${pts.map(() => '1').join(', ')}),
"update": 0,
"values": [${pts.map((p) => cameraType === '3d' ? `Vector3(${p.pos_x}, ${p.pos_y}, ${p.pos_z})` : `Vector2(${p.pos_x}, ${p.pos_y})`).join(', ')}]
}
${cameraType === '2d' ? `tracks/1/type = "value"
tracks/1/imported = false
tracks/1/enabled = true
tracks/1/path = NodePath("CutsceneCamera:zoom")
tracks/1/interp = 2
tracks/1/loop_wrap = true
tracks/1/keys = {
"times": PackedFloat32Array(${pts.map((p) => p.time.toFixed(2)).join(', ')}),
"transitions": PackedFloat32Array(${pts.map(() => '1').join(', ')}),
"update": 0,
"values": [${pts.map((p) => `Vector2(${p.zoom}, ${p.zoom})`).join(', ')}]
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
            duration: safeDuration,
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
\t\t${cameraType === '3d' ? 'h_offset = randf_range(-shake_strength, shake_strength) * 0.01\n\t\tv_offset = randf_range(-shake_strength, shake_strength) * 0.01' : 'offset = Vector2(randf_range(-shake_strength, shake_strength), randf_range(-shake_strength, shake_strength))'}
\telse:
\t\t${cameraType === '3d' ? 'h_offset = 0.0\n\t\tv_offset = 0.0' : 'offset = Vector2.ZERO'}
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

      return { success: false, error: `Unknown action: ${String(action ?? '')}` };
    } catch (e: unknown) {
      return { success: false, error: getErrorMessage(e) };
    }
  }
};
