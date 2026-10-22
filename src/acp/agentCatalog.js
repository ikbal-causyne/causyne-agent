/**
 * Causyne Agent — ACP Agent Catalog & Zero-Token Discovery
 *
 * Provides built-in profiles, auth probing, and zero-token discovery for
 * common external coding agents that support the Agent Client Protocol (ACP),
 * such as Claude Code, Codex, OpenCode, Gemini CLI, Hermes, Cursor CLI,
 * Qwen, Copilot, Kimi, and Goose.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AcpClient } from './client.js';
const execFileAsync = promisify(execFile);
export const BUILTIN_PEER_PRESETS = {
    opencode: {
        id: 'opencode',
        label: 'OpenCode',
        description: 'OpenCode AI coding agent with support for free and local models',
        command: 'opencode',
        args: ['acp'],
        binaryName: 'opencode',
        fallbackCommand: 'npx',
        fallbackArgs: ['-y', 'opencode-ai', 'acp'],
        authType: 'none',
        setupInstruction: 'Run "opencode auth login" or configure a model in ~/.config/opencode',
        timeoutSeconds: 180
    },
    claude: {
        id: 'claude',
        label: 'Claude Code',
        description: 'Anthropic Claude Code CLI via official ACP bridge adapter',
        command: 'npx',
        args: ['-y', '@agentclientprotocol/claude-agent-acp@0.70.0'],
        binaryName: 'claude',
        authType: 'subscription',
        authProbe: {
            type: 'json',
            command: 'claude',
            args: ['auth', 'status', '--json'],
            jsonField: 'loggedIn'
        },
        setupInstruction: 'Run "claude login" to authenticate with your Anthropic subscription or set ANTHROPIC_API_KEY',
        timeoutSeconds: 300
    },
    codex: {
        id: 'codex',
        label: 'Codex CLI',
        description: 'OpenAI Codex CLI coding agent via ACP adapter',
        command: 'npx',
        args: ['-y', '@agentclientprotocol/codex-acp@1.6.0'],
        binaryName: 'codex',
        authType: 'subscription',
        authProbe: {
            type: 'output_match',
            command: 'codex',
            args: ['login', 'status'],
            positiveMatch: 'logged in',
            negativeMatch: 'not logged in'
        },
        setupInstruction: 'Run "codex login" or set OPENAI_API_KEY in your environment',
        timeoutSeconds: 300
    },
    gemini: {
        id: 'gemini',
        label: 'Gemini CLI',
        description: 'Google Gemini CLI agent with free tier model support',
        command: 'gemini',
        args: ['--acp'],
        binaryName: 'gemini',
        fallbackCommand: 'npx',
        fallbackArgs: ['-y', '@google/gemini-cli', '--acp'],
        authType: 'oauth',
        authProbe: {
            type: 'file_exists',
            filePath: path.join(process.env.HOME || '', '.gemini', 'oauth_creds.json')
        },
        setupInstruction: 'Run "gemini auth" or set GEMINI_API_KEY in your environment',
        timeoutSeconds: 240
    },
    hermes: {
        id: 'hermes',
        label: 'Hermes Agent',
        description: 'Nous Research Hermes autonomous AI agent',
        command: 'hermes',
        args: ['acp'],
        binaryName: 'hermes',
        authType: 'api_key',
        setupInstruction: 'Run "hermes acp --setup" to configure provider credentials',
        timeoutSeconds: 240
    },
    cursor: {
        id: 'cursor',
        label: 'Cursor CLI',
        description: 'Cursor CLI coding agent over ACP',
        command: 'cursor-agent',
        args: ['acp'],
        binaryName: 'cursor-agent',
        authType: 'subscription',
        setupInstruction: 'Run "cursor-agent login" to sign in to your Cursor account',
        timeoutSeconds: 180
    },
    qwen: {
        id: 'qwen',
        label: 'Qwen Code',
        description: 'Alibaba Qwen Code AI assistant over ACP',
        command: 'qwen',
        args: ['--acp'],
        binaryName: 'qwen',
        authType: 'api_key',
        setupInstruction: 'Set DASHSCOPE_API_KEY or run "qwen login"',
        timeoutSeconds: 180
    },
    copilot: {
        id: 'copilot',
        label: 'GitHub Copilot CLI',
        description: 'GitHub Copilot CLI agent over ACP',
        command: 'copilot',
        args: ['--acp', '--stdio'],
        binaryName: 'copilot',
        authType: 'subscription',
        setupInstruction: 'Run "copilot auth" to link your GitHub Copilot subscription',
        timeoutSeconds: 180
    },
    kimi: {
        id: 'kimi',
        label: 'Kimi CLI',
        description: 'Moonshot AI Kimi coding assistant via ACP',
        command: 'kimi',
        args: ['acp'],
        binaryName: 'kimi',
        authType: 'api_key',
        setupInstruction: 'Set MOONSHOT_API_KEY in your environment',
        timeoutSeconds: 180
    },
    goose: {
        id: 'goose',
        label: 'Goose CLI',
        description: 'Block Goose extensible AI coding agent',
        command: 'goose',
        args: ['acp'],
        binaryName: 'goose',
        authType: 'api_key',
        setupInstruction: 'Run "goose configure" to set up providers',
        timeoutSeconds: 180
    }
};
/**
 * Check if a command or binary exists in PATH.
 */
