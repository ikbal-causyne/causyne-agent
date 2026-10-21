import { runBlenderBatch } from './blenderBatch.js';
import { runStudioEdit } from './studioScripts.js';
export function validatePipeline(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Pipeline must be an object');
    }
    const obj = value;
    if (!Array.isArray(obj.stages) || obj.stages.length < 1 || obj.stages.length > 16) {
        throw new Error('Provide 1..16 pipeline stages');
    }
    const stages = obj.stages.map((raw, index) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error(`Stage ${index + 1} must be an object`);
        }
        const s = raw;
        const id = typeof s.id === 'string' && s.id.trim() ? s.id.trim() : `stage_${index + 1}`;
        if (s.type !== '3d_batch' && s.type !== 'studio_batch') {
            throw new Error(`Stage "${id}" must have type "3d_batch" or "studio_batch"`);
        }
        const type = s.type;
        if (!s.config || typeof s.config !== 'object' || Array.isArray(s.config)) {
            throw new Error(`Stage "${id}" requires a configuration object`);
        }
        return { id, type, config: s.config };
    });
    return { stages };
}
export async function runStudioPipeline(value, workspace = process.cwd(), signal) {
    signal?.throwIfAborted();
    const pipeline = validatePipeline(value);
    const stageResults = [];
    for (let i = 0; i < pipeline.stages.length; i++) {
        signal?.throwIfAborted();
        const stage = pipeline.stages[i];
        try {
            if (stage.type === '3d_batch') {
                const res = await runBlenderBatch(stage.config, workspace, signal);
                stageResults.push({ id: stage.id, success: true, output: res.output });
            }
            else {
                const res = await runStudioEdit(stage.config, workspace, signal);
                if (!res.success) {
                    stageResults.push({ id: stage.id, success: false, error: res.error });
                    return { success: false, stagesCompleted: i, stageResults, error: `Stage "${stage.id}" failed: ${res.error}` };
                }
                stageResults.push({ id: stage.id, success: true, output: res.output });
            }
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            stageResults.push({ id: stage.id, success: false, error: errMsg });
            return { success: false, stagesCompleted: i, stageResults, error: `Stage "${stage.id}" failed: ${errMsg}` };
        }
    }
    return { success: true, stagesCompleted: pipeline.stages.length, stageResults };
}
