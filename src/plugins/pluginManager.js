import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { causyneHome } from '../utils/paths.js';

const PLUGIN_ROOT = path.join(causyneHome(), 'plugins');
const STATE_FILE = path.join(PLUGIN_ROOT, 'state.json');
const RUNNER_FILE = fileURLToPath(new URL('./pluginRunner.js', import.meta.url));
const PACKAGE_FILE = fileURLToPath(new URL('../../package.json', import.meta.url));
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ENTRY_BYTES = 512 * 1024;
const MAX_PLUGIN_BYTES = 2 * 1024 * 1024;
const MAX_PLUGIN_FILES = 128;
const MAX_TOOLS_PER_PLUGIN = 32;
const MAX_RESULT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOOL_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CAPABILITIES = new Set([
  'workspace:read',
  'workspace:write',
  'network',
  'subprocess'
]);

function ensureRoot() {
  if (!fs.existsSync(PLUGIN_ROOT)) fs.mkdirSync(PLUGIN_ROOT, { recursive: true, mode: 0o700 });
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { version: 1, plugins: {} };
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { version: 1, plugins: safeObject(parsed.plugins) };
  } catch (error) {
    return { version: 1, plugins: {} };
  }
}

function writeState(state) {
  ensureRoot();
  const temporary = `${STATE_FILE}.tmp_${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, STATE_FILE);
}

function resolveInside(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, String(relativePath || ''));
  if (resolved === resolvedRoot || !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path escapes plugin root: ${relativePath}`);
  }
  return resolved;
}