export function isBinaryOnPath(binaryName) {
    if (path.isAbsolute(binaryName)) {
        return fs.existsSync(binaryName);
    }
    const envPath = process.env.PATH || '';
    const delimiter = process.platform === 'win32' ? ';' : ':';
    const dirs = envPath.split(delimiter);
    const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (const dir of dirs) {
        if (!dir)
            continue;
        for (const ext of extensions) {
            const full = path.join(dir, `${binaryName}${ext}`);
            try {
                if (fs.existsSync(full) && fs.statSync(full).isFile()) {
                    return true;
                }
            }
            catch {
                // Skip inaccessible path segments
            }
        }
    }
    return false;
}
/**
 * Probe authorization state without spending model tokens.
 */
export async function probePresetAuth(preset) {
    if (!preset.authProbe) {
        return { authenticated: true };
    }
    const probe = preset.authProbe;
    if (probe.type === 'file_exists' && probe.filePath) {
        const exists = fs.existsSync(probe.filePath);
        return {
            authenticated: exists,
            reason: exists ? 'OAuth credentials file detected' : `Credentials file not found at ${probe.filePath}`
        };
    }
    if (probe.type === 'json' && probe.command) {
        if (!isBinaryOnPath(probe.command)) {
            return { authenticated: false, reason: `${probe.command} CLI not found on PATH` };
        }
        try {
            const { stdout } = await execFileAsync(probe.command, probe.args || [], { timeout: 8000 });
            const parsed = JSON.parse(stdout.trim());
            if (probe.jsonField && typeof parsed === 'object' && parsed !== null) {
                const val = parsed[probe.jsonField];
                const isAuth = Boolean(val);
                return {
                    authenticated: isAuth,
                    reason: isAuth ? 'Valid CLI login session active' : 'CLI reports not logged in'
                };
            }
            return { authenticated: true, reason: 'CLI auth responded' };
        }
        catch {
            return { authenticated: false, reason: `Failed to probe ${probe.command} auth status` };
        }
    }
    if (probe.type === 'output_match' && probe.command) {
        if (!isBinaryOnPath(probe.command)) {
            return { authenticated: false, reason: `${probe.command} CLI not found on PATH` };
        }
        try {
            const result = await execFileAsync(probe.command, probe.args || [], { timeout: 8000 }).catch((e) => e);
            const combined = `${result?.stdout || ''}\n${result?.stderr || ''}`.toLowerCase();
            if (probe.negativeMatch && combined.includes(probe.negativeMatch.toLowerCase())) {
                return { authenticated: false, reason: 'CLI reported not logged in' };
            }
            if (probe.positiveMatch && combined.includes(probe.positiveMatch.toLowerCase())) {
                return { authenticated: true, reason: 'CLI login detected' };
            }
            return { authenticated: false, reason: 'No active login detected' };
        }
        catch {
            return { authenticated: false, reason: `Failed to probe ${probe.command} auth` };
        }
    }
    return { authenticated: true };
}
/**
 * Execute a zero-token ACP handshake (initialize + session/new) with strict timeout.
 * Never sends session/prompt, ensuring $0 token consumption.
 */
