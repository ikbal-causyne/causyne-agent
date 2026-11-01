// Sovereign Reverse Engineering Engine Harness.
//
// Bridges Causyne Agent to the headless reverse engineering engine substrate
// via the Model Context Protocol (MCP) stdio transport.
//
// Encapsulates on-demand process lifecycle, error containment, execution timeouts,
// and graceful fallback mechanisms to guarantee zero crashes on Causyne host processes.
import fs from 'node:fs';
import path from 'node:path';
import { McpClient } from '../mcp/mcpClient.js';
import { resolveUserPath } from '../utils/paths.js';
export class SovereignReverseHarness {
    static instance = null;
    client = null;
    connectPromise = null;
    isAvailableCache = null;
    static getInstance() {
        if (!SovereignReverseHarness.instance) {
            SovereignReverseHarness.instance = new SovereignReverseHarness();
        }
        return SovereignReverseHarness.instance;
    }
    /**
     * Check if the headless reverse engineering engine is available in the current environment.
     */
    async isAvailable() {
        if (this.isAvailableCache !== null)
            return this.isAvailableCache;
        try {
            const client = await this.ensureConnected();
            this.isAvailableCache = client !== null && client.status.state === 'connected';
            return this.isAvailableCache;
        }
        catch {
            this.isAvailableCache = false;
            return false;
        }
    }
    /**
     * Lazily establish connection to the sovereign engine via stdio MCP.
     */
    async ensureConnected() {
        if (this.client && this.client.status.state === 'connected') {
            return this.client;
        }
        if (this.connectPromise) {
            return this.connectPromise;
        }
        this.connectPromise = (async () => {
            try {
                // 1. Locate local rea binary if installed (sub-second launch, zero network lag)
                let command = 'npx';
                let args = ['--yes', 'rea-agents@6.8.0', '--mcp'];
                const candidatePaths = [
                    path.join(process.env.HOME || '', '.local', 'bin', 'rea'),
                    '/usr/local/bin/rea',
                    '/opt/homebrew/bin/rea'
                ];
                for (const candidate of candidatePaths) {
                    if (fs.existsSync(candidate)) {
                        command = candidate;
                        args = ['--mcp'];
                        break;
                    }
                }
                const nodeDir = path.dirname(process.execPath);
                const homeDir = process.env.HOME || '';
                const buildToolsDirs = [
                    path.join(homeDir, 'Library/Android/sdk/build-tools/36.1.0'),
                    path.join(homeDir, 'Library/Android/sdk/build-tools/35.0.0'),
                    path.join(homeDir, 'Library/Android/sdk/platform-tools'),
                    '/opt/homebrew/bin',
                    '/usr/local/bin'
                ].filter(d => fs.existsSync(d));
                const augmentedPath = [nodeDir, ...buildToolsDirs, process.env.PATH || ''].join(':');
                const mcpClient = new McpClient({
                    name: 'causyne_reverse_engineering',
                    command,
                    args,
                    env: {
                        ...process.env,
                        PATH: augmentedPath
                    },
                    timeoutMs: 60_000
                });
                await mcpClient.connect();
                this.client = mcpClient;
                this.isAvailableCache = true;
                return this.client;
            }
            catch (err) {
                this.client = null;
                this.isAvailableCache = false;
                return null;
            }
            finally {
                this.connectPromise = null;
            }
        })();
        return this.connectPromise;
    }
    /**
     * Execute an upstream tool directly through the MCP engine.
     */
    async callEngineTool(toolName, args, signal) {
        try {
            const client = await this.ensureConnected();
            if (!client || client.status.state !== 'connected') {
                return {
                    success: false,
                    toolName,
                    error: 'Reverse engineering engine substrate is currently unreachable.',
                    source: 'engine'
                };
            }
            const res = await client.callTool(toolName, args, signal);
            return {
                success: res.success,
                toolName,
                output: res.output,
                error: res.error,
                structuredContent: res.structuredContent,
                source: 'engine'
            };
        }
        catch (err) {
            return {
                success: false,
                toolName,
                error: err instanceof Error ? err.message : String(err),
                source: 'engine'
            };
        }
    }
    /**
     * List all specialized tools advertised by the engine.
     */
    async listTools() {
        try {
            const client = await this.ensureConnected();
            if (!client)
                return [];
            return client.tools.map(t => t.name);
        }
        catch {
            return [];
        }
    }
    /**
     * Disconnect the client and shut down the background process cleanly.
     */
    async disconnect() {
        if (this.client) {
            try {
                await this.client.close();
            }
            catch {
                // Safe disposal
            }
            finally {
                this.client = null;
                this.isAvailableCache = null;
            }
        }
    }
    // ─────────────────────────────────────────────────────────────────────────
    // HIGH-LEVEL SOVEREIGN ACTIONS
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Perform deep binary inspection via engine tools.
     */
    async inspectBinary(filePath, signal) {
        const resolved = resolveUserPath(filePath);
        if (!fs.existsSync(resolved)) {
            return { success: false, toolName: 'inspect_binary', error: `File not found: ${resolved}`, source: 'engine' };
        }
        const ext = path.extname(resolved).toLowerCase();
        if (ext === '.apk' || ext === '.aab') {
            const pkg = await this.callEngineTool('inspect_android_package', { path: resolved }, signal);
            if (pkg.success && pkg.output && !pkg.output.includes('capability_unavailable') && !pkg.output.includes('REA_JADX_MCP_JAR')) {
                return pkg;
            }
            const dec = await this.callEngineTool('decode_android_resources', { path: resolved }, signal);
            if (dec.success && dec.output && !dec.output.includes('capability_unavailable') && !dec.output.includes('apktool launcher was not found')) {
                return dec;
            }
            return {
                success: false,
                toolName: 'inspect_android_package',
                error: 'Engine APK tools unavailable; delegating to sovereign native inspector.',
                source: 'fallback'
            };
        }
        // Try primary session / overview tools
        const open = await this.callEngineTool('open_binary', { path: resolved }, signal);
        if (open.success && open.output && !open.output.includes('"architecture":null'))
            return open;
        const layout = await this.callEngineTool('inspect_binary_layout', { path: resolved }, signal);
        if (layout.success)
            return layout;
        // Fall back to objdump if available on engine
        return this.callEngineTool('inspect_with_objdump', { path: resolved }, signal);
    }
    /**
     * Perform headless decompilation of a function or address.
     */
    async decompile(filePath, targetFunction, address, signal) {
        const resolved = resolveUserPath(filePath);
        if (!fs.existsSync(resolved)) {
            return { success: false, toolName: 'decompile', error: `Target not found: ${resolved}`, source: 'engine' };
        }
        if (targetFunction) {
            const funcRes = await this.callEngineTool('analyze_function', { path: resolved, function_name: targetFunction }, signal);
            if (funcRes.success)
                return funcRes;
        }
        if (address) {
            const addrRes = await this.callEngineTool('procedure_pseudo_code', { path: resolved, address }, signal);
            if (addrRes.success)
                return addrRes;
        }
        // General decompilation
        const decompileRes = await this.callEngineTool('decompile_all', { path: resolved }, signal);
        if (decompileRes.success)
            return decompileRes;
        // Rizin / Cutter command fallback
        return this.callEngineTool('execute_rizin_command', { path: resolved, command: 'pdd' }, signal);
    }
    /**
     * Unpack an application bundle (ASAR, APK, container).
     */
    async unpackBundle(bundlePath, outputDirectory, signal) {
        const resolved = resolveUserPath(bundlePath);
        if (!fs.existsSync(resolved)) {
            return { success: false, toolName: 'unpack_bundle', error: `Bundle not found: ${resolved}`, source: 'engine' };
        }
        const ext = path.extname(resolved).toLowerCase();
        if (ext === '.apk' || ext === '.aab') {
            const apkRes = await this.callEngineTool('decode_android_resources', { path: resolved }, signal);
            if (apkRes.success)
                return apkRes;
        }
        return this.callEngineTool('open_bundle_resources', {
            path: resolved,
            ...(outputDirectory ? { output_directory: resolveUserPath(outputDirectory) } : {})
        }, signal);
    }
    /**
     * Deobfuscate scripts or recover JavaScript bundles.
     */
    async deobfuscateScript(scriptPath, signal) {
        const resolved = resolveUserPath(scriptPath);
        if (!fs.existsSync(resolved)) {
            return { success: false, toolName: 'deobfuscate_script', error: `Script not found: ${resolved}`, source: 'engine' };
        }
        const recoverRes = await this.callEngineTool('recover_javascript_sources', { path: resolved }, signal);
        if (recoverRes.success)
            return recoverRes;
        return this.callEngineTool('analyze_web_bundle', { path: resolved }, signal);
    }
    /**
     * Dynamic observation or runtime tracing.
     */
    async traceRuntime(target, options = {}, signal) {
        const traceRes = await this.callEngineTool('trace_dylib_resolution', { target }, signal);
        if (traceRes.success)
            return traceRes;
        return this.callEngineTool('observe_native_calls', {
            target,
            ...(options.script ? { script: options.script } : {})
        }, signal);
    }
    /**
     * Decode Android resources (AndroidManifest.xml, resources.arsc, layouts).
     */
    async decodeAndroidResources(apkPath, outputDirectory, signal) {
        const resolved = resolveUserPath(apkPath);
        if (!fs.existsSync(resolved)) {
            return { success: false, toolName: 'decode_android_resources', error: `APK not found: ${resolved}`, source: 'engine' };
        }
        return this.callEngineTool('decode_android_resources', {
            path: resolved,
            ...(outputDirectory ? { output_directory: resolveUserPath(outputDirectory) } : {})
        }, signal);
    }
    /**
     * Search classes or list class hierarchy inside an Android APK.
     */
    async searchAndroidClasses(apkPath, query = '', signal) {
        const resolved = resolveUserPath(apkPath);
        if (!fs.existsSync(resolved)) {
            return { success: false, toolName: 'search_android_classes', error: `APK not found: ${resolved}`, source: 'engine' };
        }
        return this.callEngineTool('search_android_classes', {
            path: resolved,
            query: query || ''
        }, signal);
    }
    /**
     * Project authenticated Android application graph (components, intents, activities).
     */
    async projectAndroidGraph(apkPath, signal) {
        const resolved = resolveUserPath(apkPath);
        if (!fs.existsSync(resolved)) {
            return { success: false, toolName: 'project_android_application_graph', error: `APK not found: ${resolved}`, source: 'engine' };
        }
        return this.callEngineTool('project_android_application_graph', { path: resolved }, signal);
    }
}
export const sovereignReverseHarness = SovereignReverseHarness.getInstance();
