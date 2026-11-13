/**
 * plugins_factory Tool for Causyne Agent.
 *
 * Implements autonomous custom integration evaluation and scaffolding.
 * Recommends token-lean native plugins or Python bridges, while fully respecting
 * user choices if MCP is preferred.
 */
import { PluginsFactory } from '../pluginsFactory/index.js';
const SERVICE_KINDS = new Set(['http_api', 'cli', 'python_sdk', 'mcp_only', 'custom']);
const AUTH_TYPES = new Set(['none', 'bearer', 'apiKey', 'basic', 'env']);
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);
const ROUTE_KINDS = new Set(['native_plugin', 'python_bridge', 'mcp_server']);
function normalizeServiceDescriptor(args) {
    if (args.serviceKind !== undefined && !SERVICE_KINDS.has(args.serviceKind)) {
        throw new Error(`Invalid serviceKind "${String(args.serviceKind)}".`);
    }
    if (args.authType !== undefined && !AUTH_TYPES.has(args.authType)) {
        throw new Error(`Invalid authType "${String(args.authType)}".`);
    }
    if (args.userPreferredRoute !== undefined && !ROUTE_KINDS.has(args.userPreferredRoute)) {
        throw new Error(`Invalid userPreferredRoute "${String(args.userPreferredRoute)}".`);
    }
    if (args.tools !== undefined && !Array.isArray(args.tools)) {
        throw new Error('"tools" must be an array of tool descriptors.');
    }
    const tools = (args.tools || []).map((t, idx) => {
        if (!t || typeof t !== 'object' || Array.isArray(t)) {
            throw new Error(`Tool at index ${idx} must be an object.`);
        }
        if (typeof t.name !== 'string' || !t.name.trim()) {
            throw new Error(`Tool at index ${idx} requires a non-empty name.`);
        }
        if (typeof t.description !== 'string' || !t.description.trim()) {
            throw new Error(`Tool "${t.name}" requires a non-empty description.`);
        }
        if (t.parameters !== undefined &&
            (t.parameters === null || typeof t.parameters !== 'object' || Array.isArray(t.parameters))) {
            throw new Error(`Tool "${t.name}" parameters must be an object JSON schema.`);
        }
        if (t.httpMethod !== undefined && !HTTP_METHODS.has(t.httpMethod)) {
            throw new Error(`Tool "${t.name}" has invalid httpMethod "${String(t.httpMethod)}".`);
        }
        const rawParams = t.parameters ?? {};
        if (rawParams['type'] !== undefined && rawParams['type'] !== 'object') {
            throw new Error(`Tool "${t.name}" parameters must declare type "object".`);
        }
        if (rawParams['properties'] !== undefined &&
            (rawParams['properties'] === null || typeof rawParams['properties'] !== 'object' || Array.isArray(rawParams['properties']))) {
            throw new Error(`Tool "${t.name}" parameters.properties must be an object.`);
        }
        const { type: _discardType, ...restParams } = rawParams;
        const parameters = {
            ...restParams,
            type: 'object',
            properties: (rawParams['properties'] && typeof rawParams['properties'] === 'object')
                ? rawParams['properties']
                : {}
        };
        const tool = {
            name: t.name.trim(),
            description: t.description.trim(),
            parameters
        };
        if (t.httpMethod !== undefined)
            tool.httpMethod = t.httpMethod;
        if (t.httpPath !== undefined)
            tool.httpPath = t.httpPath;
        if (t.cliSubcommand !== undefined)
            tool.cliSubcommand = t.cliSubcommand;
        if (t.pythonMethod !== undefined)
            tool.pythonMethod = t.pythonMethod;
        return tool;
    });
    if (tools.length === 0) {
        tools.push({
            name: 'execute',
            description: `Default execution method for ${args.serviceName}`,
            parameters: { type: 'object', properties: {} }
        });
    }
    const desc = {
        name: args.serviceName,
        description: args.serviceDescription || `Custom integration for ${args.serviceName}`,
        serviceKind: args.serviceKind || 'custom',
        tools
    };
    if (args.endpoint !== undefined)
        desc.endpoint = args.endpoint;
    if (args.authType !== undefined)
        desc.authType = args.authType;
    if (args.authEnvVar !== undefined)
        desc.authEnvVar = args.authEnvVar;
    if (args.cliBinary !== undefined)
        desc.cliBinary = args.cliBinary;
    if (args.pythonModule !== undefined)
        desc.pythonModule = args.pythonModule;
    if (args.capabilities !== undefined)
        desc.capabilities = args.capabilities;
    if (args.userPreferredRoute !== undefined)
        desc.userPreferredRoute = args.userPreferredRoute;
    return desc;
}
export const pluginsFactoryTool = {
    schema: {
        name: 'plugins_factory',
        description: 'Assess, compare token costs, and scaffold custom plugins, Python bridges, or MCP servers for external services or APIs that are not yet integrated into Causyne. Recommends the leanest, most economical route (Native Plugin or Python Bridge) while honoring user choice if MCP is preferred.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['assess', 'estimate_cost', 'scaffold'],
                    description: 'Action: "assess" evaluates routes and returns proposal with token costs; "estimate_cost" returns detailed token footprint; "scaffold" creates the files in ~/.causyne/.'
                },
                serviceName: {
                    type: 'string',
                    description: 'Name of the service or plugin (lowercase alphanumeric and hyphens, e.g. "notion-api", "blender-cycles").'
                },
                serviceDescription: {
                    type: 'string',
                    description: 'Overview of what the external service does and why the integration is needed.'
                },
                serviceKind: {
                    type: 'string',
                    enum: ['http_api', 'cli', 'python_sdk', 'mcp_only', 'custom'],
                    description: 'Nature of the target service.'
                },
                endpoint: {
                    type: 'string',
                    description: 'Base URL for HTTP APIs (e.g. "https://api.github.com").'
                },
                authType: {
                    type: 'string',
                    enum: ['none', 'bearer', 'apiKey', 'basic', 'env'],
                    description: 'Authentication scheme.'
                },
                authEnvVar: {
                    type: 'string',
                    description: 'Environment variable name holding the API token (e.g. "NOTION_API_KEY").'
                },
                cliBinary: {
                    type: 'string',
                    description: 'Binary executable name for CLI plugins (e.g. "ffmpeg", "yt-dlp").'
                },
                pythonModule: {
                    type: 'string',
                    description: 'Python package/module name for Python bridges (e.g. "bpy", "torch").'
                },
                tools: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string', description: 'Tool name' },
                            description: { type: 'string', description: 'What the tool does' },
                            parameters: { type: 'object', description: 'JSON schema for tool parameters' },
                            httpMethod: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
                            httpPath: { type: 'string', description: 'HTTP relative path' },
                            cliSubcommand: { type: 'string', description: 'Subcommand for CLI tools' },
                            pythonMethod: { type: 'string', description: 'Method name in Python bridge' }
                        },
                        required: ['name', 'description']
                    },
                    description: 'List of tools to expose to the agent.'
                },
                capabilities: {
                    type: 'array',
                    items: {
                        type: 'string',
                        enum: ['workspace:read', 'workspace:write', 'network', 'subprocess']
                    },
                    description: 'Host sandbox permissions required.'
                },
                userPreferredRoute: {
                    type: 'string',
                    enum: ['native_plugin', 'python_bridge', 'mcp_server'],
                    description: 'Explicit user route preference (e.g. user insists on MCP).'
                },
                force: {
                    type: 'boolean',
                    description: 'Overwrite existing directory if present.'
                },
                dryRun: {
                    type: 'boolean',
                    description: 'Simulate scaffolding without writing files.'
                }
            },
            required: ['action', 'serviceName']
        }
    },
    async execute(args) {
        try {
            if (!args || !args.action || !args.serviceName) {
                return {
                    success: false,
                    action: args?.action || 'unknown',
                    error: 'Missing required arguments: "action" and "serviceName" are required.'
                };
            }
            if (args.force !== undefined && typeof args.force !== 'boolean') {
                return { success: false, action: args.action, error: '"force" must be a boolean.' };
            }
            if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') {
                return { success: false, action: args.action, error: '"dryRun" must be a boolean.' };
            }
            const factory = new PluginsFactory();
            const service = normalizeServiceDescriptor(args);
            const proposal = factory.assess(service, args.userPreferredRoute);
            if (args.action === 'assess' || args.action === 'estimate_cost') {
                const res = {
                    success: true,
                    action: args.action,
                    proposal,
                    message: [
                        `Assessment complete for service '${service.name}'.`,
                        `Recommended Route: ${proposal.recommendedRoute} (${proposal.reason})`,
                        proposal.mcpDisclosure ? `\n${proposal.mcpDisclosure}` : ''
                    ].filter(Boolean).join('\n')
                };
                return res;
            }
            if (args.action === 'scaffold') {
                const scaffoldOpts = {};
                if (args.force !== undefined)
                    scaffoldOpts.force = args.force;
                if (args.dryRun !== undefined)
                    scaffoldOpts.dryRun = args.dryRun;
                const scaffoldResult = await factory.scaffold(proposal, scaffoldOpts);
                const res = {
                    success: scaffoldResult.success,
                    action: 'scaffold',
                    proposal,
                    scaffoldResult,
                    message: scaffoldResult.instructions
                };
                if (scaffoldResult.error !== undefined)
                    res.error = scaffoldResult.error;
                return res;
            }
            return {
                success: false,
                action: args.action,
                error: `Unrecognized action: "${args.action}". Allowed: assess, estimate_cost, scaffold`
            };
        }
        catch (err) {
            return {
                success: false,
                action: args?.action || 'execute',
                error: err instanceof Error ? err.message : String(err)
            };
        }
    }
};
