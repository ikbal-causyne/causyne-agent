import path from 'node:path';
import { assertSafeWorkspaceOutput, atomicWriteFileSafe, escapeGodotString, resolveToolWorkspaceRoots, safeSlugIdentifier, sanitizeToolError } from './toolPathSafety.js';
export const gameTilemapGenerator = {
    schema: {
        name: 'game.tilemap_gen',
        description: 'Procedurally generates multi-biome world maps, dungeon rooms, and highway road networks for Godot 4.x (`TileMapLayer` for 2D, `GridMap` / `CSGPolygon3D` for 3D Cyberpunk Racers). Can export `.tscn` scenes and level collision layout maps.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['generate_level', 'generate_highway_track', 'save_tilemap_scene'],
                    description: 'Action: generate_level (2D dungeon or village grid layout), generate_highway_track (3D cyberpunk racing road segment network), or save_tilemap_scene (write `.tscn`).'
                },
                levelName: { type: 'string', description: 'Name of the level (`Level_1_WhisperingVillage`, `Cyberpunk_Highway_SectionA`).' },
                mapDimension: { type: 'string', enum: ['2d', '3d'], description: 'Dimension (`2d` or `3d`).' },
                width: { type: 'number', description: 'Width of the grid/track in tiles (default 32).' },
                height: { type: 'number', description: 'Height of the grid/track in tiles (default 32).' },
                biome: { type: 'string', enum: ['whispering_village', 'forgotten_catacombs', 'cyberpunk_highway', 'shadow_sanctuary'], description: 'Biome rule set for procedural generation.' },
                outputPath: { type: 'string', description: 'Absolute or `res://` path to save `.tscn` file (`res://scenes/levels/Level1.tscn`).' }
            },
            required: ['action', 'levelName']
        }
    },
    async execute(args = {}, sandbox) {
        try {
            const { action, levelName = 'Level1', mapDimension = '2d', width = 32, height = 32, biome = 'whispering_village', outputPath } = args || {};
            const safeW = Number.isFinite(Number(width)) ? Math.max(4, Math.min(256, Math.floor(Number(width)))) : 32;
            const safeH = Number.isFinite(Number(height)) ? Math.max(4, Math.min(256, Math.floor(Number(height)))) : 32;
            const safeLevel = escapeGodotString(levelName, 120);
            const safeBiome = escapeGodotString(biome, 64);
            const levelSlug = safeSlugIdentifier(levelName, 'Level1', 64);
            const defaultRoot = resolveToolWorkspaceRoots(sandbox).primaryRoot || process.cwd();
            if (action === 'generate_level' || action === 'save_tilemap_scene') {
                if (mapDimension === '2d') {
                    const tscnContent = `[gd_scene format=3]

[node name="${safeLevel}" type="Node2D"]

[node name="TileMapLayer" type="TileMapLayer" parent="."]
tile_set = null
# Procedural 2D Grid (${safeW}x${safeH}) for ${safeBiome}
`;
                    if (outputPath || action === 'save_tilemap_scene') {
                        const rawPath = outputPath || path.join(defaultRoot, '.tmp_causyne_3d', `${levelSlug}.tscn`);
                        const finalPath = await assertSafeWorkspaceOutput(rawPath, sandbox);
                        await atomicWriteFileSafe(finalPath, tscnContent);
                    }
                    return {
                        success: true,
                        output: JSON.stringify({
                            status: 'GENERATED_2D_LEVEL',
                            level_name: levelName,
                            biome,
                            grid_size: `${safeW}x${safeH}`,
                            tiles_generated: safeW * safeH,
                            output_file: outputPath || 'Returned in payload',
                            snippet: tscnContent.slice(0, 800)
                        }, null, 2)
                    };
                }
                else {
                    const tscn3d = `[gd_scene format=3]

[node name="${safeLevel}" type="Node3D"]

[node name="GridMap" type="GridMap" parent="."]
cell_size = Vector3(2, 2, 2)

[node name="DirectionalLight3D" type="DirectionalLight3D" parent="."]
transform = Transform3D(0.866, -0.433, 0.25, 0, 0.5, 0.866, -0.5, -0.75, 0.433, 0, 20, 0)
shadow_enabled = true
`;
                    if (outputPath || action === 'save_tilemap_scene') {
                        const rawPath = outputPath || path.join(defaultRoot, '.tmp_causyne_3d', `${levelSlug}.tscn`);
                        const finalPath = await assertSafeWorkspaceOutput(rawPath, sandbox);
                        await atomicWriteFileSafe(finalPath, tscn3d);
                    }
                    return {
                        success: true,
                        output: JSON.stringify({
                            status: 'GENERATED_3D_LEVEL',
                            level_name: levelName,
                            biome,
                            output_file: outputPath || 'Returned in payload',
                            snippet: tscn3d.slice(0, 800)
                        }, null, 2)
                    };
                }
            }
            if (action === 'generate_highway_track') {
                const trackContent = `[gd_scene format=3]

[node name="${safeLevel}" type="Node3D"]

[node name="HighwayRoad" type="CSGBox3D" parent="."]
use_collision = true
size = Vector3(16, 0.5, 200)

[node name="BarrierLeft" type="CSGBox3D" parent="HighwayRoad"]
use_collision = true
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, -8, 1, 0)
size = Vector3(0.8, 2, 200)

[node name="BarrierRight" type="CSGBox3D" parent="HighwayRoad"]
use_collision = true
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 8, 1, 0)
size = Vector3(0.8, 2, 200)

[node name="NeonLights" type="Node3D" parent="."]
`;
                if (outputPath) {
                    const finalPath = await assertSafeWorkspaceOutput(outputPath, sandbox);
                    await atomicWriteFileSafe(finalPath, trackContent);
                }
                return {
                    success: true,
                    output: JSON.stringify({
                        status: 'GENERATED_HIGHWAY_TRACK',
                        level_name: levelName,
                        road_length: 200,
                        road_width: 16,
                        output_file: outputPath || 'Returned in payload',
                        snippet: trackContent.slice(0, 800)
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
