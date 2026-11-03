/**
 * Types and interfaces for PluginsFactory.
 *
 * PluginsFactory empowers Causyne Agent to generate custom plugins, Python bridges,
 * or MCP servers when a requested service/integration does not yet exist.
 *
 * Route Strategy:
 * 1. Native Plugin (HTTP/CLI): Leanest token footprint, lowest cost.
 * 2. Python Bridge: Spawns Python subprocess with JSON protocol for Python-only SDKs.
 * 3. MCP Server: Used when a service strictly permits only MCP or the user explicitly asks for it.
 */

export type RouteKind = 'native_plugin' | 'python_bridge' | 'mcp_server';

export type ServiceKind = 'http_api' | 'cli' | 'python_sdk' | 'mcp_only' | 'custom';

export type CapabilityName = 'workspace:read' | 'workspace:write' | 'network' | 'subprocess';

export interface ToolParameterSchema {
  type: 'object';
  properties?: Record<string, {
    type?: string | undefined;
    description?: string | undefined;
    enum?: string[] | undefined;
    default?: unknown;
    items?: Record<string, unknown> | undefined;
    [key: string]: unknown;
  }> | undefined;
  required?: string[] | undefined;
  [key: string]: unknown;
}

export interface ServiceToolDescriptor {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
  httpMethod?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | undefined;
  httpPath?: string | undefined;
  cliSubcommand?: string | undefined;
  pythonMethod?: string | undefined;
}

export interface ServiceDescriptor {
  name: string;
  description: string;
  serviceKind: ServiceKind;
  endpoint?: string | undefined;
  authType?: 'none' | 'bearer' | 'apiKey' | 'basic' | 'env' | undefined;
  authEnvVar?: string | undefined;
  cliBinary?: string | undefined;
  pythonModule?: string | undefined;
  tools: ServiceToolDescriptor[];
  capabilities?: CapabilityName[] | undefined;
  userPreferredRoute?: RouteKind | undefined;
}

export interface CostEstimate {
  route: RouteKind;
  estimatedSchemaTokens: number;
  estimatedPerCallTokens: number;
  isLongRunningProcess: boolean;
  relativeCostMultiplier: number;
  explanation: string;
}

export interface RouteCostComparison {
  nativePlugin: CostEstimate;
  pythonBridge: CostEstimate;
  mcpServer: CostEstimate;
}

export interface FactoryRouteProposal {
  service: ServiceDescriptor;
  recommendedRoute: RouteKind;
  reason: string;
  costComparison: RouteCostComparison;
  mcpDisclosure?: string | undefined;
  userConsentRequired: boolean;
  userConfirmedRoute?: RouteKind | undefined;
  existingCapability?: {
    covered: boolean;
    source?: 'native_tool' | 'plugin' | 'mcp' | undefined;
    matchName?: string | undefined;
    details?: string | undefined;
  } | undefined;
}

export interface ScaffoldOptions {
  force?: boolean | undefined;
  baseDir?: string | undefined;
  dryRun?: boolean | undefined;
}

export interface ScaffoldResult {
  success: boolean;
  route: RouteKind;
  targetDirectory: string;
  createdFiles: string[];
  digest?: string | undefined;
  instructions: string;
  error?: string | undefined;
}

export interface PluginFactoryOptions {
  pluginsDir?: string | undefined;
  mcpServersDir?: string | undefined;
}
