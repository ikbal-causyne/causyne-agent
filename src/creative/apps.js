import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export function blenderCandidates(platform = process.platform) {
    if (platform === 'darwin')
        return ['/Applications/Blender.app/Contents/MacOS/Blender', '/opt/homebrew/bin/blender', '/usr/local/bin/blender'];
    if (platform === 'win32') {
        const root = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Blender Foundation');
        try {
            return fs.readdirSync(root).filter(n => /^Blender(?:\s|$)/i.test(n)).sort().reverse().map(n => path.join(root, n, 'blender.exe'));
        }
        catch {
            return [];
        }
    }
    return ['/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender'];
}
export async function findBlender() {
    for (const executable of blenderCandidates()) {
        if (!fs.existsSync(executable))
            continue;
        try {
            const { stdout } = await exec(executable, ['--version'], { timeout: 8000, maxBuffer: 64 * 1024 });
            const version = stdout.match(/^Blender\s+\d[^\r\n]*/)?.[0];
            if (version)
                return { executable, version };
        }
        catch { /* Try the next installed candidate. Never install implicitly. */ }
    }
    return null;
}
export function unrealCandidates(platform = process.platform) {
    const candidates = [];
    if (platform === 'darwin') {
        for (const root of ['/Users/Shared/Epic Games', '/Applications']) {
            try {
                const dirs = fs.readdirSync(root).filter(n => /^UE_\d/i.test(n)).sort().reverse();
                for (const dir of dirs) {
                    candidates.push(path.join(root, dir, 'Engine/Binaries/Mac/UnrealEditor-Cmd'));
                    candidates.push(path.join(root, dir, 'Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor-Cmd'));
                }
            }
            catch { /* ignore */ }
        }
    }
    else if (platform === 'win32') {
        const root = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Epic Games');
        try {
            const dirs = fs.readdirSync(root).filter(n => /^UE_\d/i.test(n)).sort().reverse();
            for (const dir of dirs) {
                candidates.push(path.join(root, dir, 'Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe'));
            }
        }
        catch { /* ignore */ }
    }
    else {
        candidates.push(path.join(os.homedir(), 'UnrealEngine/Engine/Binaries/Linux/UnrealEditor-Cmd'), '/opt/unreal-engine/Engine/Binaries/Linux/UnrealEditor-Cmd');
    }
    return candidates;
}
export function findUnrealEngine(platform = process.platform) {
    for (const executable of unrealCandidates(platform)) {
        if (!fs.existsSync(executable))
            continue;
        const match = executable.match(/UE_(\d+(?:\.\d+)*)/i);
        return { executable, version: match?.[1] ? `Unreal Engine ${match[1]}` : 'Unreal Engine 5' };
    }
    return null;
}
export function unityCandidates(platform = process.platform) {
    const candidates = [];
    if (platform === 'darwin') {
        const hubRoot = '/Applications/Unity/Hub/Editor';
        try {
            const versions = fs.readdirSync(hubRoot).sort().reverse();
            for (const v of versions) {
                candidates.push(path.join(hubRoot, v, 'Unity.app/Contents/MacOS/Unity'));
            }
        }
        catch { /* ignore */ }
        candidates.push('/Applications/Unity/Unity.app/Contents/MacOS/Unity');
    }
    else if (platform === 'win32') {
        const hubRoot = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Unity\\Hub\\Editor');
        try {
            const versions = fs.readdirSync(hubRoot).sort().reverse();
            for (const v of versions) {
                candidates.push(path.join(hubRoot, v, 'Editor\\Unity.exe'));
            }
        }
        catch { /* ignore */ }
        candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Unity\\Editor\\Unity.exe'));
    }
    else {
        const hubRoot = path.join(os.homedir(), 'Unity/Hub/Editor');
        try {
            const versions = fs.readdirSync(hubRoot).sort().reverse();
            for (const v of versions) {
                candidates.push(path.join(hubRoot, v, 'Editor/Unity'));
            }
        }
        catch { /* ignore */ }
        candidates.push('/opt/unity/Editor/Unity');
    }
    return candidates;
}
export function findUnityEditor(platform = process.platform) {
    for (const executable of unityCandidates(platform)) {
        if (!fs.existsSync(executable))
            continue;
        const match = executable.match(/Editor[\\/]([^\\/]+)[\\/](?:Unity\.app|Editor)/i);
        return { executable, version: match?.[1] ? `Unity ${match[1]}` : 'Unity Editor' };
    }
    return null;
}
export function godotCandidates(platform = process.platform) {
    const homeDir = os.homedir();
    const causyneGodotDir = path.join(homeDir, '.causyne', 'engines', 'godot');
    if (platform === 'darwin') {
        return [
            path.join(causyneGodotDir, 'godot'),
            '/Applications/Godot.app/Contents/MacOS/Godot',
            '/Applications/Godot_4.app/Contents/MacOS/Godot',
            '/opt/homebrew/bin/godot',
            '/usr/local/bin/godot'
        ];
    }
    if (platform === 'win32') {
        return [
            path.join(causyneGodotDir, 'Godot.exe'),
            path.join(causyneGodotDir, 'godot.exe'),
            'C:\\Program Files\\Godot\\Godot_v4.exe',
            'C:\\Program Files\\Godot\\godot.exe'
        ];
    }
    return [
        path.join(causyneGodotDir, 'godot'),
        '/usr/bin/godot',
        '/usr/local/bin/godot'
    ];
}
export function findGodotEngine(platform = process.platform) {
    for (const executable of godotCandidates(platform)) {
        if (fs.existsSync(executable)) {
            return { executable, version: 'Godot 4.x' };
        }
    }
    return null;
}
export function resolveCandidates(platform = process.platform) {
    if (platform === 'darwin') {
        return [
            '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/MacOS/Resolve',
            '/Applications/DaVinci Resolve/DaVinci Resolve.app'
        ];
    }
    if (platform === 'win32') {
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
        return [
            path.join(programFiles, 'Blackmagic Design\\DaVinci Resolve\\Resolve.exe')
        ];
    }
    return ['/opt/resolve/bin/resolve'];
}
export function findDaVinciResolve(platform = process.platform) {
    for (const executable of resolveCandidates(platform)) {
        if (fs.existsSync(executable)) {
            return { executable, version: 'DaVinci Resolve Studio' };
        }
    }
    return null;
}
/** Probes local creative application installations and native automation adapter readiness. */
export async function creativeAppStatus() {
    const blender = await findBlender();
    const resolve = findDaVinciResolve();
    const unreal = findUnrealEngine();
    const unity = findUnityEditor();
    const godot = findGodotEngine();
    const roots = process.platform === 'darwin'
        ? ['/Applications', path.join(os.homedir(), 'Applications')]
        : process.platform === 'win32'
            ? [process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)']
            : [];
    const installedNames = roots.flatMap(root => {
        try {
            const top = fs.readdirSync(root);
            const adobeSub = top.filter(n => /Adobe/i.test(n)).flatMap(sub => {
                try {
                    return fs.readdirSync(path.join(root, sub));
                }
                catch {
                    return [];
                }
            });
            return [...top, ...adobeSub];
        }
        catch {
            return [];
        }
    });
    return [
        { id: 'blender', label: '3D Studio (Blender)', installed: Boolean(blender), available: Boolean(blender),
            detail: blender ? `${blender.version} · native batch engine (geometry, materials, lighting, render)` : 'Install Blender to enable 3D batch modeling and rendering.' },
        ...[
            ['photoshop', 'Photo Studio', /Photoshop/i, '.psd/.png/.jpg', 'live canvas/selection mask bridge, layer edits, transforms, UXP'],
            ['premiere', 'Video Studio', /Premiere/i, '.prproj', 'live active sequence insertion, timeline media imports, cuts, markers, UXP'],
            ['after-effects', 'Motion Studio', /After\s*Effects/i, '.aep', 'live active composition bridge, footage import, typography, motion'],
            ['illustrator', 'Vector Studio', /Illustrator/i, '.ai/.svg/.pdf', 'live artboard placement, vector paths, typography, SVG/PDF export'],
            ['indesign', 'Layout Studio', /InDesign/i, '.indd/.idml/.pdf', 'live spread/frame placement, multi-page editorial layout'],
            ['media-encoder', 'Encoder Studio', /Media\s*Encoder/i, '.mp4/.mov/.wav', 'render queue dispatch and hardware codec transcode']
        ].map(([id, label, pattern, ext, capabilities]) => {
            const installed = installedNames.some(n => pattern.test(n));
            return {
                id: id,
                label: label,
                installed,
                available: installed,
                detail: installed
                    ? `Connected · native automation & live session bridge ready (${ext} · ${capabilities})`
                    : `Not installed · install ${label} host engine to enable native creative automation`
            };
        }),
        {
            id: 'resolve',
            label: 'Cinema Studio (DaVinci Resolve)',
            installed: Boolean(resolve),
            available: true,
            detail: resolve
                ? `${resolve.version} (${resolve.executable}) · DaVinciResolveScript Python API (timeline assembly, RCM color management, LUT/CDL grading, render queue)`
                : 'DaVinciResolveScript Python bridge & simulator ready (macOS/Windows/Linux) · install DaVinci Resolve for live NLE/grading execution'
        },
        {
            id: 'unreal',
            label: 'Unreal Engine (UE5)',
            installed: Boolean(unreal),
            available: true,
            detail: unreal
                ? `${unreal.version} (${unreal.executable}) · Remote Control HTTP/WS API (30010) & Python Editor automation ready`
                : 'Staged Python & Remote Control HTTP (30010) bridge ready · install Unreal Engine 5 for local CLI execution'
        },
        {
            id: 'unity',
            label: 'Unity Engine',
            installed: Boolean(unity),
            available: true,
            detail: unity
                ? `${unity.version} (${unity.executable}) · C# Editor batchmode & AssetDatabase bridge ready`
                : 'Staged C# Editor & AssetDatabase bridge ready · install Unity Editor for local batchmode execution'
        },
        {
            id: 'godot',
            label: 'Godot Engine',
            installed: Boolean(godot),
            available: true,
            detail: godot
                ? `${godot.version} (${godot.executable}) · headless SceneTree GDScript & resource import bridge ready`
                : 'Staged GDScript & scene resource bridge ready · install Godot 4 for local headless execution'
        }
    ];
}
