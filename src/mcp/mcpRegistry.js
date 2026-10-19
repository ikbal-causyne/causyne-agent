// The bridge between user-configured MCP servers and Causyne's tool catalogue.
//
// Discovered tools are namespaced `mcp__<server>__<tool>`, which is what keeps
// them from ever colliding with a native tool name — and makes it obvious in a
// transcript, an audit log and an approval prompt that the call is leaving
// Causyne's own code.

import { McpClient } from './mcpClient.js';
import { loadConfig, saveConfig } from '../config.js';
import { auditLog } from '../auditLog.js';

const NAMESPACE = 'mcp__';
const connected = new Map(); // server name -> McpClient

/** Server definitions the USER configured. Never model-supplied. */
export function configuredServers() {
  const config = loadConfig();
  const servers = Array.isArray(config.mcpServers) ? config.mcpServers : [];
  return servers.filter(s => McpClient.validateDefinition(s) === null);
}


export function addServer(definition) {
  const problem = McpClient.validateDefinition(definition);
  if (problem) return { ok: false, error: problem };

  const config = loadConfig();
  const servers = Array.isArray(config.mcpServers) ? [...config.mcpServers] : [];

  if (servers.some(s => s && s.name === definition.name)) {
    return { ok: false, error: `a server named "${definition.name}" is already configured` };
  }

  // Store only the fields the client actually reads. Anything else a caller
  // sends is dropped rather than persisted into the user's config.
  const stored = { name: definition.name };
  if (definition.url) {
    stored.url = definition.url;
    if (definition.headers && typeof definition.headers === 'object') stored.headers = definition.headers;
  } else {
    stored.command = definition.command;
    if (Array.isArray(definition.args)) stored.args = definition.args;
    if (definition.env && typeof definition.env === 'object') stored.env = definition.env;
    if (typeof definition.cwd === 'string') stored.cwd = definition.cwd;
  }

  config.mcpServers = [...servers, stored];
  // Registering is not consenting: leave it ungranted.
  config.mcpConsent = { ...(config.mcpConsent || {}), [definition.name]: false };
  saveConfig(config);

  auditLog.log({ event: 'mcp_server_added', server: definition.name, transport: definition.url ? 'http' : 'stdio' });
  return { ok: true };
}

/** Remove a server, drop its consent, and close any live connection. */
export function removeServer(name) {
  const config = loadConfig();
  const servers = Array.isArray(config.mcpServers) ? config.mcpServers : [];
  if (!servers.some(s => s && s.name === name)) {
    return { ok: false, error: `no server named "${name}" is configured` };
  }

  config.mcpServers = servers.filter(s => !s || s.name !== name);
  const consent = { ...(config.mcpConsent || {}) };
  delete consent[name];
  config.mcpConsent = consent;
  saveConfig(config);

  const client = connected.get(name);
  if (client) { try { client.close(); } catch (e) {} connected.delete(name); }

  auditLog.log({ event: 'mcp_server_removed', server: name });
  return { ok: true };
}

export function isServerGranted(name) {
  const config = loadConfig();
  return (config.mcpConsent || {})[name] === true;
}

export function grantServer(name) {
  const config = loadConfig();
  config.mcpConsent = { ...(config.mcpConsent || {}), [name]: true };
  saveConfig(config);
  // The consent boundary is exactly what a post-hoc review needs to see.
  auditLog.log({ event: 'mcp_server_granted', server: name });
}

export function revokeServer(name) {
  const config = loadConfig();
  config.mcpConsent = { ...(config.mcpConsent || {}), [name]: false };
  saveConfig(config);
  const client = connected.get(name);
  if (client) { client.close(); connected.delete(name); }
  auditLog.log({ event: 'mcp_server_revoked', server: name });
}

export function toolName(serverName, tool) {
  return `${NAMESPACE}${serverName}__${tool}`;
}

export function isMcpToolName(name) {
  return typeof name === 'string' && name.startsWith(NAMESPACE);
}

/** Split `mcp__server__tool` back into its parts. Tool names may contain `__`. */
export function parseToolName(name) {
  if (!isMcpToolName(name)) return null;
  const rest = name.slice(NAMESPACE.length);
  const separator = rest.indexOf('__');
  if (separator === -1) return null;
  return { server: rest.slice(0, separator), tool: rest.slice(separator + 2) };
}

/**
 * Connect to a granted server, or return the live client.
 * Connecting is never automatic: the caller has already checked consent.
 */
export async function connectServer(name) {
  if (connected.has(name)) return connected.get(name);
  const definition = configuredServers().find(s => s.name === name);
  if (!definition) throw new Error(`no MCP server named "${name}" is configured`);
  const client = await new McpClient(definition).connect();
  connected.set(name, client);
  return client;
}

/**
 * Tool schemas for every granted, reachable server.
 *
 * A server that fails to start is skipped silently rather than failing the
 * whole catalogue — one broken third-party server must not take the agent down.
 */
export async function discoverTools() {
  const definitions = [];
  for (const server of configuredServers()) {
    if (!isServerGranted(server.name)) continue;
    let client;
    try {
      client = await connectServer(server.name);
    } catch (e) {
      console.warn(`[MCP] ${server.name} unavailable: ${e.message}`);
      continue;
    }
    for (const tool of client.tools) {
      definitions.push({
        name: toolName(server.name, tool.name),
        description: `[MCP: ${server.name}] ${tool.description}`.trim(),
        parameters: tool.inputSchema
      });
    }
  }
  return definitions;
}

/**
 * A tool object the registry can execute, for any `mcp__…` name.
 * Returns null for a name that is not MCP, or whose server is not granted.
 */
export function resolveMcpTool(name) {
  const parsed = parseToolName(name);
  if (!parsed) return null;
  if (!configuredServers().some(s => s.name === parsed.server)) return null;

  return {
    schema: { name, description: `MCP tool ${parsed.tool} on server ${parsed.server}`, parameters: { type: 'object', properties: {} } },
    async execute(args) {
      if (!isServerGranted(parsed.server)) {
        return {
          success: false,
          requiresConsent: true,
          error: `The MCP server "${parsed.server}" is configured but not enabled. ` +
                 `Call manage_local_dependencies with action "grant_mcp_server" and group "${parsed.server}" ` +
                 `to request the user's approval.`
        };
      }
      try {
        const client = await connectServer(parsed.server);
        return await client.callTool(parsed.tool, args);
      } catch (e) {
        return { success: false, error: `MCP server "${parsed.server}": ${e.message}` };
      }
    }
  };
}

/** State for the user-facing listing. */
export function serverStatus() {
  return configuredServers().map(server => ({
    name: server.name,
    transport: server.url ? 'http' : 'stdio',
    // The full invocation, not just the binary. "npx" alone tells a user nothing
    // about what they are consenting to run; "npx -y @scope/server-fs /tmp" does.
    target: server.url || [server.command, ...(server.args || [])].join(' '),
    granted: isServerGranted(server.name),
    connected: connected.has(server.name),
    tools: connected.has(server.name) ? connected.get(server.name).tools.map(t => t.name) : []
  }));
}

export function closeAll() {
  for (const [, client] of connected) {
    try { client.close(); } catch (e) {}
  }
  connected.clear();
}
