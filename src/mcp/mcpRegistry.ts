import { createHash } from 'node:crypto';

import {
  McpClient,
  McpConnectionError,
  type McpConnectionStatus,
  type McpServerDefinition,
  type McpToolCallResult,
  type McpToolDefinition
} from './mcpClient.js';
import { loadConfig, saveConfig } from '../config.js';
import { auditLog } from '../auditLog.js';

const NAMESPACE = 'mcp__';
const RESOURCE_LIST_TOOL = '_causyne_resources_list';
const RESOURCE_READ_TOOL = '_causyne_resource_read';
const PROMPT_LIST_TOOL = '_causyne_prompts_list';
const PROMPT_GET_TOOL = '_causyne_prompt_get';
const connected = new Map<string, McpClient>();
const connecting = new Map<string, Promise<McpClient>>();
const statuses = new Map<string, McpConnectionStatus>();
const connectionEpochs = new Map<string, number>();

interface ConsentRecord {
  digest: string;
  grantedAt: number;
}

interface ConfigShape {
  mcpServers?: unknown[];
  mcpConsent?: Record<string, unknown>;
  [key: string]: unknown;
}

interface DynamicToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

type ToolResult = McpToolCallResult & { requiresConsent?: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') result[key] = item;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function cloneStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function normalizeDefinition(value: unknown): McpServerDefinition | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  const definition: McpServerDefinition = { name: value.name };
  if (typeof value.command === 'string') definition.command = value.command;
  if (typeof value.url === 'string') definition.url = value.url;
  const args = cloneStringArray(value.args);
  const env = cloneStringRecord(value.env);
  const headers = cloneStringRecord(value.headers);
  if (args) definition.args = args;
  if (env) definition.env = env;
  if (headers) definition.headers = headers;
  if (typeof value.cwd === 'string') definition.cwd = value.cwd;
  if (typeof value.enabled === 'boolean') definition.enabled = value.enabled;
  if (typeof value.timeoutMs === 'number') definition.timeoutMs = value.timeoutMs;
  if (value.protocol === 'legacy' || value.protocol === 'auto') definition.protocol = value.protocol;
  if (isRecord(value.tools)) {
    const include = cloneStringArray(value.tools.include);
    const exclude = cloneStringArray(value.tools.exclude);
    if (include || exclude) {
      definition.tools = {};
      if (include) definition.tools.include = include;
      if (exclude) definition.tools.exclude = exclude;
    }
  }
  return McpClient.validateDefinition(definition) === null ? definition : null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

export function definitionDigest(definition: McpServerDefinition): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(definition))).digest('hex');
}

function consentRecord(value: unknown): ConsentRecord | null {
  if (!isRecord(value) || typeof value.digest !== 'string' || typeof value.grantedAt !== 'number') return null;
  return { digest: value.digest, grantedAt: value.grantedAt };
}

function globMatches(name: string, pattern: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.');
  return new RegExp(`^${source}$`, 'u').test(name);
}

function toolAllowed(server: McpServerDefinition, toolName: string): boolean {
  const include = server.tools?.include;
  const exclude = server.tools?.exclude;
  if (include && !include.some(pattern => globMatches(toolName, pattern))) return false;
  if (exclude?.some(pattern => globMatches(toolName, pattern))) return false;
  return true;
}

