import {
  createPlugin,
  createSkillPlugin,
  disablePlugin,
  enablePlugin,
  listPlugins
} from '../plugins/pluginManager.js';
import { getErrorMessage, sanitizeToolError, sanitizeToolText, stripDangerousKeysDeep } from './toolPathSafety.js';

export interface PluginManagerArgs {
  action?: string | undefined;
  name?: string | undefined;
  description?: string | undefined;
  toolName?: string | undefined;
  toolDescription?: string | undefined;
  parametersSchema?: string | undefined;
  javascriptCode?: string | undefined;
  skillId?: string | undefined;
  skillName?: string | undefined;
  skillDescription?: string | undefined;
  skillContent?: string | undefined;
  licenseText?: string | undefined;
  capabilities?: string[] | undefined;
}

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

  async execute(args: PluginManagerArgs = {}): Promise<Record<string, unknown>> {
    try {
      const safeArgs = args && typeof args === 'object' ? args : {};
      if (safeArgs.action === 'list') return { success: true, plugins: listPlugins() };
      if (safeArgs.action === 'enable') {
        const result = enablePlugin(typeof safeArgs.name === 'string' ? safeArgs.name : '');
        return result.ok ? { success: true, ...result } : { success: false, error: result.error };
      }
      if (safeArgs.action === 'disable') {
        const result = disablePlugin(typeof safeArgs.name === 'string' ? safeArgs.name : '');
        return result.ok ? { success: true, ...result } : { success: false, error: result.error };
      }
      if (safeArgs.action === 'create-skill-plugin') {
        const result = createSkillPlugin({
          name: safeArgs.name ?? '',
          description: safeArgs.description ?? '',
          skillId: safeArgs.skillId ?? '',
          skillName: safeArgs.skillName ?? '',
          skillDescription: safeArgs.skillDescription ?? '',
          skillContent: safeArgs.skillContent ?? '',
          licenseText: safeArgs.licenseText ?? ''
        });
        return result.ok ? { success: true, ...result } : { success: false, error: result.error };
      }
      if (safeArgs.action === 'create') {
        const rawSchema = safeArgs.parametersSchema ?? '{}';
        if (typeof rawSchema !== 'string' || rawSchema.length > 65536) {
          return { success: false, error: 'parametersSchema must be a bounded JSON string.' };
        }
        let parameters: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(rawSchema);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { success: false, error: 'parametersSchema must parse to a JSON object.' };
          }
          parameters = stripDangerousKeysDeep(parsed as Record<string, unknown>);
        } catch (error: unknown) {
          return { success: false, error: `parametersSchema is invalid JSON: ${sanitizeToolError(error)}` };
        }
        const result = createPlugin({
          name: safeArgs.name ?? '',
          description: safeArgs.description ?? '',
          toolName: safeArgs.toolName ?? '',
          toolDescription: safeArgs.toolDescription ?? '',
          parameters,
          code: safeArgs.javascriptCode ?? '',
          capabilities: Array.isArray(safeArgs.capabilities) ? safeArgs.capabilities : []
        });
        return result.ok ? { success: true, ...result } : { success: false, error: result.error };
      }
      return { success: false, error: `Unknown plugin action: ${sanitizeToolText(safeArgs.action ?? '', 64)}` };
    } catch (error: unknown) {
      return { success: false, error: sanitizeToolError(error) };
    }
  }
};
