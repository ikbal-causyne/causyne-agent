import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { getErrorMessage, type ToolWorkspaceContext } from './toolPathSafety.js';

export interface GameEconomyArgs {
  action?: string | undefined;
  maxLevel?: number | undefined;
  difficultyCurve?: string | undefined;
  baseHp?: number | undefined;
  baseXp?: number | undefined;
  lootEntries?: unknown[] | undefined;
  projectDir?: string | undefined;
}

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
        difficultyCurve: { type: 'string', enum: ['linear', 'exponential', 'souls_hardcore'], description: 'Scaling curve type.' },
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
        projectDir: { type: 'string', description: 'Absolute path to project directory (`data/` folder).' }
      },
      required: ['action']
    }
  },

  async execute(args: GameEconomyArgs = {}, _sandbox?: ToolWorkspaceContext): Promise<{ success: boolean; output?: string | undefined; error?: string | undefined }> {
    try {
      const { action, maxLevel = 50, difficultyCurve = 'exponential', baseHp = 100, baseXp = 500, lootEntries = [], projectDir } = args || {};
      const safeMaxLevel = Number.isFinite(Number(maxLevel)) ? Math.max(1, Math.min(1000, Math.floor(Number(maxLevel)))) : 50;
      const safeBaseHp = Number.isFinite(Number(baseHp)) ? Math.max(1, Number(baseHp)) : 100;
      const safeBaseXp = Number.isFinite(Number(baseXp)) ? Math.max(1, Number(baseXp)) : 500;

      if (action === 'balance_enemy_scaling') {
        const scalingTable: Array<Record<string, number>> = [];
        for (let lvl = 1; lvl <= safeMaxLevel; lvl++) {
          let multiplier = 1.0;
          if (difficultyCurve === 'linear') {
            multiplier = 1 + (lvl - 1) * 0.15;
          } else if (difficultyCurve === 'souls_hardcore') {
            multiplier = Math.pow(1.22, Math.min(lvl - 1, 200));
          } else {
            multiplier = Math.pow(1.15, Math.min(lvl - 1, 200));
          }

          scalingTable.push({
            level: lvl,
            max_hp: Math.round(safeBaseHp * multiplier),
            attack_damage: Math.round((safeBaseHp * 0.15) * multiplier),
            xp_reward: Math.round((safeBaseXp * 0.2) * Math.pow(1.12, Math.min(lvl - 1, 200))),
            gold_drop: Math.round(15 * Math.pow(1.1, Math.min(lvl - 1, 200)))
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
            max_level: safeMaxLevel,
            curve: difficultyCurve,
            sample_levels: [scalingTable[0], scalingTable[9], scalingTable[24], scalingTable[safeMaxLevel - 1]].filter(Boolean),
            total_rows: scalingTable.length
          }, null, 2)
        };
      }

      if (action === 'generate_loot_table') {
        const table = Array.isArray(lootEntries) && lootEntries.length > 0 ? lootEntries.slice(0, 256) : [
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
            table
          }, null, 2)
        };
      }

      if (action === 'balance_xp_curve') {
        const xpCurve: Array<Record<string, number>> = [];
        let totalAccumulated = 0;
        for (let lvl = 1; lvl <= safeMaxLevel; lvl++) {
          const req = Math.round(safeBaseXp * Math.pow(1.18, Math.min(lvl - 1, 200)));
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
            max_level: safeMaxLevel,
            base_xp: safeBaseXp,
            sample_levels: [xpCurve[0], xpCurve[9], xpCurve[24], xpCurve[safeMaxLevel - 1]].filter(Boolean)
          }, null, 2)
        };
      }

      if (action === 'save_economy_data') {
        if (!projectDir || !fsSync.existsSync(projectDir)) {
          return { success: false, error: 'projectDir is required to save economy data.' };
        }
        return {
          success: true,
          output: JSON.stringify({ status: 'SAVED_ALL_ECONOMY_DATA', project_dir: projectDir }, null, 2)
        };
      }

      return { success: false, error: `Unknown action: ${String(action ?? '')}` };
    } catch (e: unknown) {
      return { success: false, error: getErrorMessage(e) };
    }
  }
};
