import { runBlenderBatch } from './blenderBatch.js';
import { runStudioEdit } from './studioScripts.js';
import { runAdobeLiveBridge, runGameEngineBridge } from './liveBridge.js';

export type PipelineStageType = '3d_batch' | 'studio_batch' | 'live_bridge' | 'engine_bridge';

export interface PipelineStage {
  id: string;
  type: PipelineStageType;
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

const VALID_STAGE_TYPES: readonly PipelineStageType[] = ['3d_batch', 'studio_batch', 'live_bridge', 'engine_bridge'];

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
    if (!VALID_STAGE_TYPES.includes(s.type as PipelineStageType)) {
      throw new Error(`Stage "${id}" must have type "3d_batch", "studio_batch", "live_bridge", or "engine_bridge"`);
    }
    const type = s.type as PipelineStageType;
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
      } else if (stage.type === 'studio_batch') {
        const res = await runStudioEdit(stage.config, workspace, signal);
        if (!res.success) {
          stageResults.push({ id: stage.id, success: false, error: res.error });
          return { success: false, stagesCompleted: i, stageResults, error: `Stage "${stage.id}" failed: ${res.error}` };
        }
        stageResults.push({ id: stage.id, success: true, output: res.output });
      } else if (stage.type === 'live_bridge') {
        const res = await runAdobeLiveBridge(stage.config, workspace, signal);
        if (!res.success) {
          const errStr = String(res.error ?? 'Adobe live bridge failed');
          stageResults.push({ id: stage.id, success: false, error: errStr });
          return { success: false, stagesCompleted: i, stageResults, error: `Stage "${stage.id}" failed: ${errStr}` };
        }
        stageResults.push({
          id: stage.id,
          success: true,
          output: typeof res.output === 'string' ? res.output : typeof res.scriptPath === 'string' ? res.scriptPath : 'live_bridge_ok'
        });
      } else {
        const res = await runGameEngineBridge(stage.config, workspace, signal);
        if (!res.success) {
          const errStr = String(res.error ?? 'Game engine bridge failed');
          stageResults.push({ id: stage.id, success: false, error: errStr });
          return { success: false, stagesCompleted: i, stageResults, error: `Stage "${stage.id}" failed: ${errStr}` };
        }
        stageResults.push({
          id: stage.id,
          success: true,
          output: typeof res.scriptPath === 'string' ? res.scriptPath : typeof res.editorScriptPath === 'string' ? res.editorScriptPath : 'engine_bridge_ok'
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      stageResults.push({ id: stage.id, success: false, error: errMsg });
      return { success: false, stagesCompleted: i, stageResults, error: `Stage "${stage.id}" failed: ${errMsg}` };
    }
  }

  return { success: true, stagesCompleted: pipeline.stages.length, stageResults };
}