function utilityDefinitions(server: McpServerDefinition, client: McpClient): DynamicToolDefinition[] {
  const definitions: DynamicToolDefinition[] = [];
  if (client.supportsResources()) {
    definitions.push(
      {
        name: toolName(server.name, RESOURCE_LIST_TOOL),
        description: `[MCP: ${server.name}] List the resources and resource templates exposed by this server.`,
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        name: toolName(server.name, RESOURCE_READ_TOOL),
        description: `[MCP: ${server.name}] Read one resource by its exact URI.`,
        parameters: {
          type: 'object',
          properties: { uri: { type: 'string', description: 'Exact MCP resource URI.' } },
          required: ['uri'],
          additionalProperties: false
        }
      }
    );
  }
  if (client.supportsPrompts()) {
    definitions.push(
      {
        name: toolName(server.name, PROMPT_LIST_TOOL),
        description: `[MCP: ${server.name}] List the prompts exposed by this server.`,
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        name: toolName(server.name, PROMPT_GET_TOOL),
        description: `[MCP: ${server.name}] Get a prompt by name with optional string arguments.`,
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Exact MCP prompt name.' },
            arguments: { type: 'object', additionalProperties: { type: 'string' } }
          },
          required: ['name'],
          additionalProperties: false
        }
      }
    );
  }
  return definitions.filter(definition => toolAllowed(server, parseToolName(definition.name)?.tool ?? ''));
}

function config(): ConfigShape {
  return loadConfig() as ConfigShape;
}

function connectionEpoch(name: string): number {
  return connectionEpochs.get(name) ?? 0;
}

function invalidateConnection(name: string): void {
  connectionEpochs.set(name, connectionEpoch(name) + 1);
}

/** Server definitions the user configured. Model output never reaches this source. */
export function configuredServers(): McpServerDefinition[] {
  const servers = config().mcpServers;
  if (!Array.isArray(servers)) return [];
  return servers.map(normalizeDefinition).filter((server): server is McpServerDefinition => server !== null);
}

export function addServer(value: unknown): { ok: boolean; error?: string } {
  const problem = McpClient.validateDefinition(value);
  if (problem) return { ok: false, error: problem };
  const definition = normalizeDefinition(value);
  if (!definition) return { ok: false, error: 'invalid server definition' };

  const current = config();
  const servers = Array.isArray(current.mcpServers) ? [...current.mcpServers] : [];
  if (servers.some(server => isRecord(server) && server.name === definition.name)) {
    return { ok: false, error: `a server named "${definition.name}" is already configured` };
  }

  current.mcpServers = [...servers, definition];
  current.mcpConsent = { ...(current.mcpConsent ?? {}), [definition.name]: false };
  saveConfig(current);
  statuses.set(definition.name, definition.enabled === false ? { state: 'disabled' } : { state: 'disconnected' });
  auditLog.log({ event: 'mcp_server_added', server: definition.name, transport: definition.url ? 'http' : 'stdio' });
  return { ok: true };
}

export function removeServer(name: string): { ok: boolean; error?: string } {
  const current = config();
  const servers = Array.isArray(current.mcpServers) ? current.mcpServers : [];
  if (!servers.some(server => isRecord(server) && server.name === name)) {
    return { ok: false, error: `no server named "${name}" is configured` };
  }

  current.mcpServers = servers.filter(server => !isRecord(server) || server.name !== name);
  const consent = { ...(current.mcpConsent ?? {}) };
  delete consent[name];
  current.mcpConsent = consent;
  saveConfig(current);
  void disconnectServer(name);
  statuses.delete(name);
  auditLog.log({ event: 'mcp_server_removed', server: name });
  return { ok: true };
}

export function isServerGranted(name: string): boolean {
  const definition = configuredServers().find(server => server.name === name);
  if (!definition || definition.enabled === false) return false;
  const consent = consentRecord(config().mcpConsent?.[name]);
  return consent?.digest === definitionDigest(definition);
}

export function grantServer(name: string): { ok: boolean; error?: string } {
  const definition = configuredServers().find(server => server.name === name);
  if (!definition) return { ok: false, error: `no server named "${name}" is configured` };
  const current = config();
  const digest = definitionDigest(definition);
  current.mcpConsent = {
    ...(current.mcpConsent ?? {}),
    [name]: { digest, grantedAt: Date.now() }
  };
  saveConfig(current);
  statuses.set(name, definition.enabled === false ? { state: 'disabled' } : { state: 'disconnected' });
  auditLog.log({ event: 'mcp_server_granted', server: name, definitionDigest: digest.slice(0, 12) });
  return { ok: true };
}