function regularFile(file, maxBytes) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${file} must be a regular file`);
  if (stat.size > maxBytes) throw new Error(`${file} exceeds ${Math.round(maxBytes / 1024)} KB`);
  return stat;
}

function digestPluginDirectory(directory) {
  const files = [];
  const visit = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Plugin content must not be a symlink: ${entry.name}`);
      if (stat.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Plugin content must be a regular file: ${entry.name}`);
      files.push({ absolute, relative: path.relative(directory, absolute), size: stat.size });
      if (files.length > MAX_PLUGIN_FILES) throw new Error(`Plugin exceeds ${MAX_PLUGIN_FILES} files`);
    }
  };
  visit(directory);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_PLUGIN_BYTES) throw new Error('Plugin exceeds 2 MB');

  const digest = crypto.createHash('sha256');
  for (const file of files) {
    digest.update(file.relative);
    digest.update('\0');
    digest.update(fs.readFileSync(file.absolute));
    digest.update('\0');
  }
  return digest.digest('hex');
}

function validateCapabilities(values, label) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new Error(`${label} capabilities must be an array`);
  const unique = [];
  for (const value of values) {
    if (!CAPABILITIES.has(value)) throw new Error(`${label} requests unknown capability ${JSON.stringify(value)}`);
    if (!unique.includes(value)) unique.push(value);
  }
  if (unique.includes('workspace:write') && !unique.includes('workspace:read')) unique.unshift('workspace:read');
  return unique;
}

function readPlugin(directory) {
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('Plugin directory must not be a symlink');
  }

  const manifestFile = path.join(directory, 'plugin.json');
  regularFile(manifestFile, MAX_MANIFEST_BYTES);
  const raw = fs.readFileSync(manifestFile, 'utf8');
  const manifest = JSON.parse(raw);
  const folderName = path.basename(directory);

  if (manifest.schemaVersion !== 1) throw new Error('schemaVersion must be 1');
  if (!NAME.test(manifest.name || '') || manifest.name !== folderName) {
    throw new Error('Plugin name must match its lowercase folder name');
  }
  if (!VERSION.test(manifest.version || '')) throw new Error('Plugin version must use SemVer');
  if (typeof manifest.description !== 'string' || !manifest.description.trim()) {
    throw new Error('Plugin description is required');
  }
  if (!Array.isArray(manifest.tools)) throw new Error('Plugin tools must be an array');
  if (manifest.tools.length > MAX_TOOLS_PER_PLUGIN) {
    throw new Error(`Plugin exceeds ${MAX_TOOLS_PER_PLUGIN} tools`);
  }

  const pluginCapabilities = validateCapabilities(manifest.capabilities, manifest.name);
  const names = new Set();
  const tools = manifest.tools.map((tool) => {
    if (!TOOL_NAME.test(tool?.name || '')) throw new Error(`Invalid tool name ${JSON.stringify(tool?.name)}`);
    if (names.has(tool.name)) throw new Error(`Duplicate tool name ${tool.name}`);
    names.add(tool.name);
    if (typeof tool.description !== 'string' || !tool.description.trim()) {
      throw new Error(`Tool ${tool.name} needs a description`);
    }
    if (!tool.parameters || tool.parameters.type !== 'object') {
      throw new Error(`Tool ${tool.name} parameters must be an object JSON schema`);
    }
    const entry = resolveInside(directory, tool.entry);
    regularFile(entry, MAX_ENTRY_BYTES);
    const capabilities = validateCapabilities(tool.capabilities ?? pluginCapabilities, `${manifest.name}/${tool.name}`);
    return {
      localName: tool.name,
      name: `plugin__${manifest.name.replace(/-/g, '_')}__${tool.name}`,
      description: tool.description.trim().slice(0, 1000),
      parameters: tool.parameters,
      entry,
      exportName: typeof tool.export === 'string' && tool.export ? tool.export : 'execute',
      capabilities,
      timeoutMs: Number.isInteger(tool.timeoutMs)
        ? Math.max(1000, Math.min(tool.timeoutMs, 120_000))
        : DEFAULT_TIMEOUT_MS
    };
  });

  return {
    directory,
    manifestFile,
    // Pin every byte the plugin subprocess may read, not only the manifest.
    // Otherwise an entry/helper could be replaced after review without
    // changing plugin.json and would inherit stale trust.
    digest: digestPluginDirectory(directory),
    manifest: { ...manifest, capabilities: pluginCapabilities },
    tools
  };
}

function pluginDirectories() {
  ensureRoot();
  return fs.readdirSync(PLUGIN_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(PLUGIN_ROOT, entry.name))
    .sort();
}

export function listPlugins() {
  const state = readState();
  const rows = [];
  for (const directory of pluginDirectories()) {
    try {
      const plugin = readPlugin(directory);
      const trust = safeObject(state.plugins[plugin.manifest.name]);
      const modified = Boolean(trust.enabled && trust.digest !== plugin.digest);
      rows.push({
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        description: plugin.manifest.description,
        enabled: Boolean(trust.enabled && !modified),
        modified,
        digest: plugin.digest,
        capabilities: plugin.manifest.capabilities,
        tools: plugin.tools.map((tool) => tool.name),
        path: plugin.directory
      });
    } catch (error) {
      rows.push({ name: path.basename(directory), enabled: false, invalid: true, error: error.message, path: directory });
    }
  }
  return rows;
}

export function enablePlugin(name) {
  if (!NAME.test(name || '')) return { ok: false, error: 'Invalid plugin name' };
  try {
    const plugin = readPlugin(resolveInside(PLUGIN_ROOT, name));
    const state = readState();
    state.plugins[name] = { enabled: true, digest: plugin.digest, enabledAt: Date.now() };
    writeState(state);
    return { ok: true, name, digest: plugin.digest, capabilities: plugin.manifest.capabilities, tools: plugin.tools.map((tool) => tool.name) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function disablePlugin(name) {
  const state = readState();
  const current = safeObject(state.plugins[name]);
  state.plugins[name] = { ...current, enabled: false, disabledAt: Date.now() };
  writeState(state);
  return { ok: true, name };
}

export function createPlugin({ name, description, toolName, toolDescription, parameters, code, capabilities = [] }) {
  if (!NAME.test(name || '')) return { ok: false, error: 'Plugin name must use lowercase letters, digits, and hyphens' };
  if (!TOOL_NAME.test(toolName || '')) return { ok: false, error: 'Tool name must start with a lowercase letter and use letters, digits, _ or -' };
  if (typeof description !== 'string' || !description.trim()) return { ok: false, error: 'Plugin description is required' };
  if (typeof toolDescription !== 'string' || !toolDescription.trim()) return { ok: false, error: 'Tool description is required' };
  if (!parameters || parameters.type !== 'object') return { ok: false, error: 'Tool parameters must be an object JSON schema' };
  if (typeof code !== 'string' || !code.trim()) return { ok: false, error: 'Plugin code is required' };

  let safeCapabilities;
  try {
    safeCapabilities = validateCapabilities(capabilities, name);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  ensureRoot();
  const directory = path.join(PLUGIN_ROOT, name);
  if (fs.existsSync(directory)) return { ok: false, error: `Plugin ${name} already exists` };

  const entryName = `${toolName}.js`;
  const manifest = {
    schemaVersion: 1,
    name,
    version: '0.1.0',
    description: description.trim(),
    capabilities: safeCapabilities,
    tools: [{
      name: toolName,
      description: toolDescription.trim(),
      parameters,
      entry: entryName,
      export: 'execute'
    }]
  };
  const trimmedCode = code.trim();
  const source = trimmedCode.startsWith('export ')
    ? trimmedCode
    : trimmedCode.startsWith('async ') || trimmedCode.startsWith('(async ')
      ? `export const execute = ${trimmedCode};\n`
      : `export async function execute(args, context) {\n${trimmedCode}\n}\n`;

  try {
    fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(directory, entryName), source, { mode: 0o600 });
    return {
      ok: true,
      name,
      path: directory,
      enabled: false,
      message: 'Plugin created disabled. Review its manifest and source, then enable it explicitly.'
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function enabledTools() {
  const state = readState();
  const tools = [];
  for (const directory of pluginDirectories()) {
    try {
      const plugin = readPlugin(directory);
      const trust = safeObject(state.plugins[plugin.manifest.name]);
      if (!trust.enabled || trust.digest !== plugin.digest) continue;
      for (const tool of plugin.tools) tools.push({ ...tool, plugin: plugin.manifest.name, pluginDirectory: directory });
    } catch (error) {
      // Invalid plugins are visible through listPlugins(), never through the model.
    }
  }
  return tools;
}

export function getPluginToolDefinitions() {
  return enabledTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    xCausyneDeferred: true
  }));
}

function permissionArgs(tool, workspaceRoot) {
  // Node resolves `.js` module type by walking to package.json. Grant that one
  // metadata file explicitly; granting the repository root would let an
  // extension read Causyne's entire source tree for no functional reason.
  const readable = [path.dirname(RUNNER_FILE), PACKAGE_FILE, tool.pluginDirectory];
  const writable = [];
  if (tool.capabilities.includes('workspace:read') || tool.capabilities.includes('workspace:write')) {
    readable.push(workspaceRoot);
  }
  if (tool.capabilities.includes('workspace:write')) writable.push(workspaceRoot);

  // Repeat the flag. Comma-joining paths is parsed as one literal path by
  // Node's permission model on current releases.
  const args = ['--permission', ...readable.map((entry) => `--allow-fs-read=${entry}`)];
  if (writable.length > 0) {
    args.push(...writable.map((entry) => `--allow-fs-write=${entry}`));
  }
  if (tool.capabilities.includes('network')) args.push('--allow-net');
  if (tool.capabilities.includes('subprocess')) args.push('--allow-child-process');
  return args;
}

async function runPluginTool(tool, args, context) {
  const workspaceRoot = path.resolve(context?.workspaceRoot || context?.workspacePaths?.[0] || process.cwd());
  // Resolve filesystem aliases before handing paths to Node's permission
  // model. On macOS, /var and /tmp are symlinks into /private; authorizing the
  // alias while the module loader opens the canonical target causes a false
  // denial even though both names identify the same reviewed plugin file.
  const runtimeTool = {
    ...tool,
    entry: fs.realpathSync(tool.entry),
    pluginDirectory: fs.realpathSync(tool.pluginDirectory)
  };
  const childArgs = [
    ...permissionArgs(runtimeTool, workspaceRoot),
    RUNNER_FILE,
    runtimeTool.entry,
    runtimeTool.exportName
  ];
  const payload = JSON.stringify({
    args: safeObject(args),
    context: {
      workspaceRoot,
      pluginRoot: runtimeTool.pluginDirectory,
      capabilities: runtimeTool.capabilities
    }
  });

  return new Promise((resolve) => {
    const child = spawn(process.execPath, childArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '',
        LANG: process.env.LANG || 'C.UTF-8',
        TMPDIR: process.env.TMPDIR || ''
      }
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ success: false, error: `Plugin timed out after ${runtimeTool.timeoutMs} ms` });
    }, runtimeTool.timeoutMs);
    if (timer.unref) timer.unref();

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > MAX_RESULT_BYTES) {
        child.kill('SIGTERM');
        finish({ success: false, error: 'Plugin result exceeded 1 MB' });
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-16_000);
    });
    child.on('error', (error) => finish({ success: false, error: error.message }));
    child.on('close', () => {
      const line = stdout.split(/\r?\n/).find((value) => value.startsWith('CAUSYNE_PLUGIN_RESULT:'));
      if (!line) {
        finish({ success: false, error: stderr.trim() || 'Plugin returned no structured result' });
        return;
      }
      try {
        finish(JSON.parse(line.slice('CAUSYNE_PLUGIN_RESULT:'.length)));
      } catch (error) {
        finish({ success: false, error: `Plugin returned invalid JSON: ${error.message}` });
      }
    });
    child.stdin.end(payload);
  });
}

export function resolvePluginTool(name) {
  const tool = enabledTools().find((candidate) => candidate.name === name);
  if (!tool) return null;
  return {
    schema: { name: tool.name, description: tool.description, parameters: tool.parameters },
    execute: (args, context = {}) => runPluginTool(tool, args, context)
  };
}

export { PLUGIN_ROOT, STATE_FILE, CAPABILITIES };
