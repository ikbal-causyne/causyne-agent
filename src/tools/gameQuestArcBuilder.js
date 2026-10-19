import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

export const gameQuestArcBuilder = {
  schema: {
    name: 'game.quest_arc_builder',
    description: 'Designs multi-stage quest arcs (Main Story + Side Quests) with prerequisite chains, objective milestones (`kill_enemies`, `collect_items`, `reach_location`), and balanced XP/gold rewards. Outputs production `quest_database.json` suitable for Godot QuestEngine tracking.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create_quest_arc', 'add_stage', 'save_quest_db'],
          description: 'Action: create_quest_arc (build main/side quest series), add_stage (append objective), or save_quest_db (persist database to JSON).'
        },
        questId: {
          type: 'string',
          description: 'Unique quest identifier (`quest_1_shadow_relic`, `side_quest_iron_blades`).'
        },
        questTitle: {
          type: 'string',
          description: 'Display title of the quest (`The Shadow Relic`, `Forging the Blade`).'
        },
        questType: {
          type: 'string',
          enum: ['main_story', 'side_quest', 'daily', 'boss_bounty'],
          description: 'Category of the quest.'
        },
        stages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              stage_id: { type: 'string' },
              description: { type: 'string' },
              objective_type: { type: 'string', enum: ['kill_enemies', 'collect_items', 'reach_location', 'talk_npc', 'interact_object'] },
              target_id: { type: 'string' },
              target_count: { type: 'number' }
            }
          },
          description: 'List of quest progression stages.'
        },
        rewards: {
          type: 'object',
          properties: {
            xp: { type: 'number' },
            gold: { type: 'number' },
            items: { type: 'array', items: { type: 'string' } }
          },
          description: 'XP, gold, and item rewards upon completion.'
        },
        projectDir: {
          type: 'string',
          description: 'Optional absolute path to Godot/game project directory (`res://...`) to save `data/quest_database.json`.'
        }
      },
      required: ['action', 'questId']
    }
  },

  async execute(args) {
    try {
      const { action, questId, questTitle = 'Quest', questType = 'main_story', stages = [], rewards = { xp: 500, gold: 150, items: ['health_potion'] }, projectDir } = args;

      if (action === 'create_quest_arc') {
        const defaultStages = stages.length > 0 ? stages : [
          {
            stage_id: 'stage_1_elder_counsel',
            description: 'Speak with Elder Thaddeus in the village square regarding the dark omens.',
            objective_type: 'talk_npc',
            target_id: 'village_elder',
            target_count: 1
          },
          {
            stage_id: 'stage_2_silver_key',
            description: 'Collect 5 Shadow Shards and trade them to Grom the Blacksmith for the Silver Key.',
            objective_type: 'collect_items',
            target_id: 'shadow_shard',
            target_count: 5
          },
          {
            stage_id: 'stage_3_catacombs_breach',
            description: 'Pass the ancient wards and enter the Forgotten Catacombs.',
            objective_type: 'reach_location',
            target_id: 'level_2_catacombs_entrance',
            target_count: 1
          },
          {
            stage_id: 'stage_4_skeleton_purge',
            description: 'Defeat 8 Skeletal Warriors guarding the inner chamber.',
            objective_type: 'kill_enemies',
            target_id: 'skeleton_warrior',
            target_count: 8
          },
          {
            stage_id: 'stage_5_necromancer_showdown',
            description: 'Vanquish Boss Necromancer Vaelen and claim the Shadow Relic.',
            objective_type: 'kill_enemies',
            target_id: 'boss_necromancer',
            target_count: 1
          }
        ];

        const questObject = {
          quest_id: questId,
          title: questTitle,
          type: questType,
          status: 'available',
          prerequisites: [],
          stages: defaultStages,
          rewards: rewards
        };

        if (projectDir && fsSync.existsSync(projectDir)) {
          const dataDir = path.join(projectDir, 'data');
          await fs.mkdir(dataDir, { recursive: true });
          const dbPath = path.join(dataDir, 'quest_database.json');
          let currentDb = {};
          if (fsSync.existsSync(dbPath)) {
            try { currentDb = JSON.parse(await fs.readFile(dbPath, 'utf8')); } catch (e) {}
          }
          currentDb[questId] = questObject;
          await fs.writeFile(dbPath, JSON.stringify(currentDb, null, 2), 'utf8');
        }

        return {
          success: true,
          output: JSON.stringify(questObject, null, 2)
        };
      }

      if (action === 'save_quest_db') {
        if (!projectDir || !fsSync.existsSync(projectDir)) {
          return { success: false, error: `projectDir is required to save quest database.` };
        }
        const dataDir = path.join(projectDir, 'data');
        await fs.mkdir(dataDir, { recursive: true });
        const dbPath = path.join(dataDir, 'quest_database.json');
        await fs.writeFile(dbPath, JSON.stringify({ [questId]: { quest_id: questId, title: questTitle, stages, rewards } }, null, 2), 'utf8');
        return {
          success: true,
          output: JSON.stringify({ status: 'SAVED_QUEST_DB', path: dbPath }, null, 2)
        };
      }

      return { success: false, error: `Unknown action: ${action}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
