import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { causyneHome } from '../utils/paths.js';
import { parsePluginSkills } from './pluginSkills.js';
import { isWithinPhysicalPath, physicalPath } from '../agent/workspaceBoundary.js';
import { isBlockedWorkspaceRoot } from '../sandboxPolicy.js';
import { redactProviderSecrets } from '../providers/byokHttp.js';
import { safeDisplay } from '../tui/text.js';
function pluginRoot() {
    return path.join(causyneHome(), 'plugins');
}
function stateFile() {
    return path.join(pluginRoot(), 'state.json');
}
const PLUGIN_ROOT = pluginRoot();
const STATE_FILE = stateFile();
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
const EXPORT_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CAPABILITIES = new Set([
    'workspace:read',
    'workspace:write',
    'network',
    'subprocess'
]);
function ensureRoot() {
    const root = pluginRoot();
    if (!fs.existsSync(root)) {
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    }
    else {
        const stat = fs.lstatSync(root);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error('Refusing symlink or non-directory plugin root');
        }
    }
    if (process.platform !== 'win32') {
        try {
            fs.chmodSync(root, 0o700);
        }
        catch { /* ignore */ }
    }
}
function safeObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
const MAX_STATE_BYTES = 1024 * 1024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function readState() {
    try {
        const sf = stateFile();
        const stat = fs.lstatSync(sf);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_STATE_BYTES) {
            return { version: 1, plugins: Object.create(null) };
        }
        const parsed = JSON.parse(fs.readFileSync(sf, 'utf8'));
        const rawPlugins = safeObject(parsed?.plugins);
        const clean = Object.create(null);
        for (const [key, val] of Object.entries(rawPlugins)) {
            if (!NAME.test(key) || FORBIDDEN_KEYS.has(key))
                continue;
            if (val && typeof val === 'object' && !Array.isArray(val)) {
                clean[key] = val;
            }
        }
        return { version: 1, plugins: clean };
    }
    catch {
        return { version: 1, plugins: Object.create(null) };
    }
}
function writeState(state) {
    ensureRoot();
    const sf = stateFile();
    try {
        const existing = fs.lstatSync(sf);
        if (existing.isSymbolicLink() || !existing.isFile()) {
            throw new Error('Refusing to overwrite symlink or non-regular plugin state file');
        }
    }
    catch (err) {
        const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
        if (code !== 'ENOENT')
            throw err;
    }
    const temporary = `${sf}.tmp_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
    const payload = Buffer.from(JSON.stringify(state, null, 2), 'utf8');
    try {
        const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
        try {
            fs.writeSync(fd, payload, 0, payload.length);
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temporary, sf);
        if (process.platform !== 'win32') {
            try {
                fs.chmodSync(sf, 0o600);
            }
            catch { /* ignore */ }
        }
    }
    catch (err) {
        try {
            if (fs.existsSync(temporary))
                fs.unlinkSync(temporary);
        }
        catch { /* ignore */ }
        throw err;
    }
}
function resolveInside(root, relativePath) {
    if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath)) {
        throw new Error(`Invalid plugin relative path: ${String(relativePath)}`);
    }
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(root, relativePath);
    if (resolved === resolvedRoot || !resolved.startsWith(resolvedRoot + path.sep)) {
        throw new Error(`Path escapes plugin root: ${relativePath}`);
    }
    const realRoot = physicalPath(resolvedRoot);
    const realTarget = physicalPath(resolved);
    if (!realRoot || !realTarget || realTarget === realRoot || !isWithinPhysicalPath(realTarget, realRoot)) {
        throw new Error(`Path escapes plugin root physically: ${relativePath}`);
    }
    return resolved;
}
function regularFile(file, maxBytes) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(`${file} must be a regular file`);
    if (stat.nlink > 1)
        throw new Error(`${file} must not be a hardlink`);
    if (stat.size > maxBytes)
        throw new Error(`${file} exceeds ${Math.round(maxBytes / 1024)} KB`);
    return stat;
}
const MAX_PLUGIN_DEPTH = 16;
function digestPluginDirectory(directory) {
    const files = [];
    let totalBytes = 0;
    const visit = (current, depth) => {
        if (depth > MAX_PLUGIN_DEPTH)
            throw new Error(`Plugin directory nesting exceeds ${MAX_PLUGIN_DEPTH}`);
        const entries = fs.readdirSync(current, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const absolute = path.join(current, entry.name);
            const stat = fs.lstatSync(absolute);
            if (stat.isSymbolicLink())
                throw new Error(`Plugin content must not be a symlink: ${entry.name}`);
            if (stat.isDirectory()) {
                visit(absolute, depth + 1);
                continue;
            }
            if (!stat.isFile())
                throw new Error(`Plugin content must be a regular file: ${entry.name}`);
            if (stat.nlink > 1)
                throw new Error(`Plugin content must not be a hardlink: ${entry.name}`);
            totalBytes += stat.size;
            if (totalBytes > MAX_PLUGIN_BYTES)
                throw new Error('Plugin exceeds 2 MB');
            files.push({ absolute, relative: path.relative(directory, absolute), size: stat.size });
            if (files.length > MAX_PLUGIN_FILES)
                throw new Error(`Plugin exceeds ${MAX_PLUGIN_FILES} files`);
        }
    };
    visit(directory, 0);
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
    if (values == null)
        return [];
    if (!Array.isArray(values))
        throw new Error(`${label} capabilities must be an array`);
    const unique = [];
    for (const value of values) {
        if (typeof value !== 'string' || !CAPABILITIES.has(value)) {
            throw new Error(`${label} requests unknown capability ${JSON.stringify(value)}`);
        }
        if (!unique.includes(value))
            unique.push(value);
    }
    if (unique.includes('workspace:write') && !unique.includes('workspace:read'))
        unique.unshift('workspace:read');
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
    const parsedManifest = JSON.parse(raw);
    if (!parsedManifest || typeof parsedManifest !== 'object' || Array.isArray(parsedManifest)) {
        throw new Error('Plugin manifest must be a JSON object');
    }
    const manifest = parsedManifest;
    const folderName = path.basename(directory);
    if (manifest.schemaVersion !== 1)
        throw new Error('schemaVersion must be 1');
    if (typeof manifest.name !== 'string' || !NAME.test(manifest.name) || manifest.name !== folderName) {
        throw new Error('Plugin name must match its lowercase folder name');
    }
    if (typeof manifest.version !== 'string' || !VERSION.test(manifest.version)) {
        throw new Error('Plugin version must use SemVer');
    }
    if (typeof manifest.description !== 'string' || !manifest.description.trim() || manifest.description.length > 2000) {
        throw new Error('Plugin description is required (max 2000 chars)');
    }
    const manifestTools = manifest.tools ?? [];
    if (!Array.isArray(manifestTools))
        throw new Error('Plugin tools must be an array');
    if (manifestTools.length > MAX_TOOLS_PER_PLUGIN) {
        throw new Error(`Plugin exceeds ${MAX_TOOLS_PER_PLUGIN} tools`);
    }
    const pluginCapabilities = validateCapabilities(manifest.capabilities, manifest.name);
    const names = new Set();
    const tools = manifestTools.map((tool) => {
        if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
            throw new Error('Plugin tool entry must be an object');
        }
        if (typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name)) {
            throw new Error(`Invalid tool name ${JSON.stringify(tool.name)}`);
        }
        if (names.has(tool.name))
            throw new Error(`Duplicate tool name ${tool.name}`);
        names.add(tool.name);
        if (typeof tool.description !== 'string' || !tool.description.trim()) {
            throw new Error(`Tool ${tool.name} needs a description`);
        }
        if (!tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters) || tool.parameters.type !== 'object') {
            throw new Error(`Tool ${tool.name} parameters must be an object JSON schema`);
        }
        const entry = resolveInside(directory, tool.entry);
        regularFile(entry, MAX_ENTRY_BYTES);
        const exportName = tool.export === undefined ? 'execute' : tool.export;
        if (typeof exportName !== 'string' || !EXPORT_IDENT.test(exportName) || FORBIDDEN_KEYS.has(exportName)) {
            throw new Error(`Tool ${tool.name} has invalid export name ${JSON.stringify(exportName)}`);
        }
        const capabilities = validateCapabilities(tool.capabilities ?? pluginCapabilities, `${manifest.name}/${tool.name}`);
        return {
            localName: tool.name,
            name: `plugin__${manifest.name.replace(/-/g, '_')}__${tool.name}`,
            description: tool.description.trim().slice(0, 1000),
            parameters: tool.parameters,
            entry,
            exportName,
            capabilities,
            timeoutMs: Number.isInteger(tool.timeoutMs)
                ? Math.max(1000, Math.min(tool.timeoutMs, 120_000))
                : DEFAULT_TIMEOUT_MS
        };
    });
    const skills = parsePluginSkills(directory, manifest.name, manifest.skills);
    if (tools.length === 0 && skills.length === 0) {
        throw new Error('Plugin must contribute at least one tool or skill');
    }
    return {
        directory,
        manifestFile,
        // Pin every byte the plugin subprocess may read, not only the manifest.
        // Otherwise an entry/helper could be replaced after review without
        // changing plugin.json and would inherit stale trust.
        digest: digestPluginDirectory(directory),
        manifest: { ...manifest, capabilities: pluginCapabilities },
        tools,
        skills
    };
}
function pluginDirectories() {
    try {
        ensureRoot();
        const root = pluginRoot();
        return fs.readdirSync(root, { withFileTypes: true })
            .filter((entry) => !entry.isSymbolicLink() && entry.isDirectory() && !entry.name.startsWith('.'))
            .map((entry) => path.join(root, entry.name))
            .sort();
    }
    catch {
        return [];
    }
}
export function listPlugins() {
    const state = readState();
    const rows = [];
    for (const directory of pluginDirectories()) {
        try {
            const plugin = readPlugin(directory);
            const trust = Object.hasOwn(state.plugins, plugin.manifest.name) ? safeObject(state.plugins[plugin.manifest.name]) : {};
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
                skills: plugin.skills.map((skill) => `${skill.domain}/${skill.id}`),
                path: plugin.directory
            });
        }
        catch (error) {
            rows.push({
                name: path.basename(directory),
                enabled: false,
                invalid: true,
                error: error instanceof Error ? error.message : String(error),
                path: directory
            });
        }
    }
    return rows;
}
export function enablePlugin(name) {
    if (typeof name !== 'string' || !NAME.test(name))
        return { ok: false, error: 'Invalid plugin name' };
    try {
        const plugin = readPlugin(resolveInside(pluginRoot(), name));
        const state = readState();
        state.plugins[name] = { enabled: true, digest: plugin.digest, enabledAt: Date.now() };
        writeState(state);
        return {
            ok: true,
            name,
            digest: plugin.digest,
            capabilities: plugin.manifest.capabilities,
            tools: plugin.tools.map((tool) => tool.name),
            skills: plugin.skills.map((skill) => `${skill.domain}/${skill.id}`)
        };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
export function disablePlugin(name) {
    if (typeof name !== 'string' || !NAME.test(name) || FORBIDDEN_KEYS.has(name)) {
        return { ok: false, error: 'Invalid plugin name' };
    }
    const state = readState();
    const current = Object.hasOwn(state.plugins, name) ? safeObject(state.plugins[name]) : {};
    state.plugins[name] = { ...current, enabled: false, disabledAt: Date.now() };
    writeState(state);
    return { ok: true, name };
}
export function createPlugin(input) {
    const safeInput = input && typeof input === 'object' ? input : {};
    const { name, description, toolName, toolDescription, parameters, code, capabilities = [] } = safeInput;
    if (typeof name !== 'string' || !NAME.test(name) || FORBIDDEN_KEYS.has(name)) {
        return { ok: false, error: 'Plugin name must use lowercase letters, digits, and hyphens' };
    }
    if (typeof toolName !== 'string' || !TOOL_NAME.test(toolName)) {
        return { ok: false, error: 'Tool name must start with a lowercase letter and use letters, digits, _ or -' };
    }
    if (typeof description !== 'string' || !description.trim() || description.length > 2000) {
        return { ok: false, error: 'Plugin description is required (max 2000 chars)' };
    }
    if (typeof toolDescription !== 'string' || !toolDescription.trim() || toolDescription.length > 1000) {
        return { ok: false, error: 'Tool description is required (max 1000 chars)' };
    }
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || parameters.type !== 'object') {
        return { ok: false, error: 'Tool parameters must be an object JSON schema' };
    }
    if (typeof code !== 'string' || !code.trim() || Buffer.byteLength(code, 'utf8') > MAX_ENTRY_BYTES) {
        return { ok: false, error: 'Plugin code is required and must be at most 512 KB' };
    }
    let safeCapabilities;
    try {
        safeCapabilities = validateCapabilities(capabilities, name);
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    ensureRoot();
    const directory = path.join(pluginRoot(), name);
    if (fs.existsSync(directory))
        return { ok: false, error: `Plugin ${name} already exists` };
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
    let created = false;
    try {
        fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
        created = true;
        fs.writeFileSync(path.join(directory, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        fs.writeFileSync(path.join(directory, entryName), source, { mode: 0o600, flag: 'wx' });
        readPlugin(directory);
        return {
            ok: true,
            name,
            path: directory,
            enabled: false,
            message: 'Plugin created disabled. Review its manifest and source, then enable it explicitly.'
        };
    }
    catch (error) {
        if (created) {
            try {
                fs.rmSync(directory, { recursive: true, force: true });
            }
            catch { /* ignore */ }
        }
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
export function createSkillPlugin(input) {
    const safeInput = input && typeof input === 'object' ? input : {};
    const { name, description, skillId, skillName, skillDescription, skillContent, licenseText } = safeInput;
    if (typeof name !== 'string' || !NAME.test(name) || FORBIDDEN_KEYS.has(name)) {
        return { ok: false, error: 'Invalid plugin name' };
    }
    if (typeof skillId !== 'string' || !NAME.test(skillId))
        return { ok: false, error: 'Invalid skill id' };
    if (typeof description !== 'string' || !description.trim() || description.length > 1000) {
        return { ok: false, error: 'Plugin description must be 1..1000 characters' };
    }
    if (typeof skillName !== 'string' || !skillName.trim() || skillName.length > 120) {
        return { ok: false, error: 'Skill name must be 1..120 characters' };
    }
    if (typeof skillDescription !== 'string' || !skillDescription.trim()
        || skillDescription.length > 400) {
        return { ok: false, error: 'Skill description must be 1..400 characters' };
    }
    if (typeof skillContent !== 'string' || !skillContent.trim() || skillContent.includes('\0')
        || Buffer.byteLength(skillContent, 'utf8') > 32 * 1024) {
        return { ok: false, error: 'Skill content must be nonempty and at most 32 KB' };
    }
    if (typeof licenseText !== 'string' || licenseText.includes('\0') || licenseText.length > 32 * 1024) {
        return { ok: false, error: 'Full third-party license text is required' };
    }
    const isMit = /^MIT License\s*$/mi.test(licenseText)
        && /Permission is hereby granted, free of charge/i.test(licenseText)
        && /above copyright notice/i.test(licenseText);
    const isApache = /Apache License\s*Version 2\.0/i.test(licenseText)
        && /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/i.test(licenseText);
    if (!isMit && !isApache) {
        return { ok: false, error: 'Only reviewed MIT or Apache-2.0 license text is accepted' };
    }
    const manifest = {
        schemaVersion: 1, name, version: '0.1.0', description: description.trim(),
        capabilities: [], tools: [],
        skills: [{
                id: skillId, name: skillName.trim(),
                description: skillDescription.trim(), file: 'SKILL.md'
            }]
    };
    ensureRoot();
    const directory = path.join(pluginRoot(), name);
    if (fs.existsSync(directory))
        return { ok: false, error: 'Plugin already exists' };
    let created = false;
    try {
        fs.mkdirSync(directory, { mode: 0o700 });
        created = true;
        fs.writeFileSync(path.join(directory, 'SKILL.md'), skillContent, {
            mode: 0o600, flag: 'wx'
        });
        fs.writeFileSync(path.join(directory, 'LICENSE'), licenseText, {
            mode: 0o600, flag: 'wx'
        });
        fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n', {
            mode: 0o600, flag: 'wx'
        });
        const reviewed = readPlugin(directory);
        return {
            ok: true, name, enabled: false, tools: [],
            skills: reviewed.skills.map(entry => entry.domain + '/' + entry.id),
            license: isMit ? 'MIT' : 'Apache-2.0',
            digest: reviewed.digest, path: directory,
            message: 'Skill packaged disabled. Review its instructions and license before explicit enablement.'
        };
    }
    catch (error) {
        if (created) {
            try {
                fs.rmSync(directory, { recursive: true, force: true });
            }
            catch { /* ignore */ }
        }
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
function enabledTools() {
    const state = readState();
    const tools = [];
    for (const directory of pluginDirectories()) {
        try {
            const plugin = readPlugin(directory);
            const trust = Object.hasOwn(state.plugins, plugin.manifest.name) ? safeObject(state.plugins[plugin.manifest.name]) : {};
            if (!trust.enabled || trust.digest !== plugin.digest)
                continue;
            for (const tool of plugin.tools)
                tools.push({ ...tool, plugin: plugin.manifest.name, pluginDirectory: directory });
        }
        catch {
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
/**
 * Reviewed, enabled plugins may contribute prompt-only skills. Discovery has
 * already parsed these as inert UTF-8 data; no plugin module is imported.
 */
export function getPluginSkills() {
    const state = readState();
    const skills = [];
    for (const directory of pluginDirectories()) {
        try {
            const plugin = readPlugin(directory);
            const trust = Object.hasOwn(state.plugins, plugin.manifest.name) ? safeObject(state.plugins[plugin.manifest.name]) : {};
            if (!trust.enabled || trust.digest !== plugin.digest)
                continue;
            skills.push(...plugin.skills);
        }
        catch {
            // Invalid or modified plugins contribute nothing to the prompt.
        }
    }
    return skills;
}
function permissionArgs(tool, workspaceRoots) {
    // Node resolves `.js` module type by walking to package.json. Grant that one
    // metadata file explicitly; granting the repository root would let an
    // extension read Causyne's entire source tree for no functional reason.
    const readable = [path.dirname(RUNNER_FILE), PACKAGE_FILE, tool.pluginDirectory];
    const writable = [];
    if (tool.capabilities.includes('workspace:read') || tool.capabilities.includes('workspace:write')) {
        for (const root of workspaceRoots) {
            if (!readable.includes(root))
                readable.push(root);
        }
    }
    if (tool.capabilities.includes('workspace:write')) {
        for (const root of workspaceRoots) {
            if (!writable.includes(root))
                writable.push(root);
        }
    }
    // Repeat the flag. Comma-joining paths is parsed as one literal path by
    // Node's permission model on current releases.
    const args = ['--permission', ...readable.map((entry) => `--allow-fs-read=${entry}`)];
    if (writable.length > 0) {
        args.push(...writable.map((entry) => `--allow-fs-write=${entry}`));
    }
    if (tool.capabilities.includes('network'))
        args.push('--allow-net');
    if (tool.capabilities.includes('subprocess'))
        args.push('--allow-child-process');
    return args;
}
async function runPluginTool(tool, args, context) {
    // Re-verify trust and whole-directory digest immediately before spawning to
    // close TOCTOU tampering between tool resolution and execution.
    try {
        const state = readState();
        const trust = Object.hasOwn(state.plugins, tool.plugin) ? safeObject(state.plugins[tool.plugin]) : {};
        const fresh = readPlugin(tool.pluginDirectory);
        if (!trust.enabled || trust.digest !== fresh.digest) {
            return { success: false, error: 'Plugin trust revoked or modified before execution' };
        }
    }
    catch (verifyErr) {
        return {
            success: false,
            error: `Plugin integrity check failed: ${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`
        };
    }
    const rawWorkspace = context?.workspaceRoot || context?.workspacePaths?.[0] || process.cwd();
    if (typeof rawWorkspace !== 'string' || !rawWorkspace.trim() || rawWorkspace.includes('\0')) {
        return { success: false, error: 'Invalid workspace root for plugin execution' };
    }
    const workspaceRoot = path.resolve(rawWorkspace);
    if (isBlockedWorkspaceRoot(workspaceRoot)) {
        return { success: false, error: 'Refusing plugin execution on a blocked system root' };
    }
    const realWorkspaceRoot = physicalPath(workspaceRoot) || workspaceRoot;
    const workspacePermissionRoots = realWorkspaceRoot === workspaceRoot
        ? [workspaceRoot]
        : [workspaceRoot, realWorkspaceRoot];
    // Resolve filesystem aliases before handing paths to Node's permission
    // model. On macOS, /var and /tmp are symlinks into /private; authorizing the
    // alias while the module loader opens the canonical target causes a false
    // denial even though both names identify the same reviewed plugin file.
    const runtimeTool = {
        ...tool,
        entry: fs.realpathSync(tool.entry),
        pluginDirectory: fs.realpathSync(tool.pluginDirectory)
    };
    if (runtimeTool.entry === runtimeTool.pluginDirectory || !isWithinPhysicalPath(runtimeTool.entry, runtimeTool.pluginDirectory)) {
        return { success: false, error: 'Refusing plugin entry outside its canonical plugin directory' };
    }
    const childArgs = [
        ...permissionArgs(runtimeTool, workspacePermissionRoots),
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
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            finish({ success: false, error: `Plugin timed out after ${runtimeTool.timeoutMs} ms` });
        }, runtimeTool.timeoutMs);
        if (timer.unref)
            timer.unref();
        child.stdout.on('data', (chunk) => {
            stdout += String(chunk);
            if (Buffer.byteLength(stdout, 'utf8') > MAX_RESULT_BYTES) {
                child.kill('SIGTERM');
                finish({ success: false, error: 'Plugin result exceeded 1 MB' });
            }
        });
        child.stderr.on('data', (chunk) => {
            stderr = (stderr + String(chunk)).slice(-16_000);
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
            }
            catch (error) {
                finish({ success: false, error: `Plugin returned invalid JSON: ${error instanceof Error ? error.message : String(error)}` });
            }
        });
        child.stdin.end(payload);
    });
}
export function resolvePluginTool(name) {
    const tool = enabledTools().find((candidate) => candidate.name === name);
    if (!tool)
        return null;
    return {
        schema: { name: tool.name, description: tool.description, parameters: tool.parameters },
        execute: (args, context = {}) => runPluginTool(tool, args, context)
    };
}
export { PLUGIN_ROOT, STATE_FILE, CAPABILITIES };
