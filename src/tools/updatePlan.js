import { normalizePlanUpdate, summarizePlan } from '../implementationPlan.js';
export const updatePlan = {
    schema: {
        name: 'update_plan',
        description: 'Create or replace the visible implementation checklist. Use it before complex implementation and update statuses as work advances. Keep exactly one step in_progress.',
        parameters: {
            type: 'object',
            properties: {
                explanation: { type: 'string', description: 'Short reason for this plan update.' },
                plan: {
                    type: 'array', minItems: 1, maxItems: 24,
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                            step: { type: 'string', description: 'Atomic, verifiable implementation step.' },
                            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
                        },
                        required: ['id', 'step', 'status'],
                        additionalProperties: false
                    }
                }
            },
            required: ['plan'],
            additionalProperties: false
        }
    },
    async execute(args, context = {}) {
        try {
            if (!context.parentLoop || typeof context.parentLoop.updateImplementationPlan !== 'function') {
                return { success: false, error: 'Implementation plans require an active Causyne session' };
            }
            const update = normalizePlanUpdate(args);
            context.parentLoop.updateImplementationPlan(update);
            return { success: true, output: summarizePlan(update.plan), plan: update.plan };
        }
        catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
};
