import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { causyneHome } from '../utils/paths.js';
import { sanitizeSubprocessEnv } from './subprocessEnv.js';
import { getErrorMessage, assertSafeWorkspaceOutput, atomicWriteFileSafe, boundedInteger, escapeGodotString, resolveScopedPath, resolveToolWorkspaceRoots, safeSlugIdentifier, sanitizeToolError, sanitizeToolText } from './toolPathSafety.js';
const GODOT_CLI_TIMEOUT_MS = 120_000;
function assertSafeCliArg(value, label) {
    const trimmed = value.trim();
    if (!trimmed || trimmed.includes('\0') || trimmed.startsWith('-')) {
        throw new Error(`Invalid ${label}: must be non-empty and must not start with "-" or contain NUL bytes.`);
    }
    return trimmed;
}
const execFileAsync = promisify(execFile);
function getWorkspaceTempDir(context) {
    const baseDir = resolveToolWorkspaceRoots(context).primaryRoot || process.cwd();
    const tmpDir = path.join(baseDir, '.tmp_causyne_3d');
    if (!fsSync.existsSync(tmpDir)) {
        fsSync.mkdirSync(tmpDir, { recursive: true });
    }
    return tmpDir;
}
function getGodotBinary() {
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const causyneGodotDir = path.join(causyneHome(), 'engines', 'godot');
    const candidates = [];
    if (isMac) {
        candidates.push(path.join(causyneGodotDir, 'godot'), '/Applications/Godot.app/Contents/MacOS/Godot', '/Applications/Godot_4.app/Contents/MacOS/Godot', '/opt/homebrew/bin/godot', '/usr/local/bin/godot');
    }
    else if (isWin) {
        candidates.push(path.join(causyneGodotDir, 'Godot.exe'), path.join(causyneGodotDir, 'godot.exe'), 'C:\\Program Files\\Godot\\Godot_v4.exe', 'C:\\Program Files\\Godot\\godot.exe');
    }
    else {
        candidates.push(path.join(causyneGodotDir, 'godot'), '/usr/bin/godot', '/usr/local/bin/godot');
    }
    for (const bin of candidates) {
        try {
            if (fsSync.existsSync(bin))
                return bin;
        }
        catch { /* ignore */ }
    }
    return null;
}
export const godotAutomator = {
    schema: {
        name: 'godot.act',
        description: 'Universal Sovereign Godot 4.x Game Engine Automation with Sovereign Fallback Cascade. Scaffolds projects (`create_project`), validates GDScript syntax (`validate_project`), executes runtime playtest matrices (`test_scene`), executes CLI scripts (`headless_run`), builds export packages (`export_project`), and cascades to HTML5 fallbacks if binary is missing.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['create_project', 'validate_project', 'check_syntax', 'test_scene', 'headless_run', 'export_project', 'check_status'],
                    description: 'The execution layer: create_project (scaffold folder structure & project.godot), validate_project/check_syntax (GDScript AST linter), test_scene (headless runtime assertion), headless_run (CLI GDScript), export_project (headless build), or check_status (binary check).'
                },
                simulateMissing: {
                    type: 'boolean',
                    description: 'Simulate missing binary to verify sovereign fallback cascade.'
                },
                projectDir: {
                    type: 'string',
                    description: 'Absolute path to Godot project directory containing project.godot.'
                },
                projectName: {
                    type: 'string',
                    description: 'Name of the Godot project for create_project.'
                },
                gameType: {
                    type: 'string',
                    enum: ['2d', '3d', 'rpg'],
                    description: 'Type of project template to initialize for create_project (`2d`, `3d`, or `rpg`).'
                },
                targetFile: {
                    type: 'string',
                    description: 'Specific script or scene file path (`res://...` or absolute) to validate syntax for validate_project.'
                },
                scenePath: {
                    type: 'string',
                    description: 'Scene file path (`res://scenes/main.tscn` or absolute) to test for test_scene.'
                },
                durationFrames: {
                    type: 'number',
                    description: 'Number of simulation frames for test_scene before auto-quitting (default 300 frames @ 60fps = 5 seconds).'
                },
                scriptPath: {
                    type: 'string',
                    description: 'Path or raw GDScript code for headless_run.'
                },
                exportPreset: {
                    type: 'string',
                    description: 'Export preset name (`Android`, `HTML5`, `Windows Desktop`, `macOS`).'
                },
                outputPath: {
                    type: 'string',
                    description: 'Absolute path for output binary or package.'
                }
            },
            required: ['action']
        }
    },
    async execute(args = {}, context) {
        try {
            const { action, simulateMissing, projectDir, projectName, gameType = '2d', targetFile, scenePath, durationFrames = 300, scriptPath, exportPreset, outputPath } = args || {};
            if (action === 'check_status') {
                const bin = simulateMissing ? null : getGodotBinary();
                return {
                    success: true,
                    output: JSON.stringify({
                        godot_binary: bin || 'Not installed / simulateMissing=true',
                        status: bin ? 'available_for_local_cli' : 'fallback_required',
                        workspace_temp_dir: getWorkspaceTempDir(context)
                    }, null, 2)
                };
            }
            if (action === 'create_project') {
                const safeGameType = ['2d', '3d', 'rpg'].includes(String(gameType)) ? String(gameType) : '2d';
                const displayProjectName = escapeGodotString(projectName || 'Sovereign Game Project', 120);
                const dirSlug = safeSlugIdentifier(projectName, `SovereignProject_${Date.now()}`, 64);
                const finalDir = projectDir
                    ? resolveScopedPath(projectDir, context)
                    : path.join(getWorkspaceTempDir(context), dirSlug);
                await fs.mkdir(finalDir, { recursive: true });
                const subdirs = [
                    'scenes/ui', 'scenes/actors', 'scenes/world', 'scenes/levels',
                    'scripts/core', 'scripts/player', 'scripts/ai',
                    'data', 'audio/sfx', 'assets/3d', 'assets/2d'
                ];
                for (const sd of subdirs) {
                    await fs.mkdir(path.join(finalDir, sd), { recursive: true });
                }
                const projectGodotPath = await assertSafeWorkspaceOutput(path.join(finalDir, 'project.godot'), context, { scopeRoot: finalDir });
                const projectGodotContent = `; Engine configuration file.
; Generated by Sovereign Game Automation Studio (v1.3.12)

config_version=5

[application]

config/name="${displayProjectName}"
config/features=PackedStringArray("4.3", "Forward Plus")
run/main_scene="res://scenes/main.tscn"

[display]

window/size/viewport_width=1280
window/size/viewport_height=720
window/stretch/mode="canvas_items"

[physics]

2d/run_on_separate_thread=true
3d/run_on_separate_thread=true
`;
                await atomicWriteFileSafe(projectGodotPath, projectGodotContent);
                const mainGdPath = await assertSafeWorkspaceOutput(path.join(finalDir, 'scripts', 'main.gd'), context, { scopeRoot: finalDir });
                const mainGdContent = `extends Node

func _ready() -> void:
\tprint("[Sovereign Engine] Project Ready: ${displayProjectName} (${safeGameType.toUpperCase()})")
`;
                await atomicWriteFileSafe(mainGdPath, mainGdContent);
                const nodeType = safeGameType === '3d' ? 'Node3D' : 'Node2D';
                const mainTscnPath = await assertSafeWorkspaceOutput(path.join(finalDir, 'scenes', 'main.tscn'), context, { scopeRoot: finalDir });
                const mainTscnContent = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/main.gd" id="1_main"]

[node name="Main" type="${nodeType}"]
script = ExtResource("1_main")
`;
                await atomicWriteFileSafe(mainTscnPath, mainTscnContent);
                return {
                    success: true,
                    output: JSON.stringify({
                        action: 'create_project',
                        project_dir: finalDir,
                        project_name: projectName || 'Sovereign Game Project',
                        game_type: safeGameType,
                        created_files: ['project.godot', 'scripts/main.gd', 'scenes/main.tscn'],
                        created_directories: subdirs,
                        status: 'READY_FOR_ASSEMBLY'
                    }, null, 2)
                };
            }
            if (action === 'validate_project' || action === 'check_syntax') {
                const bin = simulateMissing ? null : getGodotBinary();
                if (!bin) {
                    return {
                        success: false,
                        status: 'fallback_required',
                        error: '[ENGINE MISSING or SIMULATED] Godot binary not found for syntax validation.',
                        fallback_guidance: {
                            auto_install_option: 'Call manage_local_dependencies (action="check_and_setupEng", engine="godot") to install (~135 MB compressed).',
                            instant_execution_option: 'Or verify code using built-in code_verify_syntax tool and build via game.build_html5.'
                        }
                    };
                }
                const scopedProjectDir = projectDir ? resolveScopedPath(projectDir, context) : '';
                if (!scopedProjectDir || !fsSync.existsSync(scopedProjectDir)) {
                    return { success: false, error: `Valid projectDir is required for syntax validation. Found: ${sanitizeToolText(projectDir ?? '', 200)}` };
                }
                assertSafeCliArg(scopedProjectDir, 'projectDir');
                const cliArgs = ['--headless', '--check-only', '--path', scopedProjectDir];
                if (targetFile) {
                    const safeTarget = assertSafeCliArg(String(targetFile), 'targetFile');
                    if (!safeTarget.startsWith('res://'))
                        resolveScopedPath(safeTarget, context);
                    cliArgs.push(safeTarget);
                }
                let stdout = '';
                let stderr = '';
                let exitCode = 0;
                try {
                    const res = await execFileAsync(bin, cliArgs, {
                        maxBuffer: 15 * 1024 * 1024,
                        timeout: GODOT_CLI_TIMEOUT_MS,
                        windowsHide: true,
                        env: sanitizeSubprocessEnv(process.env),
                        ...(context?.signal ? { signal: context.signal } : {})
                    });
                    stdout = res.stdout;
                    stderr = res.stderr;
                }
                catch (execErr) {
                    const e = execErr;
                    exitCode = typeof e?.code === 'number' ? e.code : 1;
                    stdout = e?.stdout || '';
                    stderr = e?.stderr || sanitizeToolError(execErr);
                }
                const combined = `${stdout}\n${stderr}`;
                const lines = combined.split('\n');
                const diagnostics = [];
                const errorRegex = /(?:SCRIPT ERROR|ERROR|PARSE ERROR|Line (\d+)): (.{0,500})/i;
                for (const rawLine of lines) {
                    const line = rawLine.slice(0, 1024);
                    if (line.includes('ERROR') || line.includes('SCRIPT ERROR') || line.includes('Parse Error')) {
                        const matchErr = line.match(errorRegex);
                        let parsedFile = targetFile || 'project';
                        let parsedLine = matchErr?.[1] ? parseInt(matchErr[1], 10) : 1;
                        const atIdx = line.toLowerCase().indexOf('at: ');
                        if (atIdx !== -1) {
                            const tail = line.slice(atIdx + 4);
                            const parenIdx = tail.lastIndexOf(' (');
                            if (parenIdx > 0) {
                                const candidateFile = tail.slice(0, parenIdx).trim();
                                const lineMatch = tail.slice(parenIdx + 2).match(/^(?:line\s+)?(\d+)\)/i);
                                if (candidateFile && lineMatch?.[1]) {
                                    parsedFile = candidateFile;
                                    parsedLine = parseInt(lineMatch[1], 10);
                                }
                            }
                        }
                        diagnostics.push({
                            file: parsedFile,
                            line: parsedLine,
                            error: matchErr?.[2] || line.trim()
                        });
                    }
                }
                const passed = exitCode === 0 && diagnostics.length === 0;
                return {
                    success: true,
                    output: JSON.stringify({
                        action: 'validate_project',
                        project_dir: projectDir,
                        target_file: targetFile || 'entire_project',
                        status: passed ? 'PASSED' : 'SYNTAX_ERRORS_FOUND',
                        exit_code: exitCode,
                        error_count: diagnostics.length,
                        diagnostics,
                        raw_output: combined.trim().slice(0, 2000)
                    }, null, 2)
                };
            }
            if (action === 'test_scene') {
                const bin = simulateMissing ? null : getGodotBinary();
                if (!bin) {
                    return {
                        success: false,
                        status: 'fallback_required',
                        error: '[ENGINE MISSING or SIMULATED] Godot binary not found for headless playtest.',
                        fallback_guidance: {
                            auto_install_option: 'Call manage_local_dependencies (action="check_and_setupEng", engine="godot") to install (~135 MB compressed).',
                            instant_execution_option: 'Or invoke game.build_html5 to playtest instantly in WebGL / Canvas 2D.'
                        }
                    };
                }
                const scopedProjectDir = projectDir ? resolveScopedPath(projectDir, context) : '';
                if (!scopedProjectDir || !fsSync.existsSync(scopedProjectDir)) {
                    return { success: false, error: `Valid projectDir is required for testing. Found: ${sanitizeToolText(projectDir ?? '', 200)}` };
                }
                assertSafeCliArg(scopedProjectDir, 'projectDir');
                const targetScene = assertSafeCliArg(scenePath || 'res://scenes/main.tscn', 'scenePath');
                if (!targetScene.startsWith('res://'))
                    resolveScopedPath(targetScene, context);
                const safeFrames = boundedInteger(durationFrames, 300, 1, 36000);
                const cliArgs = ['--headless', '--path', scopedProjectDir, targetScene, '--quit-after', String(safeFrames)];
                let stdout = '';
                let stderr = '';
                let exitCode = 0;
                const startTime = Date.now();
                try {
                    const res = await execFileAsync(bin, cliArgs, {
                        maxBuffer: 20 * 1024 * 1024,
                        timeout: GODOT_CLI_TIMEOUT_MS,
                        windowsHide: true,
                        env: sanitizeSubprocessEnv(process.env),
                        ...(context?.signal ? { signal: context.signal } : {})
                    });
                    stdout = res.stdout;
                    stderr = res.stderr;
                }
                catch (execErr) {
                    const e = execErr;
                    exitCode = typeof e?.code === 'number' ? e.code : 1;
                    stdout = e?.stdout || '';
                    stderr = e?.stderr || sanitizeToolError(execErr);
                }
                const durationMs = Date.now() - startTime;
                const combined = `${stdout}\n${stderr}`;
                const hasFatalError = combined.includes('FATAL') || combined.includes('SCRIPT ERROR') || combined.includes('CRITICAL') || combined.includes('Null instance') || exitCode !== 0;
                return {
                    success: true,
                    output: JSON.stringify({
                        action: 'test_scene',
                        project_dir: projectDir,
                        scene_tested: targetScene,
                        simulated_frames: durationFrames,
                        execution_time_ms: durationMs,
                        status: !hasFatalError ? 'PASSED_ZERO_CRASHES' : 'RUNTIME_ERRORS_DETECTED',
                        exit_code: exitCode,
                        logs_sample: combined.trim().split('\n').slice(-30)
                    }, null, 2)
                };
            }
            if (action === 'headless_run') {
                const bin = simulateMissing ? null : getGodotBinary();
                if (!bin) {
                    return {
                        success: false,
                        status: 'fallback_required',
                        error: '[ENGINE MISSING or SIMULATED] Godot binary not found locally.',
                        fallback_guidance: {
                            auto_install_option: 'Call manage_local_dependencies (action="check_and_setupEng", engine="godot") to auto-install (~135 MB compressed).',
                            instant_execution_option: 'Or immediately invoke game.build_html5 (Three.js WebGL / Canvas 2D + SovereignAudioEngine) + game.asset_fetch to fulfill game request without Godot.'
                        }
                    };
                }
                let targetScript = scriptPath;
                let tempScriptFile = null;
                if (scriptPath && (scriptPath.includes('func ') || scriptPath.includes('extends '))) {
                    if (scriptPath.length > 512 * 1024) {
                        return { success: false, error: 'Inline GDScript exceeds 512 KiB limit.' };
                    }
                    tempScriptFile = path.join(getWorkspaceTempDir(context), `auto_run_${process.pid}_${crypto.randomBytes(8).toString('hex')}.gd`);
                    await fs.writeFile(tempScriptFile, scriptPath, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
                    targetScript = tempScriptFile;
                }
                else if (targetScript) {
                    targetScript = assertSafeCliArg(targetScript, 'scriptPath');
                    if (!targetScript.startsWith('res://')) {
                        targetScript = resolveScopedPath(targetScript, context);
                    }
                }
                try {
                    const cliArgs = ['--headless'];
                    if (projectDir) {
                        const scopedProjectDir = resolveScopedPath(projectDir, context);
                        if (fsSync.existsSync(scopedProjectDir)) {
                            assertSafeCliArg(scopedProjectDir, 'projectDir');
                            cliArgs.push('--path', scopedProjectDir);
                        }
                    }
                    if (targetScript) {
                        cliArgs.push('-s', targetScript);
                    }
                    else {
                        return { success: false, error: 'scriptPath (or raw GDScript string) is required for headless_run.' };
                    }
                    const { stdout, stderr } = await execFileAsync(bin, cliArgs, {
                        maxBuffer: 15 * 1024 * 1024,
                        timeout: GODOT_CLI_TIMEOUT_MS,
                        windowsHide: true,
                        env: sanitizeSubprocessEnv(process.env),
                        ...(context?.signal ? { signal: context.signal } : {})
                    });
                    return {
                        success: true,
                        output: JSON.stringify({
                            layer: 'Headless CLI Execution',
                            binary: bin,
                            script: targetScript,
                            stdout: sanitizeToolText(stdout.trim(), 4000),
                            stderr: sanitizeToolText(stderr.trim(), 4000)
                        }, null, 2)
                    };
                }
                finally {
                    if (tempScriptFile) {
                        await fs.unlink(tempScriptFile).catch(() => { });
                    }
                }
            }
            if (action === 'export_project') {
                const bin = simulateMissing ? null : getGodotBinary();
                if (!bin) {
                    return {
                        success: false,
                        status: 'fallback_required',
                        error: '[ENGINE MISSING or SIMULATED] Godot binary not found for project export.',
                        fallback_guidance: {
                            auto_install_option: 'Call manage_local_dependencies (action="check_and_setupEng", engine="godot") to auto-install (~135 MB compressed).',
                            instant_execution_option: 'Or immediately invoke game.build_html5 (Three.js WebGL / Canvas 2D + SovereignAudioEngine) + game.asset_fetch to fulfill game request without Godot.'
                        }
                    };
                }
                const scopedProjectDir = projectDir ? resolveScopedPath(projectDir, context) : '';
                if (!scopedProjectDir || !fsSync.existsSync(scopedProjectDir)) {
                    return { success: false, error: `Valid projectDir containing project.godot is required. Found: ${sanitizeToolText(projectDir ?? '', 200)}` };
                }
                assertSafeCliArg(scopedProjectDir, 'projectDir');
                const preset = assertSafeCliArg(exportPreset || 'HTML5', 'exportPreset');
                const presetSlug = safeSlugIdentifier(preset.toLowerCase(), 'html5', 32);
                const finalOutput = outputPath
                    ? await assertSafeWorkspaceOutput(outputPath, context)
                    : path.join(getWorkspaceTempDir(context), `export_${presetSlug}_${Date.now()}.${preset === 'Android' ? 'apk' : 'html'}`);
                assertSafeCliArg(finalOutput, 'outputPath');
                const cliArgs = ['--headless', '--path', scopedProjectDir, '--export-release', preset, finalOutput];
                const { stdout } = await execFileAsync(bin, cliArgs, {
                    maxBuffer: 20 * 1024 * 1024,
                    timeout: GODOT_CLI_TIMEOUT_MS,
                    windowsHide: true,
                    env: sanitizeSubprocessEnv(process.env),
                    ...(context?.signal ? { signal: context.signal } : {})
                });
                return {
                    success: true,
                    output: JSON.stringify({
                        layer: 'Headless Export Package',
                        preset,
                        output_file: finalOutput,
                        file_exists: fsSync.existsSync(finalOutput),
                        size_bytes: fsSync.existsSync(finalOutput) ? (await fs.stat(finalOutput)).size : 0,
                        stdout: sanitizeToolText(stdout.trim(), 4000)
                    }, null, 2)
                };
            }
            return { success: false, error: `Unknown action: ${sanitizeToolText(action ?? '', 80)}` };
        }
        catch (e) {
            return { success: false, error: sanitizeToolError(e) };
        }
    }
};
