import { runStudioEdit } from '../creative/studioScripts.js';
import { creativeAppStatus } from '../creative/apps.js';
import { runBlenderBatch } from '../creative/blenderBatch.js';
import { runStudioPipeline } from '../creative/pipeline.js';
export const creativeApps = {
    schema: {
        name: 'creative_apps',
        description: 'Inspect installed creative applications, run bounded creative batches, or orchestrate multi-stage creative pipelines. Blender batch creates and edits 3D scenes (primitives, materials, lights, cameras, render) and saves a new .blend. studio_edit uses native scripting: Photo Studio (resize/rotate/layers/flatten -> PSD/PNG/JPG/WEBP), Video Studio (sequences/imports/timeline cuts/markers -> PRPROJ), Motion Studio (compositions/imports/text -> AEP). studio_pipeline executes sequential coordinated multi-host stages. Requires workspace scoping.',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['status', 'blender_batch', 'studio_edit', 'studio_pipeline'] },
                host: { type: 'string', enum: ['photoshop', 'premiere', 'after-effects', 'photo-studio', 'video-studio', 'motion-studio'] },
                input: { type: 'string', description: 'Existing .blend, image/document, or project file inside the workspace.' },
                output: { type: 'string', description: 'New .blend, PSD/PNG, PRPROJ, or AEP file inside the workspace; never overwrites.' },
                stages: {
                    type: 'array',
                    description: 'Stages for studio_pipeline: array of { id, type: "3d_batch"|"studio_batch", config }',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: 'Stage identifier' },
                            type: { type: 'string', enum: ['3d_batch', 'studio_batch'], description: 'Stage batch execution type' },
                            config: {
                                type: 'object',
                                description: 'Stage payload configuration',
                                properties: {
                                    host: { type: 'string' },
                                    input: { type: 'string' },
                                    output: { type: 'string' },
                                    actions: {
                                        type: 'array',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                type: { type: 'string' }
                                            }
                                        }
                                    }
                                }
                            }
                        },
                        required: ['type']
                    }
                },
                actions: { type: 'array', maxItems: 64, items: {
                        type: 'object', properties: {
                            type: { type: 'string', enum: [
                                    'add_cube', 'add_sphere', 'add_cylinder', 'add_plane', 'add_camera', 'add_light',
                                    'material', 'render', 'transform', 'resize', 'rotate', 'crop', 'layer', 'new_layer', 'flatten',
                                    'composition', 'sequence', 'import', 'text', 'marker', 'cut', 'solid', 'adjust_color'
                                ] },
                            name: { type: 'string' },
                            width: { type: 'number' }, height: { type: 'number' },
                            angle: { type: 'number' }, index: { type: 'integer' },
                            opacity: { type: 'number' }, visible: { type: 'boolean' },
                            duration: { type: 'number' }, fps: { type: 'number' },
                            path: { type: 'string' }, start: { type: 'number' }, text: { type: 'string' },
                            location: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
                            scale: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
                            rotation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
                            radius: { type: 'number' }, depth: { type: 'number' },
                            lightType: { type: 'string', enum: ['POINT', 'SUN', 'SPOT', 'AREA'] },
                            energy: { type: 'number' },
                            color: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
                            outputPath: { type: 'string' },
                            resolution: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
                            comment: { type: 'string' },
                            track: { type: 'integer' },
                            time: { type: 'number' },
                            left: { type: 'number' },
                            top: { type: 'number' },
                            blendMode: { type: 'string' },
                            size: { type: 'number' },
                            font: { type: 'string' },
                            x: { type: 'number' },
                            y: { type: 'number' },
                            brightness: { type: 'number' },
                            contrast: { type: 'number' },
                            roughness: { type: 'number' },
                            metallic: { type: 'number' }
                        }, required: ['type'], additionalProperties: false
                    } }
            }, required: ['action'], additionalProperties: false
        }
    },
    async execute(value, context = {}) {
        try {
            if (!value || typeof value !== 'object')
                throw new Error('Expected creative app arguments');
            const args = value;
            if (args.action === 'status')
                return { success: true, apps: await creativeAppStatus() };
            if (args.action === 'studio_edit')
                return await runStudioEdit(args, process.cwd(), context.signal);
            if (args.action === 'blender_batch')
                return await runBlenderBatch(args, process.cwd(), context.signal);
            if (args.action === 'studio_pipeline')
                return await runStudioPipeline(args, process.cwd(), context.signal);
            throw new Error('Unknown creative app action');
        }
        catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
};
