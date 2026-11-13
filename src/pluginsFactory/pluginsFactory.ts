/**
 * PluginsFactory — Autonomous Custom Integration Engine for Causyne Agent.
 *
 * Engineered in strict TypeScript.
 *
 * Responsibilities:
 * 1. Evaluate missing integration needs and assess the most token-lean and cost-effective route:
 *    - Route 1 (Native HTTP/CLI): Lowest token consumption and immediate on-demand execution.
 *    - Route 2 (Python Bridge): On-demand subprocess buffer for Python-only libraries.
 *    - Route 3 (MCP Server): Standard protocol for MCP-only services or when requested by user.
 * 2. Enforce token transparency: Disclose MCP token footprint overhead honestly, while completely
 *    honoring user preferences when MCP is chosen.
 * 3. Scaffold production-grade plugins and servers in ~/.causyne/ (never shipped inside the npm package).
 * 4. Maintain security invariants: Plugins are created disabled; MCP servers are created ungranted;
 *    SHA-256 integrity digests are calculated and recorded.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from '../utils/paths.js';
import { assessRoute } from './strategy.js';
import {
  generateCliPluginScaffold,
  generateHttpPluginScaffold,
  generateMcpServerScaffold,
  generatePythonBridgeScaffold
} from './templates.js';
import type {
  FactoryRouteProposal,
  PluginFactoryOptions,
  RouteKind,
  ScaffoldOptions,
  ScaffoldResult,
  ServiceDescriptor,
  ServiceToolDescriptor
} from './types.js';

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_TOOLS = 32;
const CAPABILITIES = new Set(['workspace:read', 'workspace:write', 'network', 'subprocess']);

/**
 * Computes the exact SHA-256 directory digest matching Causyne's pluginManager.
 */
export function computePluginDirectoryDigest(directory: string): string {
  interface FileEntry {
    absolute: string;
    relative: string;
  }
  const files: FileEntry[] = [];

  const visit = (current: string) => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`Plugin file must not be a symlink: ${entry.name}`);
      }
      if (stat.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (stat.isFile()) {
        files.push({ absolute, relative: path.relative(directory, absolute) });
      }
    }
  };

  visit(directory);

  const digest = crypto.createHash('sha256');
  for (const file of files) {
    digest.update(file.relative);
    digest.update('\0');
    digest.update(fs.readFileSync(file.absolute));
    digest.update('\0');
  }

  return digest.digest('hex');
}

/**
 * PluginsFactory core engine.
 */
export class PluginsFactory {
  private readonly pluginsRoot: string;
  private readonly mcpServersRoot: string;

  constructor(options: PluginFactoryOptions = {}) {
    const baseHome = causyneHome();
    this.pluginsRoot = options.pluginsDir
      ? path.resolve(options.pluginsDir)
      : path.join(baseHome, 'plugins');
    this.mcpServersRoot = options.mcpServersDir
      ? path.resolve(options.mcpServersDir)
      : path.join(baseHome, 'mcp-servers');
  }

  /**
   * Evaluates the service and generates an actionable route proposal with cost estimates.
   */
  assess(service: ServiceDescriptor, userPreference?: RouteKind): FactoryRouteProposal {
    return assessRoute(service, userPreference);
  }

