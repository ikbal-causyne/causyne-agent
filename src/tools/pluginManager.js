import {
  createPlugin,
  disablePlugin,
  enablePlugin,
  listPlugins
} from '../plugins/pluginManager.js';

export const pluginManagerTool = {
  schema: {
    name: 'plugin.manager',
    description: 'Create and manage local Causyne plugins. Plugins package custom tools and run only after explicit enablement. Use list to inspect plugins; create writes a disabled plugin; enable trusts the current manifest digest; disable revokes it.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'enable', 'disable'] },
        name: { type: 'string', description: 'Lowercase plugin name using letters, digits, and hyphens.' },
        description: { type: 'string' },
        toolName: { type: 'string' },
        toolDescription: { type: 'string' },
        parametersSchema: { type: 'string', description: 'JSON object schema for the custom tool arguments.' },
        javascriptCode: { type: 'string', description: 'Body of async execute(args, context), or a complete module exporting execute.' },
        capabilities: {
          type: 'array',
          items: { type: 'string', enum: ['workspace:read', 'workspace:write', 'network', 'subprocess'] }
        }
      },
      required: ['action']
    }
  },

  async execute(args) {
    if (args.action === 'list') return { success: true, plugins: listPlugins() };
    if (args.action === 'enable') {
      const result = enablePlugin(args.name);
      return result.ok ? { success: true, ...result } : { success: false, error: result.error };
    }
    if (args.action === 'disable') {
      const result = disablePlugin(args.name);
      return result.ok ? { success: true, ...result } : { success: false, error: result.error };
    }
    if (args.action === 'create') {
      let parameters;
      try {
        parameters = JSON.parse(args.parametersSchema || '{}');
      } catch (error) {
        return { success: false, error: `parametersSchema is invalid JSON: ${error.message}` };
      }
      const result = createPlugin({
        name: args.name,
        description: args.description,
        toolName: args.toolName,
        toolDescription: args.toolDescription,
        parameters,
        code: args.javascriptCode,
        capabilities: args.capabilities || []
      });
      return result.ok ? { success: true, ...result } : { success: false, error: result.error };
    }
    return { success: false, error: `Unknown plugin action: ${args.action}` };
  }
};
