import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import util from 'node:util';
import { causyneHome } from '../utils/paths.js';
import { sanitizeSubprocessEnv } from './subprocessEnv.js';
import { getErrorMessage, resolveToolWorkspaceRoots, sanitizeToolError, sanitizeToolText } from './toolPathSafety.js';
const PIP_HIJACK_ENV_KEYS = [
    'PIP_INDEX_URL',
    'PIP_EXTRA_INDEX_URL',
    'PIP_FIND_LINKS',
    'PIP_TRUSTED_HOST',
    'PIP_CONFIG_FILE',
    'PYTHONSTARTUP'
];
function buildSafePipEnv() {
    const env = sanitizeSubprocessEnv(process.env);
    for (const key of PIP_HIJACK_ENV_KEYS) {
        delete env[key];
    }
    return env;
}
function assertNotSymlinkIfExists(targetPath, label) {
    try {
        const stat = fs.lstatSync(targetPath);
        if (stat.isSymbolicLink()) {
            throw new Error(`Refusing to use symlinked ${label}: ${targetPath}`);
        }
    }
    catch (err) {
        if (err?.code === 'ENOENT')
            return;
        throw err;
    }
}
const execFilePromise = util.promisify(execFile);
const PYPI_PIN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?==[A-Za-z0-9][A-Za-z0-9._+!-]*$/;
export function isExactPyPiPin(value) {
    return typeof value === 'string' && value.length <= 200 && PYPI_PIN.test(value);
}
async function findInstalledEngine(engine) {
    if (engine !== 'godot' && engine !== 'blender')
        return null;
    const causyneEngineDir = path.join(causyneHome(), 'engines', engine);
    const isWindows = process.platform === 'win32';
    const possiblePaths = engine === 'godot' ? [
        path.join(causyneEngineDir, isWindows ? 'Godot.exe' : 'godot'),
        '/Applications/Godot.app/Contents/MacOS/Godot',
        isWindows ? 'C:\\Program Files\\Godot\\Godot.exe' : '/usr/bin/godot',
        '/usr/local/bin/godot'
    ] : [
        path.join(causyneEngineDir, isWindows ? 'blender.exe' : 'blender'),
        '/Applications/Blender.app/Contents/MacOS/Blender',
        isWindows ? 'C:\\Program Files\\Blender Foundation\\Blender\\blender.exe' : '/usr/bin/blender',
        '/usr/local/bin/blender'
    ];
    for (const p of possiblePaths) {
        if (fs.existsSync(p))
            return p;
    }
    try {
        const locator = isWindows ? 'where.exe' : 'which';
        const { stdout } = await execFilePromise(locator, [engine], {
            timeout: 5000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            env: sanitizeSubprocessEnv(process.env)
        });
        const trimmed = (stdout.trim().split('\n')[0] ?? '').trim();
        if (trimmed && fs.existsSync(trimmed))
            return trimmed;
    }
    catch { /* ignore */ }
    return null;
}
export const manageLocalDependencies = {
    schema: {
        name: 'manage_local_dependencies',
        description: 'Optional local capability manager. It can create a workspace Python environment, install explicitly pinned PyPI packages after approval, check for existing Godot/Blender installations, and grant reviewed capability groups.',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['setup_venv', 'pipInst', 'check_and_setupEng', 'grant_capability', 'list_capabilities', 'grant_mcp_server', 'list_mcp_servers'] },
                group: { type: 'string', description: 'Capability group for grant_capability: browser (dedicated Causyne Browser runtime), vision (screen capture), ocr (read text from images), system (process and load inspection), desktop (clipboard, open, recycle bin), archive (zip and unzip).' },
                engine: { type: 'string', enum: ['godot', 'blender'], description: 'Engine to locate when action is check_and_setupEng' },
                simulateMissing: { type: 'boolean', description: 'Simulate missing binary to verify sovereign fallback cascade' },
                packages: { type: 'array', items: { type: 'string' }, description: 'Exact PyPI pins only, for example pillow==11.3.0. URLs, paths, VCS references and pip options are rejected.' }
            },
            required: ['action']
        }
    },
    execute: async (args = {}, sandbox) => {
        try {
            const { action, engine, simulateMissing, packages, group } = args || {};
            if (action === 'list_capabilities') {
                const { GROUP_NAMES, GROUP_DESCRIPTIONS, groupStatus } = await import('../provisioning/capabilityProvisioner.js');
                return {
                    success: true,
                    output: JSON.stringify(GROUP_NAMES.map((name) => ({
                        group: name,
                        grants: GROUP_DESCRIPTIONS[name],
                        status: groupStatus(name).state
                    })), null, 2)
                };
            }
            if (action === 'list_mcp_servers') {
                const { serverStatus } = await import('../mcp/mcpRegistry.js');
                const servers = serverStatus();
                return {
                    success: true,
                    output: servers.length === 0
                        ? 'No MCP servers are configured. The user adds them to the "mcpServers" array in ~/.causyne/config.json.'
                        : JSON.stringify(servers, null, 2)
                };
            }
            if (action === 'grant_mcp_server') {
                const { configuredServers, grantServer, connectServer } = await import('../mcp/mcpRegistry.js');
                const target = group;
                const known = configuredServers().map((s) => s.name);
                if (!target || !known.includes(target)) {
                    return {
                        success: false,
                        error: known.length === 0
                            ? 'No MCP servers are configured. Only the user can add one, in ~/.causyne/config.json.'
                            : `Unknown MCP server "${String(target ?? '')}". Configured servers: ${known.join(', ')}.`
                    };
                }
                const grantRes = grantServer(target);
                if (!grantRes.ok) {
                    return { success: false, error: sanitizeToolText(grantRes.error || `Could not enable MCP server "${target}".`, 400) };
                }
                try {
                    const client = await connectServer(target);
                    return {
                        success: true,
                        output: `MCP server "${sanitizeToolText(target, 80)}" is enabled and exposed ${client.tools.length} tools: ` +
                            client.tools.map((t) => sanitizeToolText(t.name, 80)).join(', ')
                    };
                }
                catch (e) {
                    return { success: false, error: `Enabled "${sanitizeToolText(target, 80)}" but could not connect: ${sanitizeToolError(e)}` };
                }
            }
            if (action === 'grant_capability') {
                const { GROUP_NAMES, GROUP_DESCRIPTIONS, grantGroup, provisionCapabilities, isGroupInstalled, isKnownGroup } = await import('../provisioning/capabilityProvisioner.js');
                if (!group || !isKnownGroup(group)) {
                    return { success: false, error: `Unknown capability group. Choose one of: ${GROUP_NAMES.join(', ')}.` };
                }
                if (!grantGroup(group)) {
                    return { success: false, error: `Could not grant capability group "${sanitizeToolText(group, 64)}".` };
                }
                try {
                    await provisionCapabilities([group]);
                }
                catch (e) {
                    return { success: false, error: `Could not prepare the "${sanitizeToolText(group, 64)}" capability: ${sanitizeToolError(e)}` };
                }
                return isGroupInstalled(group)
                    ? { success: true, output: `Capability "${group}" is ready — the agent can now ${GROUP_DESCRIPTIONS[group]}.` }
                    : { success: false, error: `The "${group}" capability could not be prepared in this environment.` };
            }
            const scope = resolveToolWorkspaceRoots(sandbox);
            const workspaceDir = scope.primaryRoot || process.cwd();
            const aiToolsDir = path.join(workspaceDir, '.ai_tools');
            if (action === 'check_and_setupEng') {
                if (engine !== 'godot' && engine !== 'blender') {
                    return { success: false, error: 'Missing parameter: engine must be godot or blender' };
                }
                if (!simulateMissing) {
                    const existingPath = await findInstalledEngine(engine);
                    if (existingPath) {
                        return {
                            success: true,
                            status: 'installed',
                            engine,
                            path: existingPath,
                            output: `Sovereign Engine check passed: ${engine} is already installed and ready at ${existingPath}`
                        };
                    }
                }
                return {
                    success: false,
                    status: 'not_installed',
                    engine,
                    error: `${engine} was not found. Causyne does not download or install engine binaries. Install it from the vendor's official distribution, verify it, and run this check again.`
                };
            }
            if (action === 'setup_venv') {
                assertNotSymlinkIfExists(aiToolsDir, '.ai_tools directory');
                if (!fs.existsSync(aiToolsDir))
                    fs.mkdirSync(aiToolsDir, { recursive: true, mode: 0o700 });
                const venvPath = path.join(aiToolsDir, 'venv');
                assertNotSymlinkIfExists(venvPath, 'venv directory');
                if (!fs.existsSync(venvPath)) {
                    const python = process.platform === 'win32' ? 'python.exe' : 'python3';
                    await execFilePromise(python, ['-m', 'venv', venvPath], {
                        timeout: 120000,
                        maxBuffer: 4 * 1024 * 1024,
                        windowsHide: true,
                        env: buildSafePipEnv(),
                        ...(sandbox?.signal ? { signal: sandbox.signal } : {})
                    });
                    return { success: true, output: `Created Python virtual environment at ${venvPath}` };
                }
                return { success: true, output: 'Virtual environment already exists.' };
            }
            else if (action === 'pipInst') {
                if (!packages || packages.length === 0)
                    return { success: false, error: 'No packages provided' };
                if (!Array.isArray(packages) || packages.length > 32 || !packages.every(isExactPyPiPin)) {
                    return { success: false, error: 'Every Python dependency must be an exact PyPI pin such as pillow==11.3.0. Options, URLs, VCS references, local paths and unpinned requirements are blocked.' };
                }
                assertNotSymlinkIfExists(aiToolsDir, '.ai_tools directory');
                const venvPath = path.join(aiToolsDir, 'venv');
                assertNotSymlinkIfExists(venvPath, 'venv directory');
                const isWindows = process.platform === 'win32';
                const pipBinDir = isWindows ? path.join(venvPath, 'Scripts') : path.join(venvPath, 'bin');
                assertNotSymlinkIfExists(pipBinDir, 'venv bin directory');
                const pipCmd = isWindows ? path.join(pipBinDir, 'pip.exe') : path.join(pipBinDir, 'pip');
                assertNotSymlinkIfExists(pipCmd, 'pip executable');
                if (!fs.existsSync(pipCmd))
                    return { success: false, error: 'Virtual environment not found. Run setup_venv first.' };
                try {
                    const { stdout } = await execFilePromise(pipCmd, ['install', '--disable-pip-version-check', '--no-input', '--', ...packages], {
                        timeout: 10 * 60 * 1000,
                        maxBuffer: 10 * 1024 * 1024,
                        windowsHide: true,
                        env: buildSafePipEnv(),
                        ...(sandbox?.signal ? { signal: sandbox.signal } : {})
                    });
                    return {
                        success: true,
                        output: `Installed approved Python dependencies: ${packages.join(', ')}`,
                        logs: sanitizeToolText(stdout, 4000)
                    };
                }
                catch (pipErr) {
                    const errObj = pipErr;
                    const errStr = sanitizeToolText(errObj?.message || errObj?.stderr || sanitizeToolError(pipErr), 1200);
                    if (errStr.includes('Microsoft Visual C++ 14.0 or greater is required')) {
                        return { success: false, error: '[AUTO-REMEDIATION REQUIRED] Missing C++ Build Tools. Ask user for permission to install MSVC Build Tools.' };
                    }
                    if (errStr.includes('No matching distribution found')) {
                        return { success: false, error: '[AUTO-REMEDIATION REQUIRED] Package not found. Check Python version compatibility or PyPI spelling.' };
                    }
                    return { success: false, error: `PIP Install Failed: ${errStr}` };
                }
            }
            return { success: false, error: `Unknown action: ${sanitizeToolText(action ?? '', 80)}` };
        }
        catch (err) {
            return { success: false, error: sanitizeToolError(err) };
        }
    }
};
export const manageLocalAiDependencies = manageLocalDependencies;
