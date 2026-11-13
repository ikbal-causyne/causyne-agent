/**
 * Capability Discovery for PluginsFactory.
 *
 * Checks whether a requested tool or capability is already covered by:
 * 1. Native built-in tools in Causyne Agent.
 * 2. Installed local plugins in ~/.causyne/plugins.
 * 3. Configured MCP servers in ~/.causyne/config.json.
 *
 * If already covered, recommends reusing existing functionality to avoid duplicate code.
 */

import { configuredServers } from '../mcp/mcpRegistry.js';
// @ts-expect-error legacy JS plugin manager lacks typings
import { listPlugins } from '../plugins/pluginManager.js';

export interface ExistingCapabilityMatch {
  covered: boolean;
  source?: 'native_tool' | 'plugin' | 'mcp';
  matchName?: string;
  details?: string;
}

const NATIVE_TOOLS_CATALOG: Array<{ name: string; description: string; aliases: string[] }> = [
  { name: 'fs_read', description: 'Read file contents from the workspace', aliases: ['read_file', 'cat', 'open_file'] },
  { name: 'fs_write', description: 'Write or append file contents in the workspace', aliases: ['write_file', 'save_file'] },
  { name: 'sysRun', description: 'Execute shell commands with safety checks', aliases: ['run_command', 'shell', 'exec', 'bash'] },
  { name: 'web_search', description: 'Perform web search queries', aliases: ['search', 'google_search', 'web_query'] },
  { name: 'web_fetch', description: 'Fetch and extract clean markdown from web pages', aliases: ['curl', 'http_get', 'scrape'] },
  { name: 'browser_act', description: 'Autonomous browser control for web apps and QA', aliases: ['playwright', 'puppeteer', 'chrome'] },
  { name: 'vision_inspect_ui', description: 'Inspect images and visual assets with OCR/layout', aliases: ['ocr', 'image_inspect'] },
  { name: 'resolve_act', description: 'DaVinci Resolve automation and studio workflows', aliases: ['resolve', 'davinci', 'video_edit'] },
  { name: 'blender_act', description: 'Blender 3D scene rendering and automation', aliases: ['blender', '3d_render', 'cycles'] },
  { name: 'archive', description: 'Extract, inspect, or build archive files (zip/tar)', aliases: ['unzip', 'tar', 'extract'] },
  { name: 'pdf_read', description: 'Extract structured text and tables from PDF documents', aliases: ['read_pdf', 'extract_pdf'] }
];

/**
 * Normalizes a name for token comparison. Hyphens and underscores become
 * spaces so "web_search" and "web search" compare identically.
 */
function normalizeTerm(value: string): string {
  return value.toLowerCase().trim().replace(/[-_]+/g, ' ');
}

/**
 * Matches whole terms only. Substring matching made "research" match
 * "search" and "sqlite" match a phantom SQL tool.
 */
function matchesTerm(normalizedQuery: string, candidate: string): boolean {
  const term = normalizeTerm(candidate);
  if (!term) return false;
  return normalizedQuery === term || ` ${normalizedQuery} `.includes(` ${term} `);
}

/**
 * Searches for existing capabilities matching a service or tool query.
 */
export function findExistingCapability(query: string): ExistingCapabilityMatch {
  const normalized = normalizeTerm(query);
  if (!normalized) return { covered: false };

  // 1. Check Native Built-in Tools
  for (const tool of NATIVE_TOOLS_CATALOG) {
    if (matchesTerm(normalized, tool.name) || tool.aliases.some(alias => matchesTerm(normalized, alias))) {
      return {
        covered: true,
        source: 'native_tool',
        matchName: tool.name,
        details: `Covered natively by built-in tool '${tool.name}': ${tool.description}`
      };
    }
  }

  // 2. Check Installed Plugins
  try {
    const plugins = listPlugins() as Array<{
      name: string;
      description?: string;
      enabled: boolean;
      tools?: string[];
    }>;

    for (const plugin of plugins) {
      if (matchesTerm(normalized, plugin.name)) {
        return {
          covered: true,
          source: 'plugin',
          matchName: plugin.name,
          details: `Covered by ${plugin.enabled ? 'active' : 'installed (disabled)'} plugin '${plugin.name}'. Tools: ${(plugin.tools || []).join(', ')}`
        };
      }
      if (Array.isArray(plugin.tools)) {
        for (const t of plugin.tools) {
          if (matchesTerm(normalized, t)) {
            return {
              covered: true,
              source: 'plugin',
              matchName: `${plugin.name} (${t})`,
              details: `Covered by tool '${t}' in plugin '${plugin.name}'`
            };
          }
        }
      }
    }
  } catch {
    // If plugins directory is uninitialized, proceed smoothly
  }

  // 3. Check Configured MCP Servers
  try {
    const servers = configuredServers();
    for (const s of servers) {
      if (matchesTerm(normalized, s.name)) {
        return {
          covered: true,
          source: 'mcp',
          matchName: s.name,
          details: `Covered by configured MCP server '${s.name}' (${s.url ? 'HTTP' : 'stdio'})`
        };
      }
    }
  } catch {
    // If MCP registry is not loaded, proceed smoothly
  }

  return { covered: false };
}