export function revokeServer(name: string): void {
  const current = config();
  current.mcpConsent = { ...(current.mcpConsent ?? {}), [name]: false };
  saveConfig(current);
  void disconnectServer(name);
  statuses.set(name, { state: 'disconnected' });
  auditLog.log({ event: 'mcp_server_revoked', server: name });
}

export function toolName(serverName: string, tool: string): string {
  return `${NAMESPACE}${serverName}__${tool}`;
}

export function isMcpToolName(name: unknown): name is string {
  return typeof name === 'string' && name.startsWith(NAMESPACE);
}

export function parseToolName(name: unknown): { server: string; tool: string } | null {
  if (!isMcpToolName(name)) return null;
  const rest = name.slice(NAMESPACE.length);
  const separator = rest.indexOf('__');
  if (separator <= 0 || separator === rest.length - 2) return null;
  return { server: rest.slice(0, separator), tool: rest.slice(separator + 2) };
}

export async function connectServer(name: string): Promise<McpClient> {
  const definition = configuredServers().find(server => server.name === name);
  if (!definition) throw new Error(`no MCP server named "${name}" is configured`);
  if (definition.enabled === false) {
    statuses.set(name, { state: 'disabled' });
    throw new Error(`MCP server "${name}" is disabled`);
  }
  if (!isServerGranted(name)) throw new Error(`MCP server "${name}" has not been granted for its current configuration`);

  const live = connected.get(name);
  if (live && live.status.state === 'connected' && definitionDigest(live.definition) === definitionDigest(definition)) {
    return live;
  }
  if (live) await disconnectServer(name);
  const pending = connecting.get(name);
  if (pending) return pending;

  const startedAtEpoch = connectionEpoch(name);
  let promise!: Promise<McpClient>;
  promise = (async () => {
    const client = new McpClient(definition, {
      workspace: process.cwd(),
      onStatus: status => {
        if (connectionEpoch(name) !== startedAtEpoch) return;
        statuses.set(name, status);
        if (status.state === 'failed' || status.state === 'needs_auth') connected.delete(name);
      }
    });
    statuses.set(name, { state: 'connecting' });
    try {
      await client.connect();
      const current = configuredServers().find(server => server.name === name);
      const connectionIsCurrent = connectionEpoch(name) === startedAtEpoch
        && current !== undefined
        && definitionDigest(current) === definitionDigest(definition)
        && isServerGranted(name);
      if (!connectionIsCurrent) {
        await client.close();
        throw new Error(`MCP server "${name}" connection was cancelled`);
      }
      connected.set(name, client);
      statuses.set(name, client.status);
      return client;
    } catch (error) {
      const status = error instanceof McpConnectionError
        ? { state: error.state, error: error.message } satisfies McpConnectionStatus
        : { state: 'failed', error: error instanceof Error ? error.message : String(error) } satisfies McpConnectionStatus;
      if (connectionEpoch(name) === startedAtEpoch) statuses.set(name, status);
      throw error;
    } finally {
      if (connecting.get(name) === promise) connecting.delete(name);
    }
  })();
  connecting.set(name, promise);
  return promise;
}

export async function disconnectServer(name: string): Promise<void> {
  invalidateConnection(name);
  const client = connected.get(name);
  connected.delete(name);
  connecting.delete(name);
  if (client) await client.close();
  if (configuredServers().some(server => server.name === name)) statuses.set(name, { state: 'disconnected' });
}

export async function refreshServer(name: string): Promise<McpToolDefinition[]> {
  const client = await connectServer(name);
  return client.refreshTools();
}