  /**
   * Scaffolds the integration into ~/.causyne/plugins or ~/.causyne/mcp-servers.
   */
  async scaffold(
    proposal: FactoryRouteProposal,
    options: ScaffoldOptions = {}
  ): Promise<ScaffoldResult> {
    const service = proposal.service;
    const normalizedName = service.name.trim().toLowerCase();

    if (!NAME_PATTERN.test(normalizedName)) {
      return {
        success: false,
        route: proposal.recommendedRoute,
        targetDirectory: '',
        createdFiles: [],
        instructions: '',
        error: `Invalid service name "${service.name}". Must match ^[a-z0-9][a-z0-9-]{0,63}$`
      };
    }

    const normalizedService: ServiceDescriptor = { ...service, name: normalizedName };
    const route = proposal.userConfirmedRoute ?? proposal.recommendedRoute;
    if (route !== 'native_plugin' && route !== 'python_bridge' && route !== 'mcp_server') {
      return {
        success: false,
        route,
        targetDirectory: '',
        createdFiles: [],
        instructions: '',
        error: `Unsupported route "${String(route)}".`
      };
    }
    const isMcp = route === 'mcp_server';

    const toolError = this.validateTools(service.tools);
    if (toolError) {
      return {
        success: false,
        route,
        targetDirectory: '',
        createdFiles: [],
        instructions: '',
        error: toolError
      };
    }

    const capabilityError = this.validateCapabilities(service.capabilities || []);
    if (capabilityError) {
      return {
        success: false,
        route,
        targetDirectory: '',
        createdFiles: [],
        instructions: '',
        error: capabilityError
      };
    }

    const baseDir = options.baseDir
      ? path.resolve(options.baseDir)
      : isMcp
      ? this.mcpServersRoot
      : this.pluginsRoot;

    const targetDir = path.join(baseDir, normalizedName);

    // Path containment check: ensure targetDir cannot escape baseDir
    const resolvedBase = path.resolve(baseDir);
    const resolvedTarget = path.resolve(targetDir);
    if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
      return {
        success: false,
        route,
        targetDirectory: targetDir,
        createdFiles: [],
        instructions: '',
        error: `Target path escapes directory boundary: ${targetDir}`
      };
    }

    if (fs.existsSync(targetDir) && !options.force) {
      return {
        success: false,
        route,
        targetDirectory: targetDir,
        createdFiles: [],
        instructions: '',
        error: `Directory already exists: ${targetDir}. Use force: true to overwrite.`
      };
    }

    // Select scaffolding payload generator based on route
    let payload;
    if (route === 'native_plugin') {
      if (service.serviceKind === 'cli' || service.cliBinary) {
        payload = generateCliPluginScaffold(normalizedService);
      } else {
        payload = generateHttpPluginScaffold(normalizedService);
      }
    } else if (route === 'python_bridge') {
      payload = generatePythonBridgeScaffold(normalizedService);
    } else {
      payload = generateMcpServerScaffold(normalizedService);
    }

    if (options.dryRun) {
      return {
        success: true,
        route,
        targetDirectory: targetDir,
        createdFiles: payload.files.map(f => f.relativePath),
        instructions: `[Dry Run] Scaffolding plan ready for ${normalizedName} at ${targetDir}`
      };
    }

    // Write files to target directory
    const createdRoot = !fs.existsSync(targetDir);
    const createdFiles: string[] = [];

    try {
      fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
      for (const file of payload.files) {
        const filePath = path.join(targetDir, file.relativePath);
        const fileDir = path.dirname(filePath);
        if (!fs.existsSync(fileDir)) {
          fs.mkdirSync(fileDir, { recursive: true, mode: 0o700 });
        }
        fs.writeFileSync(filePath, file.content, { encoding: 'utf8', mode: 0o600 });
        createdFiles.push(file.relativePath);
      }
    } catch (err) {
      if (createdRoot) {
        try {
          fs.rmSync(targetDir, { recursive: true, force: true });
        } catch {
          // Preserve the original write failure.
        }
      }
      return {
        success: false,
        route,
        targetDirectory: targetDir,
        createdFiles: [],
        instructions: '',
        error: `Failed to scaffold ${normalizedName}: ${err instanceof Error ? err.message : String(err)}`
      };
    }

    let digest: string | undefined;
    let instructions: string;

