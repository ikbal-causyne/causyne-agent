import { normalizePlanUpdate, summarizePlan } from '../implementationPlan.js';
function healPlanArgs(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return raw;
    const input = { ...raw };
    if (!input.plan && (input.steps || input.items || input.tasks)) {
        input.plan = input.steps || input.items || input.tasks;
    }
    if (Array.isArray(input.plan)) {
        let activeSeen = false;
        input.plan = input.plan.map((stepItem, idx) => {
            if (!stepItem || typeof stepItem !== 'object' || Array.isArray(stepItem))
                return stepItem;
            const s = { ...stepItem };
            if (!s.id)
                s.id = `step-${idx + 1}`;
            if (!s.step && (s.content || s.title || s.name || s.description)) {
                s.step = s.content || s.title || s.name || s.description;
            }
            let status = String(s.status || s.state || 'pending').toLowerCase().trim();
            if (status === 'in-progress' || status === 'in progress' || status === 'running' || status === 'working') {
                status = 'in_progress';
            }
            else if (status === 'done' || status === 'finished' || status === 'complete') {
                status = 'completed';
            }
            else if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
                status = 'pending';
            }
            if (status === 'in_progress') {
                if (activeSeen) {
                    status = 'pending';
                }
                else {
                    activeSeen = true;
                }
            }
            s.status = status;
            return s;
        });
    }
    return input;
}
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
            let update;
            try {
                update = normalizePlanUpdate(args);
            }
            catch {
                update = normalizePlanUpdate(healPlanArgs(args));
            }
            context.parentLoop.updateImplementationPlan(update);
            return { success: true, output: summarizePlan(update.plan), plan: update.plan };
        }
        catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
};
