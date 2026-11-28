import { getMemory, saveMemory } from '../memory.js';
import { recordScopedFact } from '../memory/scopedFacts.js';
import { cortexDb } from '../cortex/vectorDb.js';
import { resolveEffectiveMemoryPolicy } from '../personalization.js';
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
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
            return { success: false, error: "Missing 'fact' or 'creativePattern' parameter." };
        }
        if (args.fact !== undefined && typeof args.fact !== 'string') {
            return { success: false, error: "'fact' parameter must be a string." };
        }
        if (args.creativePattern !== undefined &&
            (args.creativePattern === null || typeof args.creativePattern !== 'object' || Array.isArray(args.creativePattern))) {
            return { success: false, error: "'creativePattern' parameter must be an object." };
        }
        const rawFact = typeof args.fact === 'string' ? args.fact.trim() : '';
        const cp = args.creativePattern;
        let fact = rawFact;
        if (!fact && cp) {
            const project = typeof cp.project === 'string' && cp.project.trim() ? cp.project.trim() : 'project';
            const approach = typeof cp.designApproach === 'string' && cp.designApproach.trim() ? ` ${cp.designApproach.trim()}` : '';
            const palette = typeof cp.colorPalette === 'string' && cp.colorPalette.trim() ? ` with ${cp.colorPalette.trim()}` : '';
            const fonts = typeof cp.fonts === 'string' && cp.fonts.trim() ? ` (${cp.fonts.trim()})` : '';
            if (approach || palette || fonts || (typeof cp.project === 'string' && cp.project.trim())) {
                fact = `Creative pattern for ${project}:${approach}${palette}${fonts}`.trim();
            }
        }
        if (!fact) {
            return { success: false, error: "Missing non-empty 'fact' or 'creativePattern' parameter." };
        }
        try {
            const workspace = dependencies?.parentLoop?.workspaceRoot || dependencies?.workspaceRoot;
            const memPolicy = resolveEffectiveMemoryPolicy(workspace);
            if (!memPolicy.enabled) {
                return {
                    success: false,
                    error: 'Causyne memories are disabled in Personalization settings for this workspace/device. Enable memories to save facts.'
                };
            }
            if (!memPolicy.allowToolAssisted && dependencies?.parentLoop?.isMemoryPollutedByExternalTools?.()) {
                return {
                    success: false,
                    error: 'Saving memories from tool-assisted chats (MCP/web tools) is disabled in Personalization settings.'
                };
            }
            const memory = getMemory();
            const { memory: updated, alreadyKnown } = recordScopedFact(memory, fact, {
                workspace,
                maxFacts: MAX_FACTS
            });
            if (!alreadyKnown) {
                saveMemory(updated);
            }
            let creativeSaved = false;
            if (cp && typeof cp.designApproach === 'string' && cp.designApproach.trim()) {
                try {
                    await cortexDb.saveCreativePattern({
                        project: typeof cp.project === 'string' && cp.project.trim() ? cp.project.trim() : 'untitled project',
                        designApproach: cp.designApproach.trim(),
                        colorPalette: typeof cp.colorPalette === 'string' && cp.colorPalette.trim() ? cp.colorPalette.trim() : 'unspecified',
                        fonts: typeof cp.fonts === 'string' && cp.fonts.trim() ? cp.fonts.trim() : 'unspecified'
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
                `Total persistent facts: ${updated.facts.length}.`,
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
