import { getMemory, saveMemory } from '../memory.js';
import { cortexDb } from '../cortex/vectorDb.js';

// Persistent memory write.
//
// This tool used to append facts to `{cwd}/.causyne_memory_store.json` — a file
// that nothing in the codebase ever reads. The facts the agent is actually shown
// come from `getMemoryContextString()`, which reads `~/.causyne/memory.json`, and

// never connected, so every fact the agent chose to remember was written into a
// per-project dead end and silently lost. It now writes where the agent reads.

const MAX_FACTS = 100;

export const memoryWrite = {
  schema: {
    name: 'memory_write',
    description: "Save a durable fact about the user, their machine, or their project into persistent memory. Facts saved here are injected into your system context on every future task, so record only things worth remembering across sessions (preferences, conventions, paths, stack choices). After completing a web or UI design, also pass creativePattern so you do not repeat the same aesthetic next time.",
    parameters: {
      type: 'object',
      properties: {
        fact: {
          type: 'string',
          description: 'The concise, durable fact to remember. One fact per call.'
        },
        creativePattern: {
          type: 'object',
          description: 'Optional. Record a completed design so future projects deliberately differ from it.',
          properties: {
            project: { type: 'string', description: 'What was built, e.g. "coffee roaster landing page".' },
            designApproach: { type: 'string', description: 'The design movement committed to, e.g. "Swiss International", "Brutalism".' },
            colorPalette: { type: 'string', description: 'The palette used, e.g. "warm neutrals + oxblood accent".' },
            fonts: { type: 'string', description: 'Typefaces used, e.g. "Space Grotesk / Inter".' }
          }
        }
      },
      required: ['fact']
    }
  },

  execute: async (args, dependencies) => {
    if (!args || !args.fact) {
      return { success: false, error: "Missing 'fact' parameter." };
    }

    try {
      const memory = getMemory();
      if (!Array.isArray(memory.facts)) memory.facts = [];

      const fact = String(args.fact).trim();
      const alreadyKnown = memory.facts.includes(fact);

      if (!alreadyKnown) {
        memory.facts.push(fact);
        // Self-culling: keep the store bounded so it cannot grow into the
        // system prompt without limit.
        while (memory.facts.length > MAX_FACTS) {
          memory.facts.shift();
        }
        saveMemory(memory);
      }

      // Anti-slop creative memory. saveCreativePattern() existed but had no
      // caller anywhere, so getRecentCreativePatterns() always returned empty
      // and the "DO NOT REPEAT RECENT PATTERNS" directive never once fired.
      let creativeSaved = false;
      if (args.creativePattern && args.creativePattern.designApproach) {
        try {
          await cortexDb.saveCreativePattern({
            project: args.creativePattern.project || 'untitled project',
            designApproach: args.creativePattern.designApproach,
            colorPalette: args.creativePattern.colorPalette || 'unspecified',
            fonts: args.creativePattern.fonts || 'unspecified'
          });
          creativeSaved = true;
        } catch (e) {
          console.error('[CORTEX] Creative pattern save failed:', e.message);
        }
      }

      if (dependencies && dependencies.broadcast) {
        dependencies.broadcast({
          type: 'agent_message',
          content: `🧠 Persistent memory updated: "${fact}"`
        });
      }

      const notes = [
        alreadyKnown ? 'Fact already known, not duplicated.' : 'Fact saved.',
        `Total persistent facts: ${memory.facts.length}.`,
        creativeSaved ? 'Creative pattern recorded in the V5 Cortex.' : ''
      ].filter(Boolean);

      return { success: true, output: notes.join(' ') };
    } catch (e) {
      return { success: false, error: `Failed to save memory: ${e.message}` };
    }
  }
};
