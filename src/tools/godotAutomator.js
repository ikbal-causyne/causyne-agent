import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getErrorMessage } from './toolPathSafety.js';
const execFileAsync = promisify(execFile);
function getWorkspaceTempDir() {
    const tmpDir = path.join(process.cwd(), '.tmp_causyne_3d');
    if (!fsSync.existsSync(tmpDir)) {
        fsSync.mkdirSync(tmpDir, { recursive: true });
    }
    return tmpDir;
}
function getGodotBinary() {
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const homeDir = os.homedir();
    const causyneGodotDir = path.join(homeDir, '.causyne', 'engines', 'godot');
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
    async execute(args = {}, _context) {
        try {
            const { action, simulateMissing, projectDir, projectName, gameType = '2d', targetFile, scenePath, durationFrames = 300, scriptPath, exportPreset, outputPath } = args || {};
            if (action === 'check_status') {
                const bin = simulateMissing ? null : getGodotBinary();
                return {
                    success: true,
                    output: JSON.stringify({
                        godot_binary: bin || 'Not installed / simulateMissing=true',
                        status: bin ? 'available_for_local_cli' : 'fallback_required',
                        workspace_temp_dir: getWorkspaceTempDir()
                    }, null, 2)
                };
            }
            if (action === 'create_project') {
                const safeGameType = ['2d', '3d', 'rpg'].includes(String(gameType)) ? String(gameType) : '2d';
                const finalDir = projectDir || path.join(getWorkspaceTempDir(), projectName || `SovereignProject_${Date.now()}`);
                await fs.mkdir(finalDir, { recursive: true });
                const subdirs = [
                    'scenes/ui', 'scenes/actors', 'scenes/world', 'scenes/levels',
                    'scripts/core', 'scripts/player', 'scripts/ai',
                    'data', 'audio/sfx', 'assets/3d', 'assets/2d'
                ];
                for (const sd of subdirs) {
                    await fs.mkdir(path.join(finalDir, sd), { recursive: true });
                }
                const projectGodotPath = path.join(finalDir, 'project.godot');
                const projectGodotContent = `; Engine configuration file.
; Generated by Sovereign Game Automation Studio (v1.3.12)

config_version=5

[application]

config/name="${projectName || 'Sovereign Game Project'}"
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
                await fs.writeFile(projectGodotPath, projectGodotContent, 'utf8');
                const mainGdPath = path.join(finalDir, 'scripts', 'main.gd');
                const mainGdContent = `extends Node

func _ready() -> void:
\tprint("[Sovereign Engine] Project Ready: ${projectName || 'Sovereign Game Project'} (${safeGameType.toUpperCase()})")
`;
                await fs.writeFile(mainGdPath, mainGdContent, 'utf8');
                const nodeType = safeGameType === '3d' ? 'Node3D' : 'Node2D';
                const mainTscnPath = path.join(finalDir, 'scenes', 'main.tscn');
                const mainTscnContent = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/main.gd" id="1_main"]

[node name="Main" type="${nodeType}"]
script = ExtResource("1_main")
`;
                await fs.writeFile(mainTscnPath, mainTscnContent, 'utf8');
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
                if (!projectDir || !fsSync.existsSync(projectDir)) {
                    return { success: false, error: `Valid projectDir is required for syntax validation. Found: ${String(projectDir ?? '')}` };
                }
                const cliArgs = ['--headless', '--check-only', '--path', projectDir];
                if (targetFile)
                    cliArgs.push(targetFile);
                let stdout = '';
                let stderr = '';
                let exitCode = 0;
                try {
                    const res = await execFileAsync(bin, cliArgs, { maxBuffer: 15 * 1024 * 1024 });
                    stdout = res.stdout;
                    stderr = res.stderr;
                }
                catch (execErr) {
                    const e = execErr;
                    exitCode = typeof e?.code === 'number' ? e.code : 1;
                    stdout = e?.stdout || '';
                    stderr = e?.stderr || getErrorMessage(execErr);
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
                if (!projectDir || !fsSync.existsSync(projectDir)) {
                    return { success: false, error: `Valid projectDir is required for testing. Found: ${String(projectDir ?? '')}` };
                }
                const targetScene = scenePath || 'res://scenes/main.tscn';
                const cliArgs = ['--headless', '--path', projectDir, targetScene, '--quit-after', String(durationFrames)];
                let stdout = '';
                let stderr = '';
                let exitCode = 0;
                const startTime = Date.now();
                try {
                    const res = await execFileAsync(bin, cliArgs, { maxBuffer: 20 * 1024 * 1024 });
                    stdout = res.stdout;
                    stderr = res.stderr;
                }
                catch (execErr) {
                    const e = execErr;
                    exitCode = typeof e?.code === 'number' ? e.code : 1;
                    stdout = e?.stdout || '';
                    stderr = e?.stderr || getErrorMessage(execErr);
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
                if (scriptPath && (scriptPath.includes('func ') || scriptPath.includes('extends '))) {
                    const tempScriptFile = path.join(getWorkspaceTempDir(), `auto_run_${Date.now()}.gd`);
                    await fs.writeFile(tempScriptFile, scriptPath, 'utf8');
                    targetScript = tempScriptFile;
                }
                const cliArgs = ['--headless'];
                if (projectDir && fsSync.existsSync(projectDir)) {
                    cliArgs.push('--path', projectDir);
                }
                if (targetScript) {
                    cliArgs.push('-s', targetScript);
                }
                else {
                    return { success: false, error: 'scriptPath (or raw GDScript string) is required for headless_run.' };
                }
                const { stdout, stderr } = await execFileAsync(bin, cliArgs, { maxBuffer: 15 * 1024 * 1024 });
                return {
                    success: true,
                    output: JSON.stringify({
                        layer: 'Headless CLI Execution',
                        binary: bin,
                        script: targetScript,
                        stdout: stdout.trim(),
                        stderr: stderr.trim()
                    }, null, 2)
                };
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
                if (!projectDir || !fsSync.existsSync(projectDir)) {
                    return { success: false, error: `Valid projectDir containing project.godot is required. Found: ${String(projectDir ?? '')}` };
                }
                const preset = exportPreset || 'HTML5';
                const finalOutput = outputPath || path.join(getWorkspaceTempDir(), `export_${preset.toLowerCase()}_${Date.now()}.${preset === 'Android' ? 'apk' : 'html'}`);
                const cliArgs = ['--headless', '--path', projectDir, '--export-release', preset, finalOutput];
                const { stdout } = await execFileAsync(bin, cliArgs, { maxBuffer: 20 * 1024 * 1024 });
                return {
                    success: true,
                    output: JSON.stringify({
                        layer: 'Headless Export Package',
                        preset,
                        output_file: finalOutput,
                        file_exists: fsSync.existsSync(finalOutput),
                        size_bytes: fsSync.existsSync(finalOutput) ? (await fs.stat(finalOutput)).size : 0,
                        stdout: stdout.trim()
                    }, null, 2)
                };
            }
            return { success: false, error: `Unknown action: ${String(action ?? '')}` };
        }
        catch (e) {
            return { success: false, error: getErrorMessage(e) };
        }
    }
};