export async function testPeerHandshake(options) {
    const cwd = options.cwd || process.cwd();
    const clientOptions = {
        command: options.command,
        cwd,
        promptTimeoutMs: options.timeoutMs || 15000
    };
    if (options.args) {
        clientOptions.args = options.args;
    }
    const client = new AcpClient(clientOptions);
    const timeoutMs = options.timeoutMs || 12000;
    try {
        const init = await Promise.race([
            client.start(),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`ACP initialization timed out after ${timeoutMs}ms`)), timeoutMs))
        ]);
        const agentInfo = init.agentInfo ? { name: init.agentInfo.name, version: init.agentInfo.version } : undefined;
        const authMethods = Array.isArray(init.authMethods)
            ? init.authMethods.map((m) => (typeof m === 'object' && m !== null && 'id' in m ? String(m.id) : String(m)))
            : [];
        // Attempt session/new to ensure agent is fully operational
        try {
            await client.newSession(cwd);
            return {
                ready: true,
                ...(agentInfo ? { agentInfo } : {}),
                authMethods
            };
        }
        catch (sessionErr) {
            const msg = sessionErr instanceof Error ? sessionErr.message : String(sessionErr);
            return {
                ready: false,
                ...(agentInfo ? { agentInfo } : {}),
                authMethods,
                error: `Session creation failed: ${msg}`
            };
        }
    }
    catch (initErr) {
        const msg = initErr instanceof Error ? initErr.message : String(initErr);
        return { ready: false, error: msg };
    }
    finally {
        await client.close().catch(() => { });
    }
}
/**
 * Detect all built-in ACP presets available on this machine and report their readiness.
 */
export async function detectAllPeers(cwd = process.cwd()) {
    const results = [];
    for (const preset of Object.values(BUILTIN_PEER_PRESETS)) {
        const hasDirectBinary = isBinaryOnPath(preset.binaryName);
        const hasRunner = isBinaryOnPath(preset.command);
        if (!hasDirectBinary && !hasRunner) {
            results.push({
                id: preset.id,
                label: preset.label,
                status: 'not_installed',
                command: preset.command,
                args: preset.args,
                details: `Binary "${preset.binaryName}" and runner "${preset.command}" not found on PATH.`,
                ...(preset.setupInstruction ? { setupInstruction: preset.setupInstruction } : {})
            });
            continue;
        }
        // Determine actual command to execute
        let activeCommand = preset.command;
        let activeArgs = preset.args;
        if (!hasDirectBinary && preset.fallbackCommand && isBinaryOnPath(preset.fallbackCommand)) {
            activeCommand = preset.fallbackCommand;
            activeArgs = preset.fallbackArgs || [];
        }
        // Run auth probe
        const auth = await probePresetAuth(preset);
        if (!auth.authenticated) {
            results.push({
                id: preset.id,
                label: preset.label,
                status: 'needs_auth',
                command: activeCommand,
                args: activeArgs,
                details: auth.reason || 'Authentication required.',
                ...(preset.setupInstruction ? { setupInstruction: preset.setupInstruction } : {})
            });
            continue;
        }
        // Run zero-token handshake
        const handshake = await testPeerHandshake({
            command: activeCommand,
            args: activeArgs,
            cwd,
            timeoutMs: 8000
        });
        if (handshake.ready) {
            results.push({
                id: preset.id,
                label: preset.label,
                status: 'ready',
                command: activeCommand,
                args: activeArgs,
                ...(handshake.agentInfo ? { agentInfo: handshake.agentInfo } : {}),
                ...(handshake.authMethods ? { authMethods: handshake.authMethods } : {}),
                details: 'Operational and ready for delegation.'
            });
        }
        else if (handshake.error && /auth/i.test(handshake.error)) {
            results.push({
                id: preset.id,
                label: preset.label,
                status: 'needs_auth',
                command: activeCommand,
                args: activeArgs,
                ...(handshake.agentInfo ? { agentInfo: handshake.agentInfo } : {}),
                ...(handshake.authMethods ? { authMethods: handshake.authMethods } : {}),
                details: handshake.error,
                ...(preset.setupInstruction ? { setupInstruction: preset.setupInstruction } : {})
            });
        }
        else {
            results.push({
                id: preset.id,
                label: preset.label,
                status: hasDirectBinary ? 'error' : 'not_installed',
                command: activeCommand,
                args: activeArgs,
                details: handshake.error || 'ACP handshake did not complete.',
                ...(preset.setupInstruction ? { setupInstruction: preset.setupInstruction } : {})
            });
        }
    }
    return results;
}
/**
 * Convert a preset to a runnable PeerProfile.
 */
export function getPresetProfile(id) {
    const preset = BUILTIN_PEER_PRESETS[id.toLowerCase()];
    if (!preset)
        return null;
    return {
        id: preset.id,
        label: preset.label,
        command: preset.command,
        args: preset.args,
        cwd: null,
        policy: 'read-only',
        timeoutSeconds: preset.timeoutSeconds || 180,
        env: {}
    };
}
