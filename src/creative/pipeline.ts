import { runBlenderBatch, type Batch as BlenderBatch } from './blenderBatch.js';
import { runStudioEdit, type StudioJob } from './studioScripts.js';

export interface PipelineStage {
  id: string;
  type: '3d_batch' | 'studio_batch';
  config: Record<string, unknown>;
}

export interface StudioPipeline {
  stages: PipelineStage[];
}

export interface PipelineResult {
  success: boolean;
  stagesCompleted: number;
  stageResults: Array<{ id: string; success: boolean; output?: string | undefined; error?: string | undefined }>;
  error?: string | undefined;
}

export function validatePipeline(value: unknown): StudioPipeline {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Pipeline must be an object');
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.stages) || obj.stages.length < 1 || obj.stages.length > 16) {
    throw new Error('Provide 1..16 pipeline stages');
  }

  const stages: PipelineStage[] = obj.stages.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Stage ${index + 1} must be an object`);
    }
    const s = raw as Record<string, unknown>;
    const id = typeof s.id === 'string' && s.id.trim() ? s.id.trim() : `stage_${index + 1}`;
    if (s.type !== '3d_batch' && s.type !== 'studio_batch') {
      throw new Error(`Stage "${id}" must have type "3d_batch" or "studio_batch"`);
    }
    const type: '3d_batch' | 'studio_batch' = s.type;
    if (!s.config || typeof s.config !== 'object' || Array.isArray(s.config)) {
      throw new Error(`Stage "${id}" requires a configuration object`);
    }
    return { id, type, config: s.config as Record<string, unknown> };
  });

  return { stages };
}

export async function runStudioPipeline(
  value: unknown,
  workspace = process.cwd(),
  signal?: AbortSignal
): Promise<PipelineResult> {
  signal?.throwIfAborted();
  const pipeline = validatePipeline(value);
  const stageResults: PipelineResult['stageResults'] = [];

  for (let i = 0; i < pipeline.stages.length; i++) {
    signal?.throwIfAborted();
    const stage = pipeline.stages[i]!;

    try {
      if (stage.type === '3d_batch') {
        const res = await runBlenderBatch(stage.config, workspace, signal);
        stageResults.push({ id: stage.id, success: true, output: res.output });
      } else {
        const res = await runStudioEdit(stage.config, workspace, signal);
        if (!res.success) {
          stageResults.push({ id: stage.id, success: false, error: res.error });
          return { success: false, stagesCompleted: i, stageResults, error: `Stage "${stage.id}" failed: ${res.error}` };
        }
        stageResults.push({ id: stage.id, success: true, output: res.output });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      stageResults.push({ id: stage.id, success: false, error: errMsg });
      return { success: false, stagesCompleted: i, stageResults, error: `Stage "${stage.id}" failed: ${errMsg}` };
    }
  }

  return { success: true, stagesCompleted: pipeline.stages.length, stageResults };
}