    if (!isMcp) {
      // Calculate plugin digest
      digest = computePluginDirectoryDigest(targetDir);

      // Record disabled state in state.json
      this.recordPluginState(normalizedName, digest);

      instructions = [
        `Custom plugin '${normalizedName}' successfully scaffolded at: ${targetDir}`,
        `Kind: ${route === 'python_bridge' ? 'Python Bridge Plugin' : 'Native Plugin'}`,
        `Digest (SHA-256): ${digest}`,
        `Security Status: DISABLED (Review source files before enabling)`,
        '',
        `To activate after review:`,
        `  causyne plugins enable ${normalizedName}`,
        `  (or in chat: /plugins enable ${normalizedName})`
      ].join('\n');
    } else {
      instructions = [
        `MCP Server '${normalizedName}' successfully scaffolded at: ${targetDir}`,
        `Kind: Model Context Protocol stdio server`,
        `Security Status: UNGRANTED (Review source files before granting)`,
        '',
        `To register and grant:`,
        `  causyne mcp add ${normalizedName} node ${path.join(targetDir, 'server.js')}`,
        `  causyne mcp grant ${normalizedName}`,
        `  (or in chat: /mcp grant ${normalizedName})`
      ].join('\n');
    }

    const result: ScaffoldResult = {
      success: true,
      route,
      targetDirectory: targetDir,
      createdFiles,
      instructions
    };
    if (digest !== undefined) {
      result.digest = digest;
    }
    return result;
  }

  /**
   * Rejects descriptors that the plugin loader would refuse after the factory
   * has already written files and recorded a digest.
   */
  private validateTools(tools: ServiceToolDescriptor[]): string | null {
    if (tools.length > MAX_TOOLS) {
      return `Plugin exceeds ${MAX_TOOLS} tools.`;
    }
    const seen = new Set<string>();
    for (const tool of tools) {
      if (!TOOL_NAME_PATTERN.test(tool.name)) {
        return `Invalid tool name "${tool.name}". Must match ^[a-z][a-z0-9_-]{0,63}$`;
      }
      if (seen.has(tool.name)) {
        return `Duplicate tool name "${tool.name}".`;
      }
      seen.add(tool.name);
      if (!tool.parameters || tool.parameters.type !== 'object') {
        return `Tool "${tool.name}" parameters must be an object JSON schema.`;
      }
    }
    return null;
  }

  private validateCapabilities(capabilities: string[]): string | null {
    for (const capability of capabilities) {
      if (!CAPABILITIES.has(capability)) {
        return `Unknown capability "${capability}".`;
      }
    }
    return null;
  }

  /**
   * Ensures state.json records the newly scaffolded plugin as disabled.
   */
  private recordPluginState(pluginName: string, digest: string): void {
    try {
      if (!fs.existsSync(this.pluginsRoot)) {
        fs.mkdirSync(this.pluginsRoot, { recursive: true, mode: 0o700 });
      }
      const stateFile = path.join(this.pluginsRoot, 'state.json');
      let state: { version: number; plugins: Record<string, { enabled: boolean; digest?: string }> } = {
        version: 1,
        plugins: {}
      };

      if (fs.existsSync(stateFile)) {
        try {
          const raw = fs.readFileSync(stateFile, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            state = { version: 1, plugins: parsed.plugins || {} };
          }
        } catch {
          // ignore corrupted state
        }
      }

      state.plugins[pluginName] = {
        enabled: false,
        digest
      };

      const tmp = `${stateFile}.tmp_${process.pid}_${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, stateFile);
    } catch {
      // Graceful fallback if plugins directory is mock or read-only
    }
  }
}

/**
 * Top-level convenience function for evaluating route.
 */
export function assessPluginRoute(
  service: ServiceDescriptor,
  userPreference?: RouteKind
): FactoryRouteProposal {
  const factory = new PluginsFactory();
  return factory.assess(service, userPreference);
}

/**
 * Top-level convenience function for scaffolding.
 */
export async function scaffoldPlugin(
  proposal: FactoryRouteProposal,
  options?: ScaffoldOptions
): Promise<ScaffoldResult> {
  const factory = new PluginsFactory();
  return factory.scaffold(proposal, options);
}
