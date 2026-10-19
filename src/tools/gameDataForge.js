import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

export const gameDataForge = {
  schema: {
    name: 'game.data_forge',
    description: 'Generates and validates structured game data databases (`item_catalog.json`, `enemy_database.json`, `crafting_recipes.json`) for Godot 4.x or web games. Can generate 40+ rich RPG items with stats, rarities, and descriptions.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['generate_item_catalog', 'generate_crafting_recipes', 'validate_json_db', 'save_data_forge'],
          description: 'Action: generate_item_catalog (create 40+ RPG items), generate_crafting_recipes (blacksmith/alchemy tables), validate_json_db (schema verification), or save_data_forge (write JSON files to disk).'
        },
        itemCount: { type: 'number', description: 'Number of items to generate (default 40).' },
        gameGenre: { type: 'string', enum: ['medieval_rpg', 'cyberpunk_racing'], description: 'Genre rule set.' },
        projectDir: { type: 'string', description: 'Absolute path to Godot project directory (`data/`).' },
        customJsonData: { type: 'object', description: 'Custom JSON payload when saving directly.' },
        targetFilename: { type: 'string', description: 'Target filename inside data folder (e.g. `item_catalog.json`).' }
      },
      required: ['action']
    }
  },

  async execute(args) {
    try {
      const { action, itemCount = 40, gameGenre = 'medieval_rpg', projectDir, customJsonData, targetFilename = 'item_catalog.json' } = args;

      if (action === 'generate_item_catalog') {
        const rarities = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];
        const types = ['Weapon', 'Armor', 'Consumable', 'Relic', 'Material'];
        const items = [];

        // Core story items
        items.push(
          { id: 'relic_shadow', name: 'The Shadow Relic', type: 'Relic', rarity: 'Legendary', value: 5000, desc: 'Primordial obsidian shard humming with void energy.' },
          { id: 'silver_key', name: 'Silver Key of Sanctuary', type: 'Relic', rarity: 'Epic', value: 1200, desc: 'Opens the inner wards of the Forgotten Catacombs.' },
          { id: 'health_potion_minor', name: 'Minor Crimson Vial', type: 'Consumable', rarity: 'Common', value: 25, heal_amount: 50, desc: 'Restores 50 health points instantly.' },
          { id: 'sword_iron_blade', name: 'Forged Iron Broadsword', type: 'Weapon', rarity: 'Common', value: 150, attack_damage: 25, desc: 'Standard issue village guard blade.' },
          { id: 'armor_shadow_plate', name: 'Abyssal Steel Chestplate', type: 'Armor', rarity: 'Epic', value: 2400, defense: 65, desc: 'Absorbs 15% of incoming shadow magic damage.' }
        );

        // Procedurally generate remaining up to itemCount
        const prefixes = ['Ancient', 'Shattered', 'Ethereal', 'Cursed', 'Celestial', 'Enchanted', 'Obsidian', 'Gilded'];
        const nouns = ['Dagger', 'Longsword', 'Battleaxe', 'Grimoire', 'Gauntlets', 'Talisman', 'Elixir', 'Signet Ring', 'Shield', 'Greatsword'];

        let idx = items.length + 1;
        while (items.length < itemCount) {
          const pref = prefixes[idx % prefixes.length];
          const noun = nouns[idx % nouns.length];
          const r = rarities[Math.min(rarities.length - 1, Math.floor(Math.random() * rarities.length))];
          const t = nouns.slice(0, 3).includes(noun) || noun === 'Greatsword' ? 'Weapon' : (nouns.includes('Gauntlets') || noun === 'Shield' ? 'Armor' : 'Relic');

          items.push({
            id: `item_${idx}_${pref.toLowerCase()}_${noun.toLowerCase()}`,
            name: `${pref} ${noun}`,
            type: t,
            rarity: r,
            value: idx * 45,
            attack_damage: t === 'Weapon' ? 20 + idx * 3 : 0,
            defense: t === 'Armor' ? 15 + idx * 2 : 0,
            desc: `An ancient artifact from the Age of ${pref.slice(0, 4)}. Holds immense historical value.`
          });
          idx++;
        }

        if (projectDir && fsSync.existsSync(projectDir)) {
          const dataDir = path.join(projectDir, 'data');
          await fs.mkdir(dataDir, { recursive: true });
          await fs.writeFile(path.join(dataDir, 'item_catalog.json'), JSON.stringify({ items }, null, 2), 'utf8');
        }

        return {
          success: true,
          output: JSON.stringify({
            status: 'GENERATED_ITEM_CATALOG',
            genre: gameGenre,
            total_items: items.length,
            sample_items: items.slice(0, 5)
          }, null, 2)
        };
      }

      if (action === 'generate_crafting_recipes') {
        const recipes = [
          { recipe_id: 'craft_silver_key', output_item: 'silver_key', required_materials: [{ item: 'shadow_shard', qty: 5 }, { item: 'iron_ingot', qty: 2 }], gold_cost: 100 },
          { recipe_id: 'craft_health_potion', output_item: 'health_potion_minor', required_materials: [{ item: 'red_herb', qty: 2 }, { item: 'empty_vial', qty: 1 }], gold_cost: 10 },
          { recipe_id: 'craft_shadow_plate', output_item: 'armor_shadow_plate', required_materials: [{ item: 'abyssal_steel', qty: 4 }, { item: 'shadow_shard', qty: 10 }], gold_cost: 850 }
        ];

        if (projectDir && fsSync.existsSync(projectDir)) {
          const dataDir = path.join(projectDir, 'data');
          await fs.mkdir(dataDir, { recursive: true });
          await fs.writeFile(path.join(dataDir, 'crafting_recipes.json'), JSON.stringify({ recipes }, null, 2), 'utf8');
        }

        return {
          success: true,
          output: JSON.stringify({ status: 'GENERATED_CRAFTING_RECIPES', recipes_count: recipes.length, recipes }, null, 2)
        };
      }

      if (action === 'save_data_forge') {
        if (!projectDir || !fsSync.existsSync(projectDir)) {
          return { success: false, error: `projectDir is required to save data.` };
        }
        const dataDir = path.join(projectDir, 'data');
        await fs.mkdir(dataDir, { recursive: true });
        const filePath = path.join(dataDir, targetFilename);
        await fs.writeFile(filePath, JSON.stringify(customJsonData || { status: 'empty' }, null, 2), 'utf8');
        return {
          success: true,
          output: JSON.stringify({ status: 'SAVED_DATA_FORGE', file_path: filePath }, null, 2)
        };
      }

      return { success: false, error: `Unknown action: ${action}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
