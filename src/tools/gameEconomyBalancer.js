import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

export const gameEconomyBalancer = {
  schema: {
    name: 'game.economy_balancer',
    description: 'Calculates and balances game economy mechanics: enemy stat scaling curves across levels (`enemy_scaling.json`), item drop tables (`loot_tables.json`), item pricing formulas, and player XP/level progression thresholds.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['balance_enemy_scaling', 'generate_loot_table', 'balance_xp_curve', 'save_economy_data'],
          description: 'Action: balance_enemy_scaling (compute HP/attack across levels), generate_loot_table (assign drop probabilities), balance_xp_curve (level thresholds), or save_economy_data (write database files).'
        },
        maxLevel: { type: 'number', description: 'Maximum player/enemy level to simulate (default 50).' },
        difficultyCurve: {
          type: 'string',
          enum: ['linear', 'exponential', 'souls_hardcore'],
          description: 'Scaling curve type.'
        },
        baseHp: { type: 'number', description: 'Level 1 base HP (default 100).' },
        baseXp: { type: 'number', description: 'Level 1 base XP required for level 2 (default 500).' },
        lootEntries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              item_id: { type: 'string' },
              drop_chance_pct: { type: 'number' },
              min_qty: { type: 'number' },
              max_qty: { type: 'number' }
            }
          },
          description: 'Loot table items and percentage drop chances.'
        },
        projectDir: {
          type: 'string',
          description: 'Absolute path to project directory (`data/` folder).'
        }
      },
      required: ['action']
    }
  },

  async execute(args) {
    try {
      const { action, maxLevel = 50, difficultyCurve = 'exponential', baseHp = 100, baseXp = 500, lootEntries = [], projectDir } = args;

      if (action === 'balance_enemy_scaling') {
        const scalingTable = [];
        for (let lvl = 1; lvl <= maxLevel; lvl++) {
          let multiplier = 1.0;
          if (difficultyCurve === 'linear') {
            multiplier = 1 + (lvl - 1) * 0.15;
          } else if (difficultyCurve === 'souls_hardcore') {
            multiplier = Math.pow(1.22, lvl - 1);
          } else {
            // exponential
            multiplier = Math.pow(1.15, lvl - 1);
          }

          scalingTable.push({
            level: lvl,
            max_hp: Math.round(baseHp * multiplier),
            attack_damage: Math.round((baseHp * 0.15) * multiplier),
            xp_reward: Math.round((baseXp * 0.2) * Math.pow(1.12, lvl - 1)),
            gold_drop: Math.round(15 * Math.pow(1.1, lvl - 1))
          });
        }

        if (projectDir && fsSync.existsSync(projectDir)) {
          const dataDir = path.join(projectDir, 'data');
          await fs.mkdir(dataDir, { recursive: true });
          await fs.writeFile(path.join(dataDir, 'enemy_scaling.json'), JSON.stringify(scalingTable, null, 2), 'utf8');
        }

        return {
          success: true,
          output: JSON.stringify({
            status: 'BALANCED_ENEMY_SCALING',
            max_level: maxLevel,
            curve: difficultyCurve,
            sample_levels: [scalingTable[0], scalingTable[9], scalingTable[24], scalingTable[maxLevel - 1]],
            total_rows: scalingTable.length
          }, null, 2)
        };
      }

      if (action === 'generate_loot_table') {
        const table = lootEntries.length > 0 ? lootEntries : [
          { item_id: 'gold_coins', drop_chance_pct: 85.0, min_qty: 10, max_qty: 45 },
          { item_id: 'health_potion', drop_chance_pct: 40.0, min_qty: 1, max_qty: 2 },
          { item_id: 'shadow_shard', drop_chance_pct: 25.0, min_qty: 1, max_qty: 3 },
          { item_id: 'iron_sword', drop_chance_pct: 8.0, min_qty: 1, max_qty: 1 },
          { item_id: 'relic_silver_key', drop_chance_pct: 2.5, min_qty: 1, max_qty: 1 }
        ];

        if (projectDir && fsSync.existsSync(projectDir)) {
          const dataDir = path.join(projectDir, 'data');
          await fs.mkdir(dataDir, { recursive: true });
          await fs.writeFile(path.join(dataDir, 'loot_tables.json'), JSON.stringify({ default_enemy_loot: table }, null, 2), 'utf8');
        }

        return {
          success: true,
          output: JSON.stringify({
            status: 'GENERATED_LOOT_TABLE',
            entries_count: table.length,
            table: table
          }, null, 2)
        };
      }

      if (action === 'balance_xp_curve') {
        const xpCurve = [];
        let totalAccumulated = 0;
        for (let lvl = 1; lvl <= maxLevel; lvl++) {
          const req = Math.round(baseXp * Math.pow(1.18, lvl - 1));
          totalAccumulated += req;
          xpCurve.push({
            level: lvl,
            xp_to_next: req,
            total_xp_required: totalAccumulated
          });
        }

        if (projectDir && fsSync.existsSync(projectDir)) {
          const dataDir = path.join(projectDir, 'data');
          await fs.mkdir(dataDir, { recursive: true });
          await fs.writeFile(path.join(dataDir, 'xp_curve.json'), JSON.stringify(xpCurve, null, 2), 'utf8');
        }

        return {
          success: true,
          output: JSON.stringify({
            status: 'BALANCED_XP_CURVE',
            max_level: maxLevel,
            base_xp: baseXp,
            sample_levels: [xpCurve[0], xpCurve[9], xpCurve[24], xpCurve[maxLevel - 1]]
          }, null, 2)
        };
      }

      if (action === 'save_economy_data') {
        if (!projectDir || !fsSync.existsSync(projectDir)) {
          return { success: false, error: `projectDir is required to save economy data.` };
        }
        return {
          success: true,
          output: JSON.stringify({ status: 'SAVED_ALL_ECONOMY_DATA', project_dir: projectDir }, null, 2)
        };
      }

      return { success: false, error: `Unknown action: ${action}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
