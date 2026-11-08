// @ts-expect-error Legacy memory module has no TypeScript declarations yet.
import { getMemory, saveMemory } from '../memory.js';
import { cortexDb } from '../cortex/vectorDb.js';
const MAX_FACTS = 100;
export const memoryWrite = {
    schema: {
        name: 'memory_write',
        description: 'Save a durable fact about the user, their machine, or their project into persistent memory. Facts saved here are injected into your system context on every future task, so record only things worth remembering across sessions (preferences, conventions, paths, stack choices). After completing a web or UI design, also pass creativePattern so you do not repeat the same aesthetic next time.',
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
            required: []
        }
    },
    execute: async (args, dependencies) => {
        if (!args || (!args.fact && !args.creativePattern)) {
            return { success: false, error: "Missing 'fact' or 'creativePattern' parameter." };
        }
        if (!args.fact && args.creativePattern) {
            const cp = args.creativePattern;
            const project = cp.project || 'project';
            const approach = cp.designApproach ? ` ${cp.designApproach}` : '';
            const palette = cp.colorPalette ? ` with ${cp.colorPalette}` : '';
            const fonts = cp.fonts ? ` (${cp.fonts})` : '';
            args.fact = `Creative pattern for ${project}:${approach}${palette}${fonts}`.trim();
        }
        try {
            const memory = getMemory();
            if (!Array.isArray(memory.facts))
                memory.facts = [];
            const fact = String(args.fact).trim();
            const alreadyKnown = memory.facts.includes(fact);
            if (!alreadyKnown) {
                memory.facts.push(fact);
                while (memory.facts.length > MAX_FACTS) {
                    memory.facts.shift();
                }
                saveMemory(memory);
            }
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
                }
                catch {
                    // Optional Cortex dependencies may not be installed; standard local session memory remains active.
                    // Never write raw errors to console.error during a TUI session as that corrupts the composer viewport.
                }
            }
            if (dependencies && typeof dependencies.broadcast === 'function') {
                dependencies.broadcast({
                    type: 'agent_message',
                    content: `◆ Persistent memory updated: "${fact}"`
                });
            }
            const notes = [
                alreadyKnown ? 'Fact already known, not duplicated.' : 'Fact saved.',
                `Total persistent facts: ${memory.facts.length}.`,
                creativeSaved ? 'Creative pattern recorded in the V5 Cortex.' : ''
            ].filter(Boolean);
            return { success: true, output: notes.join(' ') };
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { success: false, error: `Failed to save memory: ${msg}` };
        }
    }
};
