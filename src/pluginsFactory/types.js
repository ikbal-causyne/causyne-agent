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
export {};
