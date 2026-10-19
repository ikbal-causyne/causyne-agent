import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

export const gameShaderForge = {
  schema: {
    name: 'game.shader_forge',
    description: 'Generates custom visual shaders (`.gdshader`) for Godot 4.x canvas items (2D) and spatial meshes (3D). Includes presets for water ripple, hit damage flash, holographic cyberpunk distortion, magical dissolve/teleport, and high-speed highway blur.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['generate_shader', 'list_presets', 'save_shader'],
          description: 'Action: generate_shader (create gdshader code snippet), list_presets (show available visual shaders), or save_shader (write `.gdshader` file).'
        },
        preset: {
          type: 'string',
          enum: ['water_ripple_2d', 'hit_flash_2d', 'hologram_3d', 'dissolve_burn_3d', 'speed_blur_canvas'],
          description: 'Visual shader preset to generate.'
        },
        shaderType: {
          type: 'string',
          enum: ['canvas_item', 'spatial'],
          description: 'Godot shader type header (`canvas_item` for 2D/UI, `spatial` for 3D meshes).'
        },
        customParameters: {
          type: 'object',
          properties: {
            speed: { type: 'number' },
            strength: { type: 'number' },
            colorHex: { type: 'string' }
          },
          description: 'Uniform tweaks (speed, strength, primary color).'
        },
        outputPath: {
          type: 'string',
          description: 'Absolute or `res://` path to save `.gdshader` file (`res://shaders/hit_flash.gdshader`).'
        }
      },
      required: ['action']
    }
  },

  async execute(args) {
    try {
      const { action, preset = 'hit_flash_2d', shaderType = 'canvas_item', customParameters = {}, outputPath } = args;

      if (action === 'list_presets') {
        return {
          success: true,
          output: JSON.stringify({
            status: 'SHADER_PRESETS',
            presets: [
              { name: 'water_ripple_2d', type: 'canvas_item', desc: 'Dynamic wave distortion and reflective shimmer for rivers and lakes.' },
              { name: 'hit_flash_2d', type: 'canvas_item', desc: 'Instant solid white/red color override when character takes damage.' },
              { name: 'hologram_3d', type: 'spatial', desc: 'Cyberpunk scanline transparency with chromatic aberration and glow.' },
              { name: 'dissolve_burn_3d', type: 'spatial', desc: 'Noise-driven disintegration with glowing ember edges for teleportation or death.' },
              { name: 'speed_blur_canvas', type: 'canvas_item', desc: 'Radial speed distortion lines for cyberpunk highway racers.' }
            ]
          }, null, 2)
        };
      }

      if (action === 'generate_shader' || action === 'save_shader') {
        let code = '';
        const speed = customParameters.speed || 1.0;
        const strength = customParameters.strength || 0.5;
        const color = customParameters.colorHex || '#ffffff';

        if (preset === 'hit_flash_2d') {
          code = `shader_type canvas_item;

// Sovereign Hit Damage Flash Shader
uniform bool flash_active = false;
uniform vec4 flash_color : source_color = vec4(1.0, 1.0, 1.0, 1.0);

void fragment() {
\tvec4 tex_color = texture(TEXTURE, UV);
\tif (flash_active && tex_color.a > 0.0) {
\t\tCOLOR = mix(tex_color, flash_color, ${strength.toFixed(2)});
\t} else {
\t\tCOLOR = tex_color;
\t}
}
`;
        } else if (preset === 'water_ripple_2d') {
          code = `shader_type canvas_item;

// Sovereign Water Ripple & Shimmer Shader
uniform float wave_speed = ${speed.toFixed(2)};
uniform float wave_frequency = 15.0;
uniform float wave_amplitude = 0.015;

void fragment() {
\tvec2 uv = UV;
\tuv.y += sin(uv.x * wave_frequency + TIME * wave_speed) * wave_amplitude;
\tuv.x += cos(uv.y * wave_frequency + TIME * wave_speed) * wave_amplitude;
\tCOLOR = texture(TEXTURE, uv);
}
`;
        } else if (preset === 'hologram_3d') {
          code = `shader_type spatial;
render_mode blend_add, unshaded, cull_disabled;

// Sovereign Cyberpunk Hologram Shader
uniform vec4 holo_color : source_color = vec4(0.0, 0.8, 1.0, 0.7);
uniform float scanline_speed = ${speed.toFixed(2)} * 3.0;
uniform float scanline_frequency = 50.0;

void fragment() {
\tfloat scanline = sin(UV.y * scanline_frequency + TIME * scanline_speed) * 0.5 + 0.5;
\tfloat alpha = holo_color.a * (0.4 + 0.6 * scanline);
\tALBEDO = holo_color.rgb;
\tALPHA = alpha;
}
`;
        } else if (preset === 'dissolve_burn_3d') {
          code = `shader_type spatial;
render_mode depth_draw_opaque;

// Sovereign Magical Dissolve & Ember Burn Shader
uniform float progress : hint_range(0.0, 1.0) = 0.0;
uniform vec4 burn_color : source_color = vec4(1.0, 0.3, 0.0, 1.0);
uniform float burn_width = 0.05;
uniform sampler2D noise_texture;

void fragment() {
\tfloat noise_val = texture(noise_texture, UV * 3.0).r;
\tif (noise_val < progress) {
\t\tdiscard;
\t}
\tif (noise_val < progress + burn_width) {
\t\tALBEDO = burn_color.rgb * 3.0;
\t\tEMISSION = burn_color.rgb * 5.0;
\t}
}
`;
        } else {
          // speed_blur_canvas
          code = `shader_type canvas_item;

// Sovereign Cyberpunk Highway Speed Blur
uniform float blur_strength = ${strength.toFixed(2)};
uniform vec2 blur_center = vec2(0.5, 0.5);

void fragment() {
\tvec2 dir = UV - blur_center;
\tvec4 sum = vec4(0.0);
\tfor (int i = 0; i < 8; i++) {
\t\tsum += texture(TEXTURE, UV - dir * blur_strength * float(i) * 0.01);
\t}
\tCOLOR = sum / 8.0;
}
`;
        }

        if (outputPath || action === 'save_shader') {
          const finalPath = outputPath || path.join(process.cwd(), '.tmp_causyne_3d', `shader_${preset}.gdshader`);
          await fs.mkdir(path.dirname(finalPath), { recursive: true });
          await fs.writeFile(finalPath, code, 'utf8');
        }

        return {
          success: true,
          output: JSON.stringify({
            status: 'GENERATED_GDSHADER',
            preset: preset,
            shader_type: shaderType,
            output_file: outputPath || 'Returned in payload',
            code_snippet: code.slice(0, 800)
          }, null, 2)
        };
      }

      return { success: false, error: `Unknown action: ${action}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
