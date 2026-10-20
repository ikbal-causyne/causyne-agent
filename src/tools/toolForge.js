import { createPlugin } from '../plugins/pluginManager.js';

function normaliseToolName(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');
}

function pluginNameFor(toolName) {
  return `forged-${toolName.replace(/_/g, '-')}`.slice(0, 64);
}

export const toolForgeTool = {
  schema: {
    name: 'tool.forge',
    description: 'Compatibility entry point for creating a local custom-tool plugin. The generated plugin is disabled until the user reviews and explicitly enables it with plugin_manager.',
    parameters: {
      type: 'object',
      properties: {
        toolName: {
          type: 'string',
          description: 'Name of the custom tool. It is normalized to lowercase letters, digits, underscores, and hyphens.'
        },
        toolDescription: {
          type: 'string',
          description: 'Detailed description of what the tool does and when it should be used.'
        },
        parametersSchema: {
          type: 'string',
          description: 'Stringified JSON schema of the arguments the tool accepts.'
        },
        javascriptCode: {
          type: 'string',
          description: 'Body of async execute(args, context), or a complete module exporting execute.'
        },
        capabilities: {
          type: 'array',
          items: { type: 'string', enum: ['workspace:read', 'workspace:write', 'network', 'subprocess'] },
          description: 'Explicit host capabilities requested by the plugin subprocess.'
        }
      },
      required: ['toolName', 'toolDescription', 'parametersSchema', 'javascriptCode']
    }
  },

  async execute(args) {
    const toolName = normaliseToolName(args.toolName);
    if (!toolName) return { success: false, error: 'toolName is invalid' };

    let parameters;
    try {
      parameters = JSON.parse(args.parametersSchema);
    } catch (error) {
      return { success: false, error: `parametersSchema is invalid JSON: ${error.message}` };
    }

    const result = createPlugin({
      name: pluginNameFor(toolName),
      description: `Custom Causyne plugin for ${toolName}`,
      toolName,
      toolDescription: args.toolDescription,
      parameters,
      code: args.javascriptCode,
      capabilities: args.capabilities || []
    });

    if (!result.ok) return { success: false, error: result.error };
    return {
      success: true,
      ...result,
      message: `${result.message} Use plugin_manager with action "enable" and name "${result.name}" after review.`
    };
  }
};
