import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import util from 'util';
import os from 'os';

const execFilePromise = util.promisify(execFile);

// Runtime package installation is intentionally narrow. Accept only an exact
// PyPI package pin, never an option, URL, VCS reference or local path. argv is
// then passed directly to pip without a shell.
const PYPI_PIN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?==[A-Za-z0-9][A-Za-z0-9._+!-]*$/;

export function isExactPyPiPin(value) {
  return typeof value === 'string' && value.length <= 200 && PYPI_PIN.test(value);
}

// Phase 9.3: Check installed engine paths
async function findInstalledEngine(engine) {
  const homeDir = os.homedir();
  const causyneEngineDir = path.join(homeDir, '.causyne', 'engines', engine);
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
    if (fs.existsSync(p)) return p;
  }

  try {
    const locator = isWindows ? 'where.exe' : 'which';
    const { stdout } = await execFilePromise(locator, [engine], { timeout: 5000 });
    const trimmed = stdout.trim().split('\n')[0];
    if (trimmed && fs.existsSync(trimmed)) return trimmed;
  } catch (e) {}

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
        group: { type: 'string', description: 'Capability group for grant_capability: vision (browser + screen capture), ocr (read text from images), system (process and load inspection), desktop (clipboard, open, recycle bin), archive (zip and unzip).' },
        engine: { type: 'string', enum: ['godot', 'blender'], description: 'Engine to locate when action is check_and_setupEng' },
        simulateMissing: { type: 'boolean', description: 'Simulate missing binary to verify sovereign fallback cascade' },
        packages: { type: 'array', items: { type: 'string' }, description: 'Exact PyPI pins only, for example pillow==11.3.0. URLs, paths, VCS references and pip options are rejected.' }
      },
      required: ['action']
    }
  },
  
  execute: async (args, sandbox) => {
    try {
      const { action, engine, simulateMissing, packages, group } = args;

      
      if (action === 'list_capabilities') {
        const { GROUP_NAMES, GROUP_DESCRIPTIONS, groupStatus } = await import('../provisioning/capabilityProvisioner.js');
        return {
          success: true,
          output: JSON.stringify(GROUP_NAMES.map(name => ({
            group: name,
            grants: GROUP_DESCRIPTIONS[name],
            status: groupStatus(name).state
          })), null, 2)
        };
      }

      // ── MCP servers ──
      //
      // The server list comes from the user's config and from nowhere else.
      // This action can only ENABLE a server that is already configured; it
      // cannot define one, so no model output ever becomes a process launch.
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
        const known = configuredServers().map(s => s.name);
        if (!target || !known.includes(target)) {
          return {
            success: false,
            error: known.length === 0
              ? 'No MCP servers are configured. Only the user can add one, in ~/.causyne/config.json.'
              : `Unknown MCP server "${target}". Configured servers: ${known.join(', ')}.`
          };
        }
        grantServer(target);
        try {
          const client = await connectServer(target);
          return {
            success: true,
            output: `MCP server "${target}" is enabled and exposed ${client.tools.length} tools: ` +
                    client.tools.map(t => t.name).join(', ')
          };
        } catch (e) {
          return { success: false, error: `Enabled "${target}" but could not connect: ${e.message}` };
        }
      }

      if (action === 'grant_capability') {
        const { GROUP_NAMES, GROUP_DESCRIPTIONS, grantGroup, provisionCapabilities, isGroupInstalled } =
          await import('../provisioning/capabilityProvisioner.js');
        if (!group || !GROUP_NAMES.includes(group)) {
          return { success: false, error: `Unknown capability group. Choose one of: ${GROUP_NAMES.join(', ')}.` };
        }
        grantGroup(group);
        try {
          await provisionCapabilities([group]);
        } catch (e) {
          return { success: false, error: `Could not prepare the "${group}" capability: ${e.message}` };
        }
        return isGroupInstalled(group)
          ? { success: true, output: `Capability "${group}" is ready — the agent can now ${GROUP_DESCRIPTIONS[group]}.` }
          : { success: false, error: `The "${group}" capability could not be prepared in this environment.` };
      }
      const workspaceDir = process.cwd();
      const aiToolsDir = path.join(workspaceDir, '.ai_tools');

      // Engine setup is detection-only. Earlier code wrote a placeholder file
      // and reported it as a verified installation; that was both inaccurate
      // and an unnecessary executable-provisioning surface.
      if (action === 'check_and_setupEng') {
        if (!engine) return { success: false, error: 'Missing parameter: engine must be godot or blender' };

        if (!simulateMissing) {
          const existingPath = await findInstalledEngine(engine);
          if (existingPath) {
            return {
              success: true,
              status: 'installed',
              engine: engine,
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
        if (!fs.existsSync(aiToolsDir)) fs.mkdirSync(aiToolsDir, { recursive: true });
        const venvPath = path.join(aiToolsDir, 'venv');
        if (!fs.existsSync(venvPath)) {
          const python = process.platform === 'win32' ? 'python.exe' : 'python3';
          await execFilePromise(python, ['-m', 'venv', venvPath], { timeout: 120000 });
          return { success: true, output: `Created Python virtual environment at ${venvPath}` };
        }
        return { success: true, output: 'Virtual environment already exists.' };
      } 
      
      else if (action === 'pipInst') {
        if (!packages || packages.length === 0) return { success: false, error: 'No packages provided' };
        if (!Array.isArray(packages) || packages.length > 32 || !packages.every(isExactPyPiPin)) {
          return { success: false, error: 'Every Python dependency must be an exact PyPI pin such as pillow==11.3.0. Options, URLs, VCS references, local paths and unpinned requirements are blocked.' };
        }
        
        const isWindows = process.platform === 'win32';
        const pipCmd = isWindows ? path.join(aiToolsDir, 'venv', 'Scripts', 'pip.exe') : path.join(aiToolsDir, 'venv', 'bin', 'pip');
          
        if (!fs.existsSync(pipCmd)) return { success: false, error: 'Virtual environment not found. Run setup_venv first.' };
        
        try {
          const { stdout } = await execFilePromise(
            pipCmd,
            ['install', '--disable-pip-version-check', '--no-input', ...packages],
            { timeout: 10 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 }
          );
          return { success: true, output: `Installed approved Python dependencies: ${packages.join(', ')}`, logs: stdout };
        } catch (pipErr) {
          const errStr = pipErr.message || pipErr.stderr || "";
          if (errStr.includes("Microsoft Visual C++ 14.0 or greater is required")) {
            return { success: false, error: `[AUTO-REMEDIATION REQUIRED] Missing C++ Build Tools. Ask user for permission to install MSVC Build Tools.` };
          }
          if (errStr.includes("No matching distribution found")) {
            return { success: false, error: `[AUTO-REMEDIATION REQUIRED] Package not found. Check Python version compatibility or PyPI spelling.` };
          }
          return { success: false, error: `PIP Install Failed: ${errStr}` };
        }
      }
      
      return { success: false, error: `Unknown action: ${action}` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
};

// Backward compatibility export
export const manageLocalAiDependencies = manageLocalDependencies;
