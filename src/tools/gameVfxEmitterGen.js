import path from 'node:path';
import { assertSafeWorkspaceOutput, atomicWriteFileSafe, boundedFiniteNumber, boundedInteger, resolveToolWorkspaceRoots, safeSlugIdentifier, sanitizeToolError } from './toolPathSafety.js';
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
export const gameVfxEmitterGen = {
    schema: {
        name: 'game.vfx_emitter_gen',
        description: 'Generates procedural `GPUParticles2D/3D` particle systems (spells, fire, smoke, laser sparks, explosions, floating aura, dust) with custom `ParticleProcessMaterial` configurations and pre-baked sub-resources.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['generate_emitter', 'create_vfx_preset', 'save_vfx_scene'],
                    description: 'Action: generate_emitter (create GPUParticles node snippet), create_vfx_preset (get ParticleProcessMaterial data), or save_vfx_scene (write `.tscn` file).'
                },
                effectType: {
                    type: 'string',
                    enum: ['spell_sparkle', 'raging_fire', 'toxic_smoke', 'explosion_burst', 'laser_sparks', 'healing_aura', 'speed_lines'],
                    description: 'Preset visual effect type.'
                },
                emitterDimension: {
                    type: 'string',
                    enum: ['2d', '3d'],
                    description: 'Dimension (`2d` or `3d`).'
                },
                amount: { type: 'number', description: 'Number of emitted particles (default 64).' },
                lifetime: { type: 'number', description: 'Particle lifetime in seconds (default 1.2s).' },
                colorHex: { type: 'string', description: 'Base color hex (`#ff006e`, `#3a86ff`, `#fb5607`).' },
                outputPath: { type: 'string', description: 'Path to save `.tscn` file (`res://scenes/vfx/fire.tscn`).' }
            },
            required: ['action', 'effectType']
        }
    },
    async execute(args = {}, sandbox) {
        try {
            const { action, effectType = 'spell_sparkle', emitterDimension = '2d', amount = 64, lifetime = 1.2, colorHex = '#ff006e', outputPath } = args || {};
            const safeEffect = safeSlugIdentifier(effectType, 'spell_sparkle', 48);
            const safeAmount = boundedInteger(amount, 64, 1, 4096);
            const safeLifetime = boundedFiniteNumber(lifetime, 1.2, 0.05, 60.0);
            const safeColor = typeof colorHex === 'string' && HEX_COLOR_RE.test(colorHex.trim()) ? colorHex.trim() : '#ff006e';
            if (action === 'generate_emitter' || action === 'save_vfx_scene') {
                const nodeClass = emitterDimension === '3d' ? 'GPUParticles3D' : 'GPUParticles2D';
                const gravity = effectType === 'toxic_smoke' || effectType === 'healing_aura' ? 'Vector3(0, 98, 0)' : 'Vector3(0, -98, 0)';
                const explosiveness = effectType === 'explosion_burst' || effectType === 'laser_sparks' ? '0.85' : '0.1';
                const materialResource = `[sub_resource type="ParticleProcessMaterial" id="ParticleProcessMaterial_vfx"]
emission_shape = 1
emission_sphere_radius = ${effectType === 'healing_aura' ? '30.0' : '10.0'}
direction = Vector3(0, 1, 0)
spread = ${effectType === 'explosion_burst' ? '180.0' : '45.0'}
gravity = ${gravity}
initial_velocity_min = ${effectType === 'explosion_burst' ? '120.0' : '30.0'}
initial_velocity_max = ${effectType === 'explosion_burst' ? '250.0' : '80.0'}
scale_min = 2.0
scale_max = 6.0
color = Color("${safeColor}")
`;
                const sceneContent = `[gd_scene load_steps=2 format=3]

${materialResource}
[node name="VFX_${safeEffect}" type="${nodeClass}"]
amount = ${safeAmount}
lifetime = ${safeLifetime}
explosiveness = ${explosiveness}
process_material = SubResource("ParticleProcessMaterial_vfx")
`;
                if (outputPath || action === 'save_vfx_scene') {
                    const defaultRoot = resolveToolWorkspaceRoots(sandbox).primaryRoot || process.cwd();
                    const rawPath = outputPath || path.join(defaultRoot, '.tmp_causyne_3d', `vfx_${safeEffect}.tscn`);
                    const finalPath = await assertSafeWorkspaceOutput(rawPath, sandbox);
                    await atomicWriteFileSafe(finalPath, sceneContent);
                }
                return {
                    success: true,
                    output: JSON.stringify({
                        status: 'GENERATED_VFX_EMITTER',
                        effect_type: effectType,
                        dimension: emitterDimension,
                        amount,
                        lifetime,
                        output_file: outputPath || 'Returned in payload',
                        scene_snippet: sceneContent.slice(0, 800)
                    }, null, 2)
                };
            }
            if (action === 'create_vfx_preset') {
                return {
                    success: true,
                    output: JSON.stringify({
                        preset: effectType,
                        dimension: emitterDimension,
                        material_properties: {
                            spread: effectType === 'explosion_burst' ? 180 : 45,
                            gravity: effectType === 'toxic_smoke' ? [0, 98, 0] : [0, -98, 0],
                            initial_velocity: [30, 150]
                        }
                    }, null, 2)
                };
            }
            return { success: false, error: `Unknown action: ${String(action ?? '')}` };
        }
        catch (e) {
            return { success: false, error: sanitizeToolError(e) };
        }
    }
};
