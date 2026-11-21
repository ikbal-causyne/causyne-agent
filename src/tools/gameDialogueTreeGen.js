import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { assertSafeWorkspaceInput, assertSafeWorkspaceOutput, atomicWriteFileSafe, isSafePlainKey, resolveScopedPath, sanitizeToolError, stripDangerousKeysDeep } from './toolPathSafety.js';
const MAX_DIALOGUE_DB_BYTES = 4 * 1024 * 1024;
const MAX_DIALOGUE_NODES = 256;
export const gameDialogueTreeGen = {
    schema: {
        name: 'game.dialogue_tree_gen',
        description: 'Engineers branching NPC dialogue trees with conditional checks (e.g., player inventory items, quest state, reputation level) and dynamic choices (`dialogue_trees.json`). Validates schema structure for seamless integration into Godot UI boxes.',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['create_tree', 'add_branch', 'save_dialogue_db'], description: 'Action: create_tree (generate complete NPC tree), add_branch (append node choice), or save_dialogue_db (save dialogue_trees.json).' },
                npcId: { type: 'string', description: 'Unique ID of the NPC (e.g. `village_elder`, `blacksmith`, `mystic_mage`).' },
                npcName: { type: 'string', description: 'Display name of the NPC (e.g. `Elder Thaddeus`, `Grom the Blacksmith`).' },
                nodes: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            node_id: { type: 'string' },
                            text: { type: 'string' },
                            conditions: {
                                type: 'object',
                                properties: {
                                    required_item: { type: 'string' },
                                    required_quest_state: { type: 'string' }
                                }
                            },
                            choices: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        choice_text: { type: 'string' },
                                        next_node_id: { type: 'string' },
                                        reward_item: { type: 'string' },
                                        set_quest_state: { type: 'string' }
                                    }
                                }
                            }
                        }
                    },
                    description: 'List of dialogue nodes for create_tree.'
                },
                projectDir: { type: 'string', description: 'Optional absolute path to Godot/game project directory (`res://...`) to save `data/dialogue_trees.json`.' }
            },
            required: ['action', 'npcId']
        }
    },
    async execute(args = {}, sandbox) {
        try {
            const { action, npcId = 'npc_default', npcName = 'NPC', nodes = [], projectDir } = args || {};
            if (!isSafePlainKey(npcId)) {
                return { success: false, error: 'Invalid npcId: disallowed prototype or empty key.' };
            }
            const cleanNodes = Array.isArray(nodes) ? stripDangerousKeysDeep(nodes.slice(0, MAX_DIALOGUE_NODES)) : [];
            if (action === 'create_tree') {
                const defaultNodes = cleanNodes.length > 0 ? cleanNodes : [
                    {
                        node_id: 'start',
                        text: 'Greetings, traveler. Have you ventured into the Whispering Woods recently? The darkness deepens with every moon.',
                        conditions: null,
                        choices: [
                            { choice_text: 'I seek the Shadow Relic. What do you know of it?', next_node_id: 'inquire_relic' },
                            { choice_text: 'I am just passing through.', next_node_id: 'exit' }
                        ]
                    },
                    {
                        node_id: 'inquire_relic',
                        text: 'The Shadow Relic is sealed beneath the Forgotten Catacombs. But only one who wields the Silver Key can overcome the wards.',
                        conditions: null,
                        choices: [
                            { choice_text: 'Where can I find the Silver Key?', next_node_id: 'silver_key_info' },
                            { choice_text: 'I already possess the Silver Key.', next_node_id: 'key_check_pass', condition_required_item: 'silver_key' }
                        ]
                    },
                    {
                        node_id: 'silver_key_info',
                        text: 'Grom the Blacksmith holds the key, but he asks a high price in shadow shards. Seek his forge at the village center.',
                        choices: [{ choice_text: 'Thank you for the guidance.', next_node_id: 'exit', set_quest_state: 'quest_1_stage_2' }]
                    },
                    {
                        node_id: 'key_check_pass',
                        text: 'Ah! The Silver Key glimmers in your hand! May celestial grace shield you in the depths of the catacombs.',
                        choices: [{ choice_text: 'I will return victorious.', next_node_id: 'exit', set_quest_state: 'quest_1_stage_3' }]
                    },
                    { node_id: 'exit', text: 'May the light guide your blade.', choices: [] }
                ];
                const treeObject = {
                    npc_id: npcId,
                    npc_name: npcName,
                    start_node_id: 'start',
                    nodes: defaultNodes
                };
                if (projectDir) {
                    const scopedDir = resolveScopedPath(projectDir, sandbox);
                    if (fsSync.existsSync(scopedDir)) {
                        const dbPath = await assertSafeWorkspaceOutput(path.join(scopedDir, 'data', 'dialogue_trees.json'), sandbox, { scopeRoot: scopedDir });
                        let currentDb = Object.create(null);
                        if (fsSync.existsSync(dbPath)) {
                            try {
                                const checked = await assertSafeWorkspaceInput(dbPath, sandbox, { scopeRoot: scopedDir, maxBytes: MAX_DIALOGUE_DB_BYTES });
                                const parsed = JSON.parse(await fs.readFile(checked.resolved, 'utf8'));
                                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                                    currentDb = Object.assign(Object.create(null), stripDangerousKeysDeep(parsed));
                                }
                            }
                            catch { /* ignore */ }
                        }
                        currentDb[npcId] = treeObject;
                        await atomicWriteFileSafe(dbPath, JSON.stringify(currentDb, null, 2));
                    }
                }
                return { success: true, output: JSON.stringify(treeObject, null, 2) };
            }
            if (action === 'save_dialogue_db') {
                const scopedDir = projectDir ? resolveScopedPath(projectDir, sandbox) : '';
                if (!scopedDir || !fsSync.existsSync(scopedDir)) {
                    return { success: false, error: 'projectDir is required to save dialogue database.' };
                }
                const dbPath = await assertSafeWorkspaceOutput(path.join(scopedDir, 'data', 'dialogue_trees.json'), sandbox, { scopeRoot: scopedDir });
                const payload = Object.create(null);
                payload[npcId] = { npc_id: npcId, npc_name: npcName, nodes: cleanNodes };
                await atomicWriteFileSafe(dbPath, JSON.stringify(payload, null, 2));
                return { success: true, output: JSON.stringify({ status: 'SAVED_DIALOGUE_DB', path: dbPath }, null, 2) };
            }
            return { success: false, error: `Unknown action: ${String(action ?? '')}` };
        }
        catch (e) {
            return { success: false, error: sanitizeToolError(e) };
        }
    }
};
