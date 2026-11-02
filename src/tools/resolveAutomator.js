import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const PYTHON_SCRIPT = readFileSync(new URL('../tool-scripts/resolve_automator.py', import.meta.url), 'utf8');
export function buildResolvePlatformConfig(platform = os.platform(), baseEnv = process.env, extraModuleDirs = []) {
    if (platform === 'win32') {
        const programData = baseEnv.PROGRAMDATA || 'C:\\ProgramData';
        const programFiles = baseEnv.ProgramFiles || 'C:\\Program Files';
        const scriptApi = `${programData}\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting`;
        const scriptLib = `${programFiles}\\Blackmagic Design\\DaVinci Resolve\\fusionscript.dll`;
        const modulesDir = `${scriptApi}\\Modules\\`;
        const appBinary = `${programFiles}\\Blackmagic Design\\DaVinci Resolve\\Resolve.exe`;
        const pathSep = ';';
        const pyParts = [...extraModuleDirs, baseEnv.PYTHONPATH || '', modulesDir].filter(Boolean);
        return {
            platform,
            scriptApi,
            scriptLib,
            modulesDir,
            appBinary,
            pythonBin: 'python',
            pathSep,
            env: {
                ...baseEnv,
                RESOLVE_SCRIPT_API: scriptApi,
                RESOLVE_SCRIPT_LIB: scriptLib,
                PYTHONPATH: pyParts.join(pathSep)
            }
        };
    }
    if (platform === 'darwin') {
        const scriptApi = '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting';
        const scriptLib = '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so';
        const modulesDir = `${scriptApi}/Modules/`;
        const appBinary = '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/MacOS/Resolve';
        const pathSep = ':';
        const pyParts = [...extraModuleDirs, baseEnv.PYTHONPATH || '', modulesDir].filter(Boolean);
        return {
            platform,
            scriptApi,
            scriptLib,
            modulesDir,
            appBinary,
            pythonBin: 'python3',
            pathSep,
            env: {
                ...baseEnv,
                RESOLVE_SCRIPT_API: scriptApi,
                RESOLVE_SCRIPT_LIB: scriptLib,
                PYTHONPATH: pyParts.join(pathSep)
            }
        };
    }
    const scriptApi = '/opt/resolve/Developer/Scripting';
    const scriptLib = '/opt/resolve/libs/Fusion/fusionscript.so';
    const modulesDir = `${scriptApi}/Modules/`;
    const appBinary = '/opt/resolve/bin/resolve';
    const pathSep = ':';
    const pyParts = [...extraModuleDirs, baseEnv.PYTHONPATH || '', modulesDir].filter(Boolean);
    return {
        platform,
        scriptApi,
        scriptLib,
        modulesDir,
        appBinary,
        pythonBin: 'python3',
        pathSep,
        env: {
            ...baseEnv,
            RESOLVE_SCRIPT_API: scriptApi,
            RESOLVE_SCRIPT_LIB: scriptLib,
            PYTHONPATH: pyParts.join(pathSep)
        }
    };
}
export const MOCK_DAVINCI_RESOLVE_SCRIPT_PY = `# Simulated DaVinciResolveScript module for cross-platform verification
class _MockClip:
    def __init__(self, path):
        self.path = path
        self.lut = None
        self.cdl = None
    def GetClipProperty(self, prop):
        if prop == "FPS":
            return "24"
        if prop == "Resolution":
            return "3840x2160"
        return ""
    def SetLUT(self, node_idx, lut_path):
        self.lut = (node_idx, lut_path)
        return True
    def SetCDL(self, cdl_map):
        self.cdl = cdl_map
        return True

class _MockTimeline:
    def __init__(self, name="Causyne_Master_Timeline"):
        self.name = name
        self.timecode = "01:00:00:00"
        self.markers = {}
        self.clips = [_MockClip("default_clip.mov")]
    def GetName(self):
        return self.name
    def GetTrackCount(self, track_type):
        return 2 if track_type in ("video", "audio") else 1
    def GetCurrentTimecode(self):
        return self.timecode
    def SetCurrentTimecode(self, tc):
        self.timecode = tc
        return True
    def AddMarker(self, frame_id, color, name, note, duration, custom_data=""):
        self.markers[frame_id] = {"color": color, "name": name, "note": note, "duration": duration}
        return True
    def GetItemListInTrack(self, track_type, index):
        return list(self.clips)

class _MockMediaPool:
    def __init__(self, project):
        self.project = project
    def ImportMedia(self, paths):
        clips = [_MockClip(p) for p in paths]
        if self.project.timeline:
            self.project.timeline.clips.extend(clips)
        return clips
    def CreateEmptyTimeline(self, name):
        self.project.timeline = _MockTimeline(name)
        return self.project.timeline
    def AppendToTimeline(self, clips):
        if not self.project.timeline:
            self.project.timeline = _MockTimeline("Causyne_Automated_Timeline")
        self.project.timeline.clips.extend(clips)
        return clips

class _MockProject:
    def __init__(self):
        self.name = "Causyne_Cinema_Project"
        self.settings = {
            "timelineFrameRate": "24",
            "timelineResolutionWidth": "3840",
            "timelineResolutionHeight": "2160",
            "colorScienceMode": "davinciYRGBColorManaged"
        }
        self.timeline = _MockTimeline()
        self.media_pool = _MockMediaPool(self)
        self.render_settings = {}
    def GetName(self):
        return self.name
    def GetSetting(self, key):
        return self.settings.get(key, "")
    def SetSetting(self, key, val):
        self.settings[key] = str(val)
        return True
    def GetMediaPool(self):
        return self.media_pool
    def GetCurrentTimeline(self):
        return self.timeline
    def LoadRenderPreset(self, name):
        self.render_settings["Preset"] = name
        return True
    def SetRenderSettings(self, settings):
        self.render_settings.update(settings)
        return True
    def AddRenderJob(self):
        return "resolve_render_job_001"
    def StartRendering(self, job_ids):
        return True

class _MockProjectManager:
    def __init__(self):
        self.project = _MockProject()
    def GetCurrentProject(self):
        return self.project

class _MockResolveApp:
    def __init__(self):
        self.pm = _MockProjectManager()
    def GetProjectManager(self):
        return self.pm

def scriptapp(name):
    if name == "Resolve":
        return _MockResolveApp()
    return None
`;
export async function runResolveBridge(args, options = {}) {
    const simulate = Boolean(options.simulate || args.simulate || process.env.CAUSYNE_SIMULATE_RESOLVE === '1');
    let tempMockDir = null;
    try {
        const extraDirs = [];
        if (simulate) {
            tempMockDir = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-resolve-sim-'));
            await fs.writeFile(path.join(tempMockDir, 'DaVinciResolveScript.py'), MOCK_DAVINCI_RESOLVE_SCRIPT_PY, 'utf8');
            extraDirs.push(tempMockDir);
        }
        const platformCfg = buildResolvePlatformConfig(options.platform ?? os.platform(), process.env, extraDirs);
        const payload = JSON.stringify(args);
        const pyBin = os.platform() === 'win32' ? platformCfg.pythonBin : 'python3';
        return await new Promise((resolvePromise) => {
            const child = spawn(pyBin, ['-', payload], { env: platformCfg.env });
            let outputData = '';
            let errorData = '';
            child.stdout.on('data', (data) => {
                outputData += data.toString();
            });
            child.stderr.on('data', (data) => {
                errorData += data.toString();
            });
            child.on('error', (err) => {
                resolvePromise({
                    success: false,
                    error: `Failed to spawn Python interpreter (${pyBin}): ${err.message}`
                });
            });
            child.on('close', (code) => {
                if (outputData.trim()) {
                    try {
                        const lines = outputData.trim().split('\n');
                        const jsonLine = lines.find(l => l.trim().startsWith('{') && l.trim().endsWith('}'));
                        if (jsonLine) {
                            resolvePromise(JSON.parse(jsonLine));
                            return;
                        }
                    }
                    catch {
                        // Fall through to error return
                    }
                }
                resolvePromise({
                    success: false,
                    error: errorData.trim() || outputData.trim() || `Python process exited with code ${String(code)}`
                });
            });
            child.stdin.write(PYTHON_SCRIPT);
            child.stdin.end();
        });
    }
    finally {
        if (tempMockDir) {
            await fs.rm(tempMockDir, { recursive: true, force: true }).catch(() => { });
        }
    }
}
export const resolveAutomator = {
    schema: {
        name: 'resolve.act',
        description: 'Automate DaVinci Resolve Studio across macOS, Windows, and Linux for native cinema workflows: active timeline inspection, DaVinci YRGB Color Management (RCM), media pool import & timeline assembly, playhead clip insertion, timeline markers, LUT/CDL color grading, and Deliver render queue automation.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: [
                        'checkConnection',
                        'inspectActive',
                        'setupColorManagement',
                        'importAndAssemble',
                        'insertClipAtPlayhead',
                        'addMarker',
                        'applyLutOrGrade',
                        'renderTimeline'
                    ]
                },
                mediaPath: {
                    type: 'string',
                    description: 'Absolute path to media file or directory to import into the Media Pool.'
                },
                color_space_mode: {
                    type: 'string',
                    enum: ['automatic', 'custom'],
                    description: 'Use automatic (Resolve auto-detects clip color space) or custom RCM.'
                },
                input_color_space: {
                    type: 'string',
                    description: 'Input color space for custom RCM (e.g. "ARRI LogC3", "Sony S-Log3/S-Gamut3.Cine").'
                },
                timeline_color_space: {
                    type: 'string',
                    description: 'Working timeline color space (default "DaVinci WG/Intermediate").'
                },
                output_color_space: {
                    type: 'string',
                    description: 'Output color space (default "Rec.709 Gamma 2.4").'
                },
                fps: {
                    type: 'string',
                    description: 'Timeline framerate (e.g. "23.976", "24") or "auto".'
                },
                resolution_x: {
                    type: 'string',
                    description: 'Timeline width (e.g. "3840", "1920") or "auto".'
                },
                resolution_y: {
                    type: 'string',
                    description: 'Timeline height (e.g. "2160", "1080") or "auto".'
                },
                timelineName: {
                    type: 'string',
                    description: 'Timeline name when creating a new timeline.'
                },
                timecode: {
                    type: 'string',
                    description: 'Target playhead timecode (e.g. "01:00:05:00").'
                },
                frameId: {
                    type: 'integer',
                    description: 'Frame offset for addMarker.'
                },
                markerName: {
                    type: 'string',
                    description: 'Marker title.'
                },
                markerColor: {
                    type: 'string',
                    description: 'Marker color (e.g. "Blue", "Red", "Green", "Yellow").'
                },
                markerNote: {
                    type: 'string',
                    description: 'Marker note text.'
                },
                lutPath: {
                    type: 'string',
                    description: 'Path to .cube LUT file for applyLutOrGrade.'
                },
                nodeIndex: {
                    type: 'integer',
                    description: '1-based serial node index for LUT/CDL application.'
                },
                cdl: {
                    type: 'object',
                    description: 'CDL grade parameters { slope, offset, power, saturation }.',
                    properties: {
                        slope: { type: 'string' },
                        offset: { type: 'string' },
                        power: { type: 'string' },
                        saturation: { type: 'string' }
                    }
                },
                presetName: {
                    type: 'string',
                    description: 'Deliver page render preset name for renderTimeline.'
                },
                targetDir: {
                    type: 'string',
                    description: 'Output directory for renderTimeline.'
                },
                customName: {
                    type: 'string',
                    description: 'Custom output filename for renderTimeline.'
                },
                startRender: {
                    type: 'boolean',
                    description: 'Whether to immediately trigger rendering after adding job (default true).'
                },
                simulate: {
                    type: 'boolean',
                    description: 'Run against the built-in DaVinciResolveScript simulator when DaVinci Resolve is not installed.'
                }
            },
            required: ['action']
        }
    },
    async execute(args) {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
            return { success: false, error: 'Expected DaVinci Resolve action arguments' };
        }
        return await runResolveBridge(args);
    }
};
