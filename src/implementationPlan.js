const MAX_STEPS = 24;
function cleanText(value, name, limit) {
    if (typeof value !== 'string')
        throw new Error(`${name} must be a string`);
    const cleaned = value.replace(/\s+/g, ' ').trim();
    if (!cleaned)
        throw new Error(`${name} must not be empty`);
    if (cleaned.length > limit)
        throw new Error(`${name} exceeds ${limit} characters`);
    return cleaned;
}
export function normalizePlanUpdate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Plan update must be an object');
    const input = value;
    if (!Array.isArray(input.plan) || input.plan.length === 0)
        throw new Error('plan must contain at least one step');
    if (input.plan.length > MAX_STEPS)
        throw new Error(`plan may contain at most ${MAX_STEPS} steps`);
    const ids = new Set();
    let active = 0;
    const plan = input.plan.map((raw, index) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            throw new Error(`plan[${index}] must be an object`);
        const item = raw;
        const id = cleanText(item.id ?? `step-${index + 1}`, `plan[${index}].id`, 64);
        const step = cleanText(item.step ?? item.content, `plan[${index}].step`, 240);
        const status = item.status;
        if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
            throw new Error(`plan[${index}].status must be pending, in_progress, or completed`);
        }
        if (ids.has(id))
            throw new Error(`Duplicate plan step id: ${id}`);
        ids.add(id);
        if (status === 'in_progress')
            active += 1;
        return { id, step, status };
    });
    if (active > 1)
        throw new Error('Only one plan step may be in_progress');
    const explanation = typeof input.explanation === 'string'
        ? input.explanation.replace(/\s+/g, ' ').trim().slice(0, 500)
        : '';
    return { explanation, plan };
}
export function summarizePlan(plan) {
    const completed = plan.filter(item => item.status === 'completed').length;
    const active = plan.find(item => item.status === 'in_progress');
    return `${completed}/${plan.length} completed${active ? `; in progress: ${active.step}` : ''}`;
}
