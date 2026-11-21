import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { assertSafeWorkspaceOutput, atomicWriteFileSafe, resolveScopedPath, safeSlugIdentifier, sanitizeToolError, stripDangerousKeysDeep } from './toolPathSafety.js';
const MAX_LORE_BYTES = 4 * 1024 * 1024;
export const gameLoreForge = {
    schema: {
        name: 'game.lore_forge',
        description: 'Generates structured worldbuilding lore, faction histories, biome backstories, and character biographies for RPGs and rich game worlds. Can save directly to project `data/world_lore.json` or return formatted JSON.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['generate_world_lore', 'generate_character_bio', 'generate_faction', 'save_lore_to_project'],
                    description: 'Action: generate_world_lore (overall setting/history), generate_character_bio (deep NPC/hero backstory), generate_faction (politics/ideology), or save_lore_to_project (persist to JSON).'
                },
                title: { type: 'string', description: 'Title of the world, character, or faction.' },
                genre: { type: 'string', enum: ['medieval_fantasy', 'dark_fantasy', 'cyberpunk', 'sci_fi', 'post_apocalyptic', 'steampunk'], description: 'Genre and tone of the lore.' },
                keyElements: { type: 'array', items: { type: 'string' }, description: 'List of key plot devices, relics, biomes, or character traits.' },
                projectDir: { type: 'string', description: 'Optional absolute path to Godot/game project directory to save generated lore.' },
                customLoreData: { type: 'object', description: 'Structured JSON payload to save when action is `save_lore_to_project`.' }
            },
            required: ['action', 'title']
        }
    },
    async execute(args = {}, sandbox) {
        try {
            const { action, title = 'Untitled', genre = 'medieval_fantasy', keyElements = [], projectDir, customLoreData } = args || {};
            const safeTitle = String(title ?? 'Untitled');
            const safeElements = Array.isArray(keyElements) ? keyElements.map(String) : [];
            const titleSlug = safeSlugIdentifier(safeTitle.toLowerCase(), 'untitled', 64);
            if (action === 'save_lore_to_project') {
                const scopedDir = projectDir ? resolveScopedPath(projectDir, sandbox) : '';
                if (!scopedDir || !fsSync.existsSync(scopedDir)) {
                    return { success: false, error: `Valid projectDir is required to save lore. Found: ${String(projectDir ?? '')}` };
                }
                const filePath = await assertSafeWorkspaceOutput(path.join(scopedDir, 'data', `${titleSlug}_lore.json`), sandbox, { scopeRoot: scopedDir });
                const cleanLore = customLoreData ? stripDangerousKeysDeep(customLoreData) : { title: safeTitle, genre, timestamp: Date.now() };
                const body = JSON.stringify(cleanLore, null, 2);
                if (Buffer.byteLength(body, 'utf8') > MAX_LORE_BYTES) {
                    return { success: false, error: `customLoreData exceeds maximum size of ${MAX_LORE_BYTES} bytes.` };
                }
                await atomicWriteFileSafe(filePath, body);
                const stat = await fs.stat(filePath);
                return {
                    success: true,
                    output: JSON.stringify({
                        status: 'SAVED_LORE',
                        file_path: filePath,
                        data_size_bytes: stat.size
                    }, null, 2)
                };
            }
            if (action === 'generate_world_lore') {
                const loreTemplate = {
                    world_title: safeTitle,
                    genre,
                    creation_myth: `In the dawn of ${safeTitle}, the primeval forces shaped the continents from ethereal mist and primordial iron. The balance was broken when the ancient relics shattered across the realms.`,
                    core_conflict: safeElements.length > 0 ? `The struggle over ${safeElements.join(', ')} has plunged the kingdoms into perpetual unrest.` : 'An ancient darkness stirs beneath the forgotten sanctuaries, threatening to consume all light.',
                    biomes: [
                        { name: 'Whispering Village', atmosphere: 'Misty, ancient oak groves, rustic thatched taverns under constant twilight.' },
                        { name: 'Forgotten Catacombs', atmosphere: 'Subterranean stone labyrinths guarded by skeletal sentinels and shadow wards.' },
                        { name: 'Shadow Sanctuary', atmosphere: 'Obsidian spires pulsing with void energy and arcane glyphs.' }
                    ],
                    historical_eras: [
                        { era: 'Age of Dawn', description: 'The golden peace where mortals and celestials walked together.' },
                        { era: 'The Great Sundering', description: 'The catastrophic war that buried the Shadow Relic deep beneath the earth.' },
                        { era: 'Age of Shadows (Current)', description: 'A tense era of declining magic and rising necromancy.' }
                    ]
                };
                if (projectDir) {
                    const scopedDir = resolveScopedPath(projectDir, sandbox);
                    if (fsSync.existsSync(scopedDir)) {
                        const target = await assertSafeWorkspaceOutput(path.join(scopedDir, 'data', 'world_lore.json'), sandbox, { scopeRoot: scopedDir });
                        await atomicWriteFileSafe(target, JSON.stringify(loreTemplate, null, 2));
                    }
                }
                return { success: true, output: JSON.stringify(loreTemplate, null, 2) };
            }
            if (action === 'generate_character_bio') {
                const bioTemplate = {
                    character_name: safeTitle,
                    genre,
                    archetype: safeElements[0] || 'Vengeful Exile',
                    background: `${safeTitle} was once a revered figure in the high court before being cast out due to the conspiracy surrounding ${safeElements.join(' and ') || 'the forbidden shadow arts'}.`,
                    personality_traits: ['Stoic', 'Tactical', 'Haunted by past vows'],
                    combat_style: 'Twin-blade high-velocity strikes combined with shadow displacement spells.',
                    motivations: {
                        primary: 'Reclaim the Shadow Relic and clear their fallen lineage.',
                        secret: 'Prevent the awakening of the Void Sovereign locked within their own soul.'
                    }
                };
                if (projectDir) {
                    const scopedDir = resolveScopedPath(projectDir, sandbox);
                    if (fsSync.existsSync(scopedDir)) {
                        const target = await assertSafeWorkspaceOutput(path.join(scopedDir, 'data', `char_${titleSlug}.json`), sandbox, { scopeRoot: scopedDir });
                        await atomicWriteFileSafe(target, JSON.stringify(bioTemplate, null, 2));
                    }
                }
                return { success: true, output: JSON.stringify(bioTemplate, null, 2) };
            }
            if (action === 'generate_faction') {
                const factionTemplate = {
                    faction_name: safeTitle,
                    genre,
                    ideology: 'Preservation through absolute control of arcane artifacts.',
                    headquarters: 'The Obsidian Citadel of Aetheria',
                    key_figures: ['Grand Master Kaelen', 'High Inquisitor Vex'],
                    relations: {
                        player_hero: 'Suspicious / Hostile until loyalty is proven.',
                        shadow_syndicate: 'Mortal enemies locked in clandestine shadow wars.'
                    },
                    resources: ['Shadow Shards', 'Enchanted Steel', 'Ancient Grimoires']
                };
                if (projectDir) {
                    const scopedDir = resolveScopedPath(projectDir, sandbox);
                    if (fsSync.existsSync(scopedDir)) {
                        const target = await assertSafeWorkspaceOutput(path.join(scopedDir, 'data', `faction_${titleSlug}.json`), sandbox, { scopeRoot: scopedDir });
                        await atomicWriteFileSafe(target, JSON.stringify(factionTemplate, null, 2));
                    }
                }
                return { success: true, output: JSON.stringify(factionTemplate, null, 2) };
            }
            return { success: false, error: `Unknown action: ${String(action ?? '')}` };
        }
        catch (e) {
            return { success: false, error: sanitizeToolError(e) };
        }
    }
};