export async function discoverTools(): Promise<DynamicToolDefinition[]> {
  const granted = configuredServers().filter(server => isServerGranted(server.name));
  const results = await Promise.all(granted.map(async server => {
    try {
      const client = await connectServer(server.name);
      return client.tools
        .filter(tool => toolAllowed(server, tool.name))
        .map(tool => ({
          name: toolName(server.name, tool.name),
          description: `[MCP: ${server.name}] ${tool.description}`.trim(),
          parameters: tool.inputSchema
        }))
        .concat(utilityDefinitions(server, client));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[MCP] ${server.name} unavailable: ${message}`);
      return [];
    }
  }));
  return results.flat();
}

export function resolveMcpTool(name: unknown): { schema: DynamicToolDefinition; execute: (args: Record<string, unknown>, context?: { signal?: AbortSignal }) => Promise<ToolResult> } | null {
  const parsed = parseToolName(name);
  if (!parsed) return null;
  const definition = configuredServers().find(server => server.name === parsed.server);
  if (!definition) return null;

  return {
    schema: {
      name: name as string,
      description: `MCP tool ${parsed.tool} on server ${parsed.server}`,
      parameters: { type: 'object', properties: {} }
    },
    async execute(args, context = {}) {
      if (!isServerGranted(parsed.server)) {
        return {
          success: false,
          requiresConsent: true,
          error: `The MCP server "${parsed.server}" is configured but not enabled for its current definition. ` +
                 `Request approval with manage_local_dependencies action "grant_mcp_server" and group "${parsed.server}".`
        };
      }
      try {
        const client = await connectServer(parsed.server);
        if (parsed.tool === RESOURCE_LIST_TOOL) return await client.listResources(context.signal);
        if (parsed.tool === RESOURCE_READ_TOOL) {
          return typeof args.uri === 'string'
            ? await client.readResource(args.uri, context.signal)
            : { success: false, error: '`uri` must be a string' };
        }
        if (parsed.tool === PROMPT_LIST_TOOL) return await client.listPrompts(context.signal);
        if (parsed.tool === PROMPT_GET_TOOL) {
          if (typeof args.name !== 'string') return { success: false, error: '`name` must be a string' };
          const promptArgs: Record<string, string> = {};
          if (isRecord(args.arguments)) {
            for (const [key, value] of Object.entries(args.arguments)) {
              if (typeof value !== 'string') return { success: false, error: '`arguments` values must be strings' };
              promptArgs[key] = value;
            }
          }
          return await client.getPrompt(args.name, promptArgs, context.signal);
        }
        const tool = client.tools.find(item => item.name === parsed.tool);
        if (!tool || !toolAllowed(definition, parsed.tool)) {
          return { success: false, error: `MCP server "${parsed.server}" does not expose permitted tool "${parsed.tool}"` };
        }
        return await client.callTool(parsed.tool, args ?? {}, context.signal);
      } catch (error) {
        return { success: false, error: `MCP server "${parsed.server}": ${error instanceof Error ? error.message : String(error)}` };
      }
    }
  };
}

export function serverStatus(): Array<{
  name: string;
  transport: string;
  target: string;
  granted: boolean;
  connected: boolean;
  status: McpConnectionStatus['state'];
  error?: string;
  tools: string[];
}> {
  return configuredServers().map(server => {
    const live = connected.get(server.name);
    const status = server.enabled === false
      ? { state: 'disabled' as const }
      : statuses.get(server.name) ?? { state: 'disconnected' as const };
    const result = {
      name: server.name,
      transport: status.transport ?? (server.url ? 'http' : 'stdio'),
      target: server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(' '),
      granted: isServerGranted(server.name),
      connected: status.state === 'connected',
      status: status.state,
      tools: live?.tools.filter(tool => toolAllowed(server, tool.name)).map(tool => tool.name) ?? []
    };
    return status.error ? { ...result, error: status.error } : result;
  });
}

export async function closeAll(): Promise<void> {
  for (const name of new Set([...connected.keys(), ...connecting.keys()])) invalidateConnection(name);
  const clients = [...connected.values()];
  connected.clear();
  connecting.clear();
  await Promise.allSettled(clients.map(client => client.close()));
  statuses.clear();
  connectionEpochs.clear();
}
