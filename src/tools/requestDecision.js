import crypto from 'node:crypto';
const KINDS = new Set(['architecture', 'product', 'data', 'security', 'workflow', 'other']);
function text(value, name, limit) {
    if (typeof value !== 'string')
        throw new Error(`${name} must be a string`);
    const cleaned = value.replace(/\s+/g, ' ').trim();
    if (!cleaned)
        throw new Error(`${name} must not be empty`);
    if (cleaned.length > limit)
        throw new Error(`${name} exceeds ${limit} characters`);
    return cleaned;
}
function normalizeRequest(args) {
    const kind = String(args.kind ?? 'other');
    if (!KINDS.has(kind))
        throw new Error('kind is invalid');
    if (!Array.isArray(args.options) || args.options.length < 2 || args.options.length > 4) {
        throw new Error('options must contain 2-4 choices');
    }
    const ids = new Set();
    const options = args.options.map((raw, index) => {
        const option = (raw && typeof raw === 'object' ? raw : {});
        const id = text(option.id ?? `option-${index + 1}`, `options[${index}].id`, 48);
        if (ids.has(id))
            throw new Error(`Duplicate option id: ${id}`);
        ids.add(id);
        return {
            id,
            label: text(option.label, `options[${index}].label`, 80),
            description: text(option.description, `options[${index}].description`, 240)
        };
    });
    return {
        id: crypto.randomUUID(),
        kind,
        header: text(args.header, 'header', 48),
        question: text(args.question, 'question', 500),
        reason: text(args.reason, 'reason', 500),
        options,
        allowCustom: true
    };
}
export const requestDecision = {
    schema: {
        name: 'request_decision',
        description: 'Pause for a durable user decision when several materially different implementation directions are valid. Provide 2-4 concrete options; a custom answer is always available. This is a design decision, not a tool permission request.',
        parameters: {
            type: 'object',
            properties: {
                kind: { type: 'string', enum: ['architecture', 'product', 'data', 'security', 'workflow', 'other'] },
                header: { type: 'string', description: 'Short decision label, at most 48 characters.' },
                question: { type: 'string', description: 'One specific decision the user must make.' },
                reason: { type: 'string', description: 'Why this choice has durable consequences.' },
                options: {
                    type: 'array', minItems: 2, maxItems: 4,
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                            label: { type: 'string' },
                            description: { type: 'string' }
                        },
                        required: ['id', 'label', 'description'],
                        additionalProperties: false
                    }
                }
            },
            required: ['kind', 'header', 'question', 'reason', 'options'],
            additionalProperties: false
        }
    },
    async execute(args, context = {}) {
        try {
            if (!context.parentLoop || typeof context.parentLoop.requestDecision !== 'function') {
                return { success: false, error: 'Structured decisions require an active Causyne session' };
            }
            const request = normalizeRequest(args);
            const answer = await context.parentLoop.requestDecision(request);
            if (!answer)
                return { success: false, error: 'The user dismissed the decision without choosing an option' };
            return { success: true, output: JSON.stringify(answer), decision: answer };
        }
        catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
};
