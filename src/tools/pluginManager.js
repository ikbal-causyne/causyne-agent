import { createPlugin, createSkillPlugin, disablePlugin, enablePlugin, listPlugins } from '../plugins/pluginManager.js';
import { getErrorMessage } from './toolPathSafety.js';
export const pluginManagerTool = {
    schema: {
        name: 'plugin.manager',
        description: 'Create and manage local Causyne plugins. create-skill-plugin packages reviewed MIT/Apache skill text as a disabled, non-executable plugin and retains its license; enable trusts the current directory digest.',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['list', 'create', 'create-skill-plugin', 'enable', 'disable'] },
                name: { type: 'string', description: 'Lowercase plugin name using letters, digits, and hyphens.' },
                description: { type: 'string' },
                toolName: { type: 'string' },
                toolDescription: { type: 'string' },
                parametersSchema: { type: 'string', description: 'JSON object schema for the custom tool arguments.' },
                javascriptCode: { type: 'string', description: 'Body of async execute(args, context), or a complete module exporting execute.' },
                skillId: { type: 'string' },
                skillName: { type: 'string' },
                skillDescription: { type: 'string' },
                skillContent: { type: 'string', description: 'Reviewed SKILL.md source, not executed as code.' },
                licenseText: { type: 'string', description: 'Complete original MIT or Apache-2.0 license notice.' },
                capabilities: {
                    type: 'array',
                    items: { type: 'string', enum: ['workspace:read', 'workspace:write', 'network', 'subprocess'] }
                }
            },
            required: ['action']
        }
    },
    async execute(args = {}) {
        if (args.action === 'list')
            return { success: true, plugins: listPlugins() };
        if (args.action === 'enable') {
            const result = enablePlugin(typeof args.name === 'string' ? args.name : '');
            return result.ok ? { success: true, ...result } : { success: false, error: result.error };
        }
        if (args.action === 'disable') {
            const result = disablePlugin(typeof args.name === 'string' ? args.name : '');
            return result.ok ? { success: true, ...result } : { success: false, error: result.error };
        }
        if (args.action === 'create-skill-plugin') {
            const result = createSkillPlugin({
                name: args.name ?? '',
                description: args.description ?? '',
                skillId: args.skillId ?? '',
                skillName: args.skillName ?? '',
                skillDescription: args.skillDescription ?? '',
                skillContent: args.skillContent ?? '',
                licenseText: args.licenseText ?? ''
            });
            return result.ok ? { success: true, ...result } : { success: false, error: result.error };
        }
        if (args.action === 'create') {
            let parameters;
            try {
                parameters = JSON.parse(args.parametersSchema || '{}');
            }
            catch (error) {
                return { success: false, error: `parametersSchema is invalid JSON: ${getErrorMessage(error)}` };
            }
            const result = createPlugin({
                name: args.name ?? '',
                description: args.description ?? '',
                toolName: args.toolName ?? '',
                toolDescription: args.toolDescription ?? '',
                parameters,
                code: args.javascriptCode ?? '',
                capabilities: Array.isArray(args.capabilities) ? args.capabilities : []
            });
            return result.ok ? { success: true, ...result } : { success: false, error: result.error };
        }
        return { success: false, error: `Unknown plugin action: ${String(args.action ?? '')}` };
    }
};
