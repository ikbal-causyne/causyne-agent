import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findUnrealEngine, findUnityEditor, findGodotEngine } from './apps.js';
import { runResolveBridge, buildResolvePlatformConfig } from '../tools/resolveAutomator.js';
const execFileAsync = promisify(execFile);
const MAX_CACHED_SELECTION_MASKS = 128;
const selectionMaskCache = new Map();
export function rememberSelectionMask(documentName, bounds, hasMask = true) {
    const key = String(documentName || 'active_document').trim();
    const entry = {
        key,
        documentName: key,
        bounds: {
            left: Math.round(bounds.left),
            top: Math.round(bounds.top),
            right: Math.round(bounds.right),
            bottom: Math.round(bounds.bottom),
            width: Math.max(1, Math.round(bounds.right - bounds.left)),
            height: Math.max(1, Math.round(bounds.bottom - bounds.top))
        },
        hasMask,
        capturedAt: Date.now()
    };
    if (selectionMaskCache.has(key))
        selectionMaskCache.delete(key);
    selectionMaskCache.set(key, entry);
    while (selectionMaskCache.size > MAX_CACHED_SELECTION_MASKS) {
        const oldestKey = selectionMaskCache.keys().next().value;
        if (oldestKey === undefined)
            break;
        selectionMaskCache.delete(oldestKey);
    }
    return entry;
}
export function getLatestSelectionMask(documentName) {
    if (documentName !== undefined) {
        return selectionMaskCache.get(documentName) ?? null;
    }
    let latest = null;
    for (const entry of selectionMaskCache.values()) {
        if (!latest || entry.capturedAt >= latest.capturedAt)
            latest = entry;
    }
    return latest;
}
export function clearSelectionMaskCache() {
    selectionMaskCache.clear();
}
const ADOBE_HOST_ALIASES = {
    photoshop: 'photoshop',
    'photo-studio': 'photoshop',
    photostudio: 'photoshop',
    premiere: 'premiere',
    'premiere-pro': 'premiere',
    premierepro: 'premiere',
    'video-studio': 'premiere',
    videostudio: 'premiere',
    'after-effects': 'after-effects',
    aftereffects: 'after-effects',
    'motion-studio': 'after-effects',
    motionstudio: 'after-effects',
    illustrator: 'illustrator',
    'vector-studio': 'illustrator',
    vectorstudio: 'illustrator',
    indesign: 'indesign',
    'layout-studio': 'indesign',
    layoutstudio: 'indesign',
    'media-encoder': 'media-encoder',
    mediaencoder: 'media-encoder',
    'encoder-studio': 'media-encoder',
    resolve: 'resolve',
    'davinci-resolve': 'resolve',
    davinciresolve: 'resolve',
    davinci: 'resolve',
    'cinema-studio': 'resolve',
    cinemastudio: 'resolve'
};
const GAME_ENGINE_ALIASES = {
    unreal: 'unreal',
    'unreal-engine': 'unreal',
    unrealengine: 'unreal',
    ue5: 'unreal',
    ue4: 'unreal',
    unity: 'unity',
    'unity-editor': 'unity',
    unity3d: 'unity',
    godot: 'godot',
    'godot-engine': 'godot',
    godot4: 'godot'
};
export async function resolveWorkspacePath(target, workspace, mustExist) {
    if (!target || typeof target !== 'string') {
        throw new Error('Path must be a non-empty string');
    }
    const root = await fs.realpath(workspace);
    const candidate = path.resolve(root, target);
    if (candidate !== root && !candidate.startsWith(root + path.sep)) {
        throw new Error('Path must stay inside the active workspace');
    }
    const parentDir = await fs.realpath(path.dirname(candidate)).catch(() => null);
    if (parentDir && parentDir !== root && !parentDir.startsWith(root + path.sep)) {
        throw new Error('Path parent escapes the active workspace');
    }
    if (mustExist) {
        const real = await fs.realpath(candidate).catch(() => null);
        if (!real)
            throw new Error(`Workspace file does not exist: ${target}`);
        if (real !== root && !real.startsWith(root + path.sep)) {
            throw new Error('Resolved symlink escapes the active workspace');
        }
        return real;
    }
    return candidate;
}
export function validateAdobeLiveJob(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Adobe live bridge job must be an object');
    }
    const raw = value;
    const hostInput = String(raw.host ?? 'photoshop').trim().toLowerCase();
    const canonicalHost = ADOBE_HOST_ALIASES[hostInput];
    if (!canonicalHost) {
        throw new Error(`Unsupported Adobe host "${String(raw.host)}". Supported hosts: photoshop, premiere, after-effects, illustrator, indesign, media-encoder.`);
    }
    const opInput = String(raw.liveOperation ?? raw.operation ?? 'inspect_active').trim();
    const validOps = [
        'inspect_active',
        'export_canvas_preview',
        'place_in_active_canvas',
        'insert_in_active_timeline'
    ];
    if (!validOps.includes(opInput)) {
        throw new Error(`Unsupported liveOperation "${opInput}". Supported: ${validOps.join(', ')}`);
    }
    const maxDimensionRaw = typeof raw.maxDimension === 'number' && Number.isFinite(raw.maxDimension)
        ? Math.round(raw.maxDimension)
        : 1024;
    const maxDimension = Math.min(1024, Math.max(64, maxDimensionRaw));
    let fitMode;
    if (raw.fitMode !== undefined) {
        const fm = String(raw.fitMode).trim();
        if (!['selection', 'bounds', 'document_height', 'original'].includes(fm)) {
            throw new Error('fitMode must be one of: selection, bounds, document_height, original');
        }
        fitMode = fm;
    }
    let bounds;
    if (raw.bounds && typeof raw.bounds === 'object' && !Array.isArray(raw.bounds)) {
        const b = raw.bounds;
        const left = Number(b.left ?? 0);
        const top = Number(b.top ?? 0);
        const width = Number(b.width ?? 0);
        const height = Number(b.height ?? 0);
        if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            throw new Error('bounds must contain finite left, top, and positive width, height');
        }
        bounds = { left, top, width, height };
    }
    if (opInput === 'export_canvas_preview') {
        if (canonicalHost !== 'photoshop' && canonicalHost !== 'illustrator') {
            throw new Error('export_canvas_preview is supported for photoshop and illustrator hosts');
        }
        if (typeof raw.output !== 'string' || !raw.output.trim()) {
            throw new Error('export_canvas_preview requires an output PNG file path inside the workspace');
        }
    }
    if (opInput === 'place_in_active_canvas') {
        if (!['photoshop', 'illustrator', 'indesign'].includes(canonicalHost)) {
            throw new Error('place_in_active_canvas is supported for photoshop, illustrator, and indesign hosts');
        }
        if (typeof raw.input !== 'string' || !raw.input.trim()) {
            throw new Error('place_in_active_canvas requires an input asset file path inside the workspace');
        }
        if (fitMode === 'bounds' && !bounds) {
            throw new Error('place_in_active_canvas with fitMode="bounds" requires bounds { left, top, width, height }');
        }
    }
    if (opInput === 'insert_in_active_timeline') {
        if (canonicalHost !== 'premiere' && canonicalHost !== 'after-effects' && canonicalHost !== 'resolve') {
            throw new Error('insert_in_active_timeline is supported for premiere, after-effects, and resolve hosts');
        }
        if (typeof raw.input !== 'string' || !raw.input.trim()) {
            throw new Error('insert_in_active_timeline requires an input media file path inside the workspace');
        }
    }
    return {
        host: hostInput,
        canonicalHost,
        operation: opInput,
        input: typeof raw.input === 'string' ? raw.input.trim() : undefined,
        output: typeof raw.output === 'string' ? raw.output.trim() : undefined,
        maxDimension,
        layerOnly: Boolean(raw.layerOnly),
        fitMode: fitMode ?? (bounds ? 'bounds' : 'selection'),
        bounds,
        applySelectionMask: raw.applySelectionMask === undefined ? true : Boolean(raw.applySelectionMask),
        layerName: typeof raw.layerName === 'string' && raw.layerName.trim() ? raw.layerName.trim() : 'Causyne Placed Asset',
        atPlayhead: raw.atPlayhead === undefined ? raw.start === undefined : Boolean(raw.atPlayhead),
        start: typeof raw.start === 'number' && Number.isFinite(raw.start) && raw.start >= 0 ? raw.start : 0,
        track: typeof raw.track === 'number' && Number.isInteger(raw.track) && raw.track >= 0 ? raw.track : 0,
        audioTrack: Boolean(raw.audioTrack),
        stageOnly: Boolean(raw.stageOnly),
        simulateHost: Boolean(raw.simulateHost)
    };
}
export function buildAdobeLiveExtendScript(job, receiptFile, cachedBounds) {
    const receiptLit = JSON.stringify(receiptFile);
    const lines = [
        '(function() {',
        '  function writeJsonReceipt(obj) {',
        `    var f = new File(${receiptLit});`,
        '    f.encoding = "UTF-8";',
        '    f.open("w");',
        '    f.write(obj);',
        '    f.close();',
        '  }',
        '  try {'
    ];
    if (job.canonicalHost === 'photoshop') {
        lines.push('    if (app.documents.length === 0) { throw new Error("No active document is open in Photoshop"); }', '    var doc = app.activeDocument;', '    var origRuler = app.preferences.rulerUnits;', '    app.preferences.rulerUnits = Units.PIXELS;', '    var selBounds = null;', '    try {', '      var sb = doc.selection.bounds;', '      selBounds = [Number(sb[0].as("px")), Number(sb[1].as("px")), Number(sb[2].as("px")), Number(sb[3].as("px"))];', '    } catch (_noSel) { selBounds = null; }');
        if (job.operation === 'inspect_active') {
            lines.push('    var activeLayerName = doc.activeLayer ? String(doc.activeLayer.name) : "";', '    var w = Number(doc.width.as("px"));', '    var h = Number(doc.height.as("px"));', '    app.preferences.rulerUnits = origRuler;', '    writeJsonReceipt(\'{"status":"CAUSYNE_LIVE_OK","host":"photoshop","operation":"inspect_active","documentName":\' + JSON.stringify(String(doc.name)) + \',"width":\' + w + \',"height":\' + h + \',"activeLayerName":\' + JSON.stringify(activeLayerName) + \',"layerCount":\' + doc.layers.length + \',"hasSelection":\' + (selBounds !== null) + \',"selectionBounds":\' + (selBounds ? "[" + selBounds.join(",") + "]" : "null") + \'}\');');
        }
        else if (job.operation === 'export_canvas_preview') {
            const outLit = JSON.stringify(job.output ?? '');
            const maxDim = job.maxDimension ?? 1024;
            lines.push('    var dup = doc.duplicate("Causyne_Temp_Preview", false);', ...(job.layerOnly
                ? [
                    '    try { dup.trim(TrimType.TRANSPARENT, true, true, true, true); } catch (_trimErr) {}'
                ]
                : ['    dup.flatten();']), '    var dw = Number(dup.width.as("px"));', '    var dh = Number(dup.height.as("px"));', `    var maxDim = ${maxDim};`, '    if (dw > maxDim || dh > maxDim) {', '      var ratio = maxDim / Math.max(dw, dh);', '      dup.resizeImage(UnitValue(Math.max(1, Math.round(dw * ratio)), "px"), UnitValue(Math.max(1, Math.round(dh * ratio)), "px"), null, ResampleMethod.BICUBIC);', '    }', '    var pngOpts = new PNGSaveOptions();', `    dup.saveAs(new File(${outLit}), pngOpts, true, Extension.LOWERCASE);`, '    dup.close(SaveOptions.DONOTSAVECHANGES);', '    app.preferences.rulerUnits = origRuler;', `    writeJsonReceipt('{"status":"CAUSYNE_LIVE_OK","host":"photoshop","operation":"export_canvas_preview","documentName":' + JSON.stringify(String(doc.name)) + ',"output":' + JSON.stringify(${outLit}) + ',"hasSelection":' + (selBounds !== null) + ',"selectionBounds":' + (selBounds ? "[" + selBounds.join(",") + "]" : "null") + '}');`);
        }
        else if (job.operation === 'place_in_active_canvas') {
            const inLit = JSON.stringify(job.input ?? '');
            const layerNameLit = JSON.stringify(job.layerName ?? 'Causyne Placed Asset');
            const fitMode = job.fitMode ?? 'selection';
            const fallbackBounds = job.bounds
                ? [job.bounds.left, job.bounds.top, job.bounds.left + job.bounds.width, job.bounds.top + job.bounds.height]
                : cachedBounds
                    ? [cachedBounds.left, cachedBounds.top, cachedBounds.right, cachedBounds.bottom]
                    : null;
            const fallbackLit = fallbackBounds ? `[${fallbackBounds.join(',')}]` : 'null';
            const placeLines = [
                `    var targetBounds = (${JSON.stringify(fitMode)} === "bounds") ? ${fallbackLit} : (selBounds !== null ? selBounds : ${fallbackLit});`,
                '    var idPlc = charIDToTypeID("Plc ");',
                '    var descPlc = new ActionDescriptor();',
                `    descPlc.putPath(charIDToTypeID("null"), new File(${inLit}));`,
                '    descPlc.putEnumerated(charIDToTypeID("FTcs"), charIDToTypeID("QCSt"), charIDToTypeID("Qcsa"));',
                '    executeAction(idPlc, descPlc, DialogModes.NO);',
                '    var placedLayer = doc.activeLayer;',
                `    placedLayer.name = ${layerNameLit};`,
                '    var lb = placedLayer.bounds;',
                '    var lw = Math.max(1, Number(lb[2].as("px")) - Number(lb[0].as("px")));',
                '    var lh = Math.max(1, Number(lb[3].as("px")) - Number(lb[1].as("px")));',
                `    var fitMode = ${JSON.stringify(fitMode)};`,
                '    if ((fitMode === "selection" || fitMode === "bounds") && targetBounds !== null) {',
                '      var tw = Math.max(1, targetBounds[2] - targetBounds[0]);',
                '      var th = Math.max(1, targetBounds[3] - targetBounds[1]);',
                '      placedLayer.resize((tw / lw) * 100.0, (th / lh) * 100.0, AnchorPosition.TOPLEFT);',
                '      var nb = placedLayer.bounds;',
                '      placedLayer.translate(UnitValue(targetBounds[0] - Number(nb[0].as("px")), "px"), UnitValue(targetBounds[1] - Number(nb[1].as("px")), "px"));',
                `      if (${Boolean(job.applySelectionMask)} && selBounds !== null) {`,
                '        try {',
                '          doc.selection.select([[targetBounds[0], targetBounds[1]], [targetBounds[2], targetBounds[1]], [targetBounds[2], targetBounds[3]], [targetBounds[0], targetBounds[3]]]);',
                '          var idMk = charIDToTypeID("Mk  ");',
                '          var descMk = new ActionDescriptor();',
                '          descMk.putClass(charIDToTypeID("Nw  "), charIDToTypeID("Chnl"));',
                '          var refMk = new ActionReference();',
                '          refMk.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), charIDToTypeID("Msk "));',
                '          descMk.putReference(charIDToTypeID("At  "), refMk);',
                '          descMk.putEnumerated(charIDToTypeID("Usng"), charIDToTypeID("UsrM"), charIDToTypeID("RvlS"));',
                '          executeAction(idMk, descMk, DialogModes.NO);',
                '        } catch (_maskErr) {}',
                '      }',
                '    } else if (fitMode === "document_height") {',
                '      var docH = Math.max(1, Number(doc.height.as("px")));',
                '      var scalePct = (docH / lh) * 100.0;',
                '      placedLayer.resize(scalePct, scalePct, AnchorPosition.MIDDLECENTER);',
                '    }',
                '    app.preferences.rulerUnits = origRuler;',
                '    writeJsonReceipt(\'{"status":"CAUSYNE_LIVE_OK","host":"photoshop","operation":"place_in_active_canvas","layerName":\' + JSON.stringify(String(placedLayer.name)) + \',"fitMode":\' + JSON.stringify(fitMode) + \'}\');'
            ];
            for (const line of placeLines) {
                lines.push(line);
            }
        }
    }
    else if (job.canonicalHost === 'premiere') {
        lines.push('    if (!app.project) { throw new Error("No active project is open in Premiere Pro"); }', '    var seq = app.project.activeSequence;', '    if (!seq) { throw new Error("No active sequence is open in Premiere Pro"); }');
        if (job.operation === 'inspect_active') {
            lines.push('    var playheadTicks = seq.getPlayerPosition();', '    var playheadSec = playheadTicks ? Number(playheadTicks.seconds) : 0;', '    writeJsonReceipt(\'{"status":"CAUSYNE_LIVE_OK","host":"premiere","operation":"inspect_active","projectName":\' + JSON.stringify(String(app.project.name || "Untitled")) + \',"activeSequenceName":\' + JSON.stringify(String(seq.name)) + \',"playheadSeconds":\' + playheadSec + \',"videoTracks":\' + seq.videoTracks.numTracks + \',"audioTracks":\' + seq.audioTracks.numTracks + \'}\');');
        }
        else if (job.operation === 'insert_in_active_timeline') {
            const inLit = JSON.stringify(job.input ?? '');
            const trackIdx = job.track ?? 0;
            lines.push(`    var importOk = app.project.importFiles([${inLit}], true, app.project.rootItem, false);`, '    if (!importOk) { throw new Error("Premiere Pro failed to import media file"); }', '    var item = app.project.rootItem.children[app.project.rootItem.children.numItems - 1];', `    var insertTime = ${job.atPlayhead ? '(seq.getPlayerPosition() ? seq.getPlayerPosition().seconds : 0)' : Number(job.start ?? 0)};`, `    var trackCollection = ${job.audioTrack ? 'seq.audioTracks' : 'seq.videoTracks'};`, `    var targetTrack = trackCollection[Math.min(${trackIdx}, trackCollection.numTracks - 1)];`, '    targetTrack.insertClip(item, insertTime);', '    writeJsonReceipt(\'{"status":"CAUSYNE_LIVE_OK","host":"premiere","operation":"insert_in_active_timeline","activeSequenceName":\' + JSON.stringify(String(seq.name)) + \',"insertedAtSeconds":\' + insertTime + \'}\');');
        }
    }
    else if (job.canonicalHost === 'after-effects') {
        lines.push('    if (!app.project) { throw new Error("No active project is open in After Effects"); }', '    var comp = app.project.activeItem;', '    if (!comp || !(comp instanceof CompItem)) { throw new Error("No active composition is selected in After Effects"); }');
        if (job.operation === 'inspect_active') {
            lines.push('    writeJsonReceipt(\'{"status":"CAUSYNE_LIVE_OK","host":"after-effects","operation":"inspect_active","activeCompName":\' + JSON.stringify(String(comp.name)) + \',"width":\' + comp.width + \',"height":\' + comp.height + \',"duration":\' + comp.duration + \',"frameRate":\' + comp.frameRate + \',"numLayers":\' + comp.numLayers + \'}\');');
        }
        else if (job.operation === 'insert_in_active_timeline') {
            const inLit = JSON.stringify(job.input ?? '');
            lines.push(`    var io = new ImportOptions(new File(${inLit}));`, '    var footage = app.project.importFile(io);', '    var layer = comp.layers.add(footage);', `    layer.startTime = ${job.atPlayhead ? 'comp.time' : Number(job.start ?? 0)};`, '    writeJsonReceipt(\'{"status":"CAUSYNE_LIVE_OK","host":"after-effects","operation":"insert_in_active_timeline","activeCompName":\' + JSON.stringify(String(comp.name)) + \',"startTime":\' + layer.startTime + \'}\');');
        }
    }
    else if (job.canonicalHost === 'illustrator') {
        lines.push('    if (app.documents.length === 0) { throw new Error("No active document is open in Illustrator"); }', '    var doc = app.activeDocument;');
        if (job.operation === 'inspect_active') {
            lines.push('    writeJsonReceipt(\'{"status":"CAUSYNE_LIVE_OK","host":"illustrator","operation":"inspect_active","documentName":\' + JSON.stringify(String(doc.name)) + \',"width":\' + Number(doc.width) + \',"height":\' + Number(doc.height) + \',"artboardCount":\' + doc.artboards.length + \',"layerCount":\' + doc.layers.length + \'}\');');
        }
        else if (job.operation === 'export_canvas_preview') {
            const outLit = JSON.stringify(job.output ?? '');
            lines.push('    var exportOpts = new ExportOptionsPNG24();', '    exportOpts.artBoardClipping = true;', `    doc.exportFile(new File(${outLit}), ExportType.PNG24, exportOpts);`, `    writeJsonReceipt('{"status":"CAUSYNE_LIVE_OK","host":"illustrator","operation":"export_canvas_preview","documentName":' + JSON.stringify(String(doc.name)) + ',"output":' + JSON.stringify(${outLit}) + '}');`);
        }
        else if (job.operation === 'place_in_active_canvas') {
            const inLit = JSON.stringify(job.input ?? '');
            lines.push('    var placed = doc.placedItems.add();', `    placed.file = new File(${inLit});`, ...(job.bounds
                ? [
                    `    placed.position = [${job.bounds.left}, ${-job.bounds.top}];`,
                    `    placed.width = ${job.bounds.width};`,
                    `    placed.height = ${job.bounds.height};`
                ]
                : []), '    writeJsonReceipt(\'{"status":"CAUSYNE_LIVE_OK","host":"illustrator","operation":"place_in_active_canvas","documentName":\' + JSON.stringify(String(doc.name)) + \'}\');');
        }
    }
    else if (job.canonicalHost === 'indesign') {
        lines.push('    if (app.documents.length === 0) { throw new Error("No active document is open in InDesign"); }', '    var doc = app.activeDocument;');
        if (job.operation === 'inspect_active') {
            lines.push('    writeJsonReceipt(\'{"status":"CAUSYNE_LIVE_OK","host":"indesign","operation":"inspect_active","documentName":\' + JSON.stringify(String(doc.name)) + \',"pages":\' + doc.pages.length + \',"spreads":\' + doc.spreads.length + \'}\');');
        }
        else if (job.operation === 'place_in_active_canvas') {
            const inLit = JSON.stringify(job.input ?? '');
            lines.push(`    doc.pages[0].place(new File(${inLit}));`, '    writeJsonReceipt(\'{"status":"CAUSYNE_LIVE_OK","host":"indesign","operation":"place_in_active_canvas","documentName":\' + JSON.stringify(String(doc.name)) + \'}\');');
        }
    }
    else {
        lines.push('    writeJsonReceipt(\'{"status":"CAUSYNE_LIVE_OK","host":"media-encoder","operation":"inspect_active"}\');');
    }
    lines.push('  } catch (err) {', '    var msg = String(err && err.message ? err.message : err);', '    writeJsonReceipt(\'{"status":"CAUSYNE_LIVE_ERR","error":\' + JSON.stringify(msg) + \'}\');', '  }', '})();');
    return lines.join('\n');
}
const MACOS_APP_DISPLAY_NAMES = {
    photoshop: 'Adobe Photoshop',
    premiere: 'Adobe Premiere Pro',
    'after-effects': 'Adobe After Effects',
    illustrator: 'Adobe Illustrator',
    indesign: 'Adobe InDesign',
    'media-encoder': 'Adobe Media Encoder'
};
export function buildAdobeHostInvocationPlan(platform, host, scriptFile, installedEntries, programFilesRoot = 'C:\\Program Files') {
    if (platform === 'darwin') {
        const appPrefix = MACOS_APP_DISPLAY_NAMES[host];
        const entries = installedEntries ?? [`${appPrefix} 2026.app`];
        const matchedApp = entries.find(a => a.startsWith(appPrefix) && a.endsWith('.app'));
        if (!matchedApp)
            return null;
        const appName = matchedApp.replace(/\.app$/, '');
        const appleScript = host === 'after-effects'
            ? `tell application "${appName}" to DoScriptFile POSIX file ${JSON.stringify(scriptFile)}`
            : `tell application "${appName}" to do javascript file POSIX file ${JSON.stringify(scriptFile)}`;
        return {
            platform,
            host,
            command: 'osascript',
            args: ['-e', appleScript]
        };
    }
    if (platform === 'win32') {
        const exeNameMap = {
            photoshop: { folder: /Photoshop/i, defaultFolder: 'Adobe Photoshop 2026', exe: 'Photoshop.exe' },
            premiere: { folder: /Premiere/i, defaultFolder: 'Adobe Premiere Pro 2026', exe: 'Adobe Premiere Pro.exe' },
            'after-effects': { folder: /After Effects/i, defaultFolder: 'Adobe After Effects 2026', exe: 'AfterFX.exe' },
            illustrator: { folder: /Illustrator/i, defaultFolder: 'Adobe Illustrator 2026', exe: 'Illustrator.exe' },
            indesign: { folder: /InDesign/i, defaultFolder: 'Adobe InDesign 2026', exe: 'InDesign.exe' },
            'media-encoder': { folder: /Media Encoder/i, defaultFolder: 'Adobe Media Encoder 2026', exe: 'Adobe Media Encoder.exe' }
        };
        const target = exeNameMap[host];
        const entries = installedEntries ?? [target.defaultFolder];
        const matchedDir = entries.find(d => target.folder.test(d));
        if (!matchedDir)
            return null;
        const exePath = `${programFilesRoot}\\Adobe\\${matchedDir}\\${target.exe}`;
        return {
            platform,
            host,
            command: exePath,
            args: ['-r', scriptFile]
        };
    }
    return null;
}
export function runSimulatedAdobeExtendScript(jsxCode) {
    const unitVal = (num) => ({
        value: num,
        as: () => num
    });
    class SimFile {
        filePath;
        encoding = 'UTF-8';
        content = '';
        constructor(p) {
            this.filePath = p;
        }
        open(_mode) {
            return true;
        }
        write(text) {
            this.content += String(text);
        }
        close() {
            fsSync.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fsSync.writeFileSync(this.filePath, this.content, 'utf8');
        }
    }
    class SimCompItem {
        name = 'Causyne_Main_Comp';
        width = 1920;
        height = 1080;
        duration = 15;
        frameRate = 24;
        numLayers = 2;
        time = 2.5;
        layers = {
            add: (_item) => {
                this.numLayers += 1;
                return { startTime: 0 };
            }
        };
    }
    const activeLayerObj = {
        name: 'Background',
        bounds: [unitVal(0), unitVal(0), unitVal(1920), unitVal(1080)],
        resize: (_sx, _sy) => { },
        translate: (_dx, _dy) => { }
    };
    const docObj = {
        name: 'Causyne_Studio_Master.psd',
        width: Object.assign(Number(1920), { as: () => 1920 }),
        height: Object.assign(Number(1080), { as: () => 1080 }),
        activeLayer: activeLayerObj,
        layers: [activeLayerObj],
        artboards: [{ name: 'Artboard 1' }],
        pages: [{ place: (_f) => { } }],
        spreads: [{}],
        placedItems: {
            add: () => ({ file: null, position: [0, 0], width: 100, height: 100 })
        },
        selection: {
            bounds: [unitVal(100), unitVal(120), unitVal(500), unitVal(420)],
            select: (_pts) => { }
        },
        duplicate: (_name) => ({
            width: unitVal(1920),
            height: unitVal(1080),
            trim: () => { },
            flatten: () => { },
            resizeImage: () => { },
            saveAs: (fileObj) => {
                fsSync.mkdirSync(path.dirname(fileObj.filePath), { recursive: true });
                fsSync.writeFileSync(fileObj.filePath, 'SIMULATED_PNG_PREVIEW', 'utf8');
            },
            close: () => { }
        }),
        exportFile: (fileObj) => {
            fsSync.mkdirSync(path.dirname(fileObj.filePath), { recursive: true });
            fsSync.writeFileSync(fileObj.filePath, 'SIMULATED_ILLUSTRATOR_PNG', 'utf8');
        }
    };
    const activeComp = new SimCompItem();
    const trackObj = {
        insertClip: (_item, _time) => { }
    };
    const seqObj = {
        name: 'Causyne_Edit_Sequence_01',
        getPlayerPosition: () => ({ seconds: 12.5 }),
        videoTracks: Object.assign([trackObj, trackObj], { numTracks: 2 }),
        audioTracks: Object.assign([trackObj, trackObj], { numTracks: 2 })
    };
    const sandbox = {
        File: SimFile,
        Units: { PIXELS: 'PIXELS' },
        TrimType: { TRANSPARENT: 'TRANSPARENT' },
        ResampleMethod: { BICUBIC: 'BICUBIC' },
        SaveOptions: { DONOTSAVECHANGES: 'DONOTSAVECHANGES' },
        Extension: { LOWERCASE: 'LOWERCASE' },
        DialogModes: { NO: 'NO' },
        AnchorPosition: { TOPLEFT: 'TOPLEFT', MIDDLECENTER: 'MIDDLECENTER' },
        ExportType: { PNG24: 'PNG24' },
        PNGSaveOptions: function PNGSaveOptions() { },
        ExportOptionsPNG24: function ExportOptionsPNG24() { },
        ImportOptions: function ImportOptions(f) {
            this.file = f;
        },
        CompItem: SimCompItem,
        UnitValue: (n) => unitVal(n),
        charIDToTypeID: (id) => id,
        ActionDescriptor: function ActionDescriptor() {
            this.putPath = () => { };
            this.putEnumerated = () => { };
            this.putClass = () => { };
            this.putReference = () => { };
        },
        ActionReference: function ActionReference() {
            this.putEnumerated = () => { };
        },
        executeAction: () => { },
        app: {
            preferences: { rulerUnits: 'PIXELS' },
            documents: [docObj],
            activeDocument: docObj,
            project: {
                name: 'Causyne_Production.prproj',
                activeSequence: seqObj,
                activeItem: activeComp,
                rootItem: {
                    children: Object.assign([{ name: 'ImportedClip' }], { numItems: 1 })
                },
                importFiles: () => true,
                importFile: () => ({ name: 'ImportedFootage' })
            }
        },
        JSON,
        Math,
        Number,
        String,
        Boolean,
        Array,
        Error
    };
    vm.runInNewContext(jsxCode, sandbox, { timeout: 5000 });
}
export async function runAdobeLiveBridge(value, workspace = process.cwd(), signal) {
    signal?.throwIfAborted();
    const job = validateAdobeLiveJob(value);
    if (job.input) {
        job.input = await resolveWorkspacePath(job.input, workspace, true);
    }
    if (job.output) {
        job.output = await resolveWorkspacePath(job.output, workspace, false);
        await fs.mkdir(path.dirname(job.output), { recursive: true });
    }
    if (job.canonicalHost === 'resolve') {
        const resolveAction = job.operation === 'inspect_active' ? 'inspectActive' : 'insertClipAtPlayhead';
        return await runResolveBridge({
            action: resolveAction,
            mediaPath: job.input,
            simulate: job.simulateHost
        }, { simulate: job.simulateHost });
    }
    const cachedMask = getLatestSelectionMask();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-adobe-live-'));
    const scriptFile = path.join(tempDir, 'live_bridge.jsx');
    const receiptFile = path.join(tempDir, 'live_receipt.json');
    try {
        const jsx = buildAdobeLiveExtendScript(job, receiptFile, cachedMask?.bounds ?? null);
        await fs.writeFile(scriptFile, jsx, 'utf8');
        if (job.stageOnly) {
            const stagedDir = path.join(workspace, '.causyne_studio_bridge');
            await fs.mkdir(stagedDir, { recursive: true });
            const stagedScriptPath = path.join(stagedDir, `${job.canonicalHost}_${job.operation}.jsx`);
            await fs.writeFile(stagedScriptPath, jsx, 'utf8');
            return {
                success: true,
                mode: 'staged_jsx',
                host: job.canonicalHost,
                operation: job.operation,
                scriptPath: stagedScriptPath
            };
        }
        if (job.simulateHost || process.env.CAUSYNE_SIMULATE_DCC === '1') {
            runSimulatedAdobeExtendScript(jsx);
        }
        else if (process.platform === 'darwin') {
            const apps = await fs.readdir('/Applications').catch(() => []);
            const plan = buildAdobeHostInvocationPlan('darwin', job.canonicalHost, scriptFile, apps);
            if (!plan) {
                const appPrefix = MACOS_APP_DISPLAY_NAMES[job.canonicalHost];
                return {
                    success: false,
                    host: job.canonicalHost,
                    operation: job.operation,
                    error: `${appPrefix} is not installed in /Applications. Pass stageOnly=true or simulateHost=true to verify without installation.`
                };
            }
            await execFileAsync(plan.command, plan.args, { timeout: 60000, signal });
        }
        else if (process.platform === 'win32') {
            const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
            const adobeRoot = path.join(programFiles, 'Adobe');
            const dirs = await fs.readdir(adobeRoot).catch(() => []);
            const plan = buildAdobeHostInvocationPlan('win32', job.canonicalHost, scriptFile, dirs, programFiles);
            if (!plan) {
                return {
                    success: false,
                    host: job.canonicalHost,
                    operation: job.operation,
                    error: `Adobe ${job.canonicalHost} is not installed in ${adobeRoot}. Pass stageOnly=true or simulateHost=true to verify without installation.`
                };
            }
            await execFileAsync(plan.command, plan.args, { timeout: 60000, signal });
        }
        else {
            return {
                success: false,
                host: job.canonicalHost,
                operation: job.operation,
                error: `Native desktop IPC for ${job.canonicalHost} requires macOS or Windows (or pass simulateHost=true).`
            };
        }
        const rawReceipt = await fs.readFile(receiptFile, 'utf8').catch(() => '');
        if (!rawReceipt.trim()) {
            return {
                success: false,
                host: job.canonicalHost,
                operation: job.operation,
                error: 'Host application did not write a live bridge receipt.'
            };
        }
        const parsed = JSON.parse(rawReceipt);
        if (parsed.status === 'CAUSYNE_LIVE_ERR') {
            return {
                success: false,
                host: job.canonicalHost,
                operation: job.operation,
                error: String(parsed.error ?? 'Unknown Adobe live bridge error')
            };
        }
        if (Array.isArray(parsed.selectionBounds) && parsed.selectionBounds.length === 4) {
            const [left, top, right, bottom] = parsed.selectionBounds.map(Number);
            if (left !== undefined &&
                top !== undefined &&
                right !== undefined &&
                bottom !== undefined &&
                Number.isFinite(left) &&
                Number.isFinite(top) &&
                Number.isFinite(right) &&
                Number.isFinite(bottom)) {
                rememberSelectionMask(String(parsed.documentName ?? 'active_document'), {
                    left,
                    top,
                    right,
                    bottom,
                    width: Math.max(1, right - left),
                    height: Math.max(1, bottom - top)
                });
            }
        }
        return {
            success: true,
            ...parsed
        };
    }
    finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => { });
    }
}
export function validateGameEngineJob(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Game engine bridge job must be an object');
    }
    const raw = value;
    const engineInput = String(raw.engine ?? raw.host ?? 'unreal').trim().toLowerCase();
    const canonicalEngine = GAME_ENGINE_ALIASES[engineInput];
    if (!canonicalEngine) {
        throw new Error(`Unsupported game engine "${String(raw.engine ?? raw.host)}". Supported engines: unreal, unity, godot.`);
    }
    const opInput = String(raw.engineOperation ?? raw.operation ?? 'import_assets').trim();
    const validOps = ['remote_control', 'import_assets', 'spawn_actor'];
    if (!validOps.includes(opInput)) {
        throw new Error(`Unsupported engineOperation "${opInput}". Supported: ${validOps.join(', ')}`);
    }
    if (opInput === 'remote_control' && canonicalEngine !== 'unreal') {
        throw new Error('remote_control HTTP bridge on port 30010 is specific to Unreal Engine (unreal)');
    }
    const remotePort = typeof raw.remotePort === 'number' && Number.isInteger(raw.remotePort)
        ? raw.remotePort
        : 30010;
    if (remotePort < 1024 || remotePort > 65535) {
        throw new Error('remotePort must be between 1024 and 65535');
    }
    const assets = Array.isArray(raw.assets)
        ? raw.assets.map(a => String(a).trim()).filter(Boolean)
        : typeof raw.input === 'string' && raw.input.trim()
            ? [raw.input.trim()]
            : undefined;
    if (opInput === 'import_assets' && (!assets || assets.length === 0)) {
        throw new Error('import_assets requires at least one workspace file in assets (or input)');
    }
    const parseVec3 = (v, fallback) => {
        if (!Array.isArray(v) || v.length !== 3)
            return fallback;
        const nums = v.map(Number);
        if (nums.some(n => !Number.isFinite(n))) {
            throw new Error('3D vector coordinates must contain 3 finite numbers');
        }
        return [nums[0], nums[1], nums[2]];
    };
    return {
        engine: engineInput,
        canonicalEngine,
        engineOperation: opInput,
        projectPath: typeof raw.projectPath === 'string' && raw.projectPath.trim() ? raw.projectPath.trim() : '.',
        assets,
        destinationFolder: typeof raw.destinationFolder === 'string' && raw.destinationFolder.trim()
            ? raw.destinationFolder.trim()
            : undefined,
        objectPath: typeof raw.objectPath === 'string' ? raw.objectPath.trim() : undefined,
        functionName: typeof raw.functionName === 'string' ? raw.functionName.trim() : undefined,
        propertyName: typeof raw.propertyName === 'string' ? raw.propertyName.trim() : undefined,
        propertyValue: raw.propertyValue,
        parameters: raw.parameters && typeof raw.parameters === 'object' && !Array.isArray(raw.parameters)
            ? raw.parameters
            : undefined,
        remotePort,
        actorName: typeof raw.actorName === 'string' && raw.actorName.trim() ? raw.actorName.trim() : 'CausyneActor',
        actorClass: typeof raw.actorClass === 'string' && raw.actorClass.trim() ? raw.actorClass.trim() : 'StaticMeshActor',
        assetPath: typeof raw.assetPath === 'string' && raw.assetPath.trim() ? raw.assetPath.trim() : undefined,
        location: parseVec3(raw.location, [0, 0, 0]),
        rotation: parseVec3(raw.rotation, [0, 0, 0]),
        scale: parseVec3(raw.scale, [1, 1, 1]),
        executeHeadless: raw.executeHeadless === undefined ? true : Boolean(raw.executeHeadless)
    };
}
export function buildUnrealPythonScript(job, resolvedAssets) {
    const destContentPath = job.destinationFolder?.startsWith('/Game/')
        ? job.destinationFolder
        : `/Game/${(job.destinationFolder || 'CausyneAssets').replace(/^\/+|\/+$/g, '')}`;
    if (job.engineOperation === 'import_assets') {
        return [
            '# Generated by Causyne Agent — Unreal Engine 5 Native Python Bridge',
            'import unreal',
            '',
            'def run_causyne_import():',
            '    asset_tools = unreal.AssetToolsHelpers.get_asset_tools()',
            '    tasks = []',
            `    dest_path = ${JSON.stringify(destContentPath)}`,
            `    files = ${JSON.stringify(resolvedAssets)}`,
            '    for file_path in files:',
            '        task = unreal.AssetImportTask()',
            '        task.set_editor_property("filename", file_path)',
            '        task.set_editor_property("destination_path", dest_path)',
            '        task.set_editor_property("automated", True)',
            '        task.set_editor_property("save", True)',
            '        task.set_editor_property("replace_existing", True)',
            '        tasks.append(task)',
            '    asset_tools.import_asset_tasks(tasks)',
            '    unreal.EditorAssetLibrary.save_directory(dest_path, only_if_is_dirty=False, recursive=True)',
            '    unreal.log("CAUSYNE_UNREAL_IMPORT_COMPLETE:" + dest_path)',
            '',
            'if __name__ == "__main__":',
            '    run_causyne_import()',
            ''
        ].join('\n');
    }
    const [lx, ly, lz] = job.location ?? [0, 0, 0];
    const [rx, ry, rz] = job.rotation ?? [0, 0, 0];
    const [sx, sy, sz] = job.scale ?? [1, 1, 1];
    return [
        '# Generated by Causyne Agent — Unreal Engine 5 Level Actor Spawner',
        'import unreal',
        '',
        'def run_causyne_spawn():',
        `    actor_label = ${JSON.stringify(job.actorName ?? 'CausyneActor')}`,
        `    asset_path = ${JSON.stringify(job.assetPath ?? '')}`,
        `    loc = unreal.Vector(${lx}, ${ly}, ${lz})`,
        `    rot = unreal.Rotator(${rx}, ${ry}, ${rz})`,
        '    if asset_path:',
        '        loaded_asset = unreal.EditorAssetLibrary.load_asset(asset_path)',
        '        actor = unreal.EditorLevelLibrary.spawn_actor_from_object(loaded_asset, loc, rot)',
        '    else:',
        `        actor_cls = getattr(unreal, ${JSON.stringify(job.actorClass ?? 'StaticMeshActor')}, unreal.StaticMeshActor)`,
        '        actor = unreal.EditorLevelLibrary.spawn_actor_from_class(actor_cls, loc, rot)',
        '    if actor:',
        '        actor.set_actor_label(actor_label)',
        `        actor.set_actor_scale3d(unreal.Vector(${sx}, ${sy}, ${sz}))`,
        '        unreal.EditorLevelLibrary.save_current_level()',
        '        unreal.log("CAUSYNE_UNREAL_SPAWN_COMPLETE:" + actor_label)',
        '',
        'if __name__ == "__main__":',
        '    run_causyne_spawn()',
        ''
    ].join('\n');
}
export function buildUnityEditorScript(job, relativeAssetPaths) {
    const [lx, ly, lz] = job.location ?? [0, 0, 0];
    const [rx, ry, rz] = job.rotation ?? [0, 0, 0];
    const [sx, sy, sz] = job.scale ?? [1, 1, 1];
    const assetListLiteral = relativeAssetPaths.map(p => `            ${JSON.stringify(p.replace(/\\/g, '/'))}`).join(',\n');
    return [
        '// Generated by Causyne Agent — Unity Editor Direct Automation Bridge',
        'using System;',
        'using UnityEditor;',
        'using UnityEditor.SceneManagement;',
        'using UnityEngine;',
        '',
        'public static class CausyneUnityBridge',
        '{',
        '    [MenuItem("Causyne/Execute Staged Bridge Job")]',
        '    public static void ExecuteBatch()',
        '    {',
        '        AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);',
        '        string[] importedAssets = new string[]',
        '        {',
        assetListLiteral,
        '        };',
        '        foreach (string assetPath in importedAssets)',
        '        {',
        '            if (!string.IsNullOrEmpty(assetPath))',
        '            {',
        '                AssetDatabase.ImportAsset(assetPath, ImportAssetOptions.ForceUpdate);',
        '            }',
        '        }',
        ...(job.engineOperation === 'spawn_actor'
            ? [
                `        GameObject spawned = null;`,
                `        string prefabPath = ${JSON.stringify(job.assetPath ?? '')};`,
                '        if (!string.IsNullOrEmpty(prefabPath))',
                '        {',
                '            GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);',
                '            if (prefab != null) spawned = (GameObject)PrefabUtility.InstantiatePrefab(prefab);',
                '        }',
                '        if (spawned == null)',
                '        {',
                '            spawned = GameObject.CreatePrimitive(PrimitiveType.Cube);',
                '        }',
                `        spawned.name = ${JSON.stringify(job.actorName ?? 'CausyneActor')};`,
                `        spawned.transform.position = new Vector3(${lx}f, ${ly}f, ${lz}f);`,
                `        spawned.transform.eulerAngles = new Vector3(${rx}f, ${ry}f, ${rz}f);`,
                `        spawned.transform.localScale = new Vector3(${sx}f, ${sy}f, ${sz}f);`,
                '        EditorSceneManager.MarkSceneDirty(EditorSceneManager.GetActiveScene());',
                '        EditorSceneManager.SaveOpenScenes();'
            ]
            : []),
        '        AssetDatabase.SaveAssets();',
        '        Debug.Log("CAUSYNE_UNITY_BRIDGE_COMPLETE");',
        '    }',
        '}',
        ''
    ].join('\n');
}
export function buildGodotImportScript(job, resPaths) {
    const [lx, ly, lz] = job.location ?? [0, 0, 0];
    const [sx, sy, sz] = job.scale ?? [1, 1, 1];
    return [
        '# Generated by Causyne Agent — Godot 4 Headless SceneTree Bridge',
        'extends SceneTree',
        '',
        'func _init() -> void:',
        `    var imported_assets := ${JSON.stringify(resPaths)}`,
        '    print("CAUSYNE_GODOT_ASSETS_STAGED:", imported_assets.size())',
        ...(job.engineOperation === 'spawn_actor'
            ? [
                '    var root := Node3D.new()',
                '    root.name = "CausyneSceneRoot"',
                '    var actor := Node3D.new()',
                `    actor.name = ${JSON.stringify(job.actorName ?? 'CausyneActor')}`,
                `    actor.position = Vector3(${lx}, ${ly}, ${lz})`,
                `    actor.scale = Vector3(${sx}, ${sy}, ${sz})`,
                '    root.add_child(actor)',
                '    actor.owner = root',
                '    var packed := PackedScene.new()',
                '    if packed.pack(root) == OK:',
                '        ResourceSaver.save(packed, "res://causyne_spawned_actor.tscn")',
                '        print("CAUSYNE_GODOT_SPAWN_COMPLETE:res://causyne_spawned_actor.tscn")'
            ]
            : []),
        '    quit(0)',
        ''
    ].join('\n');
}
export async function runGameEngineBridge(value, workspace = process.cwd(), signal) {
    signal?.throwIfAborted();
    const job = validateGameEngineJob(value);
    if (job.engineOperation === 'remote_control') {
        const port = job.remotePort ?? 30010;
        const baseUrl = `http://127.0.0.1:${port}`;
        try {
            if (!job.objectPath) {
                const infoRes = await fetch(`${baseUrl}/remote/info`, { method: 'GET', signal: signal ?? null });
                const data = await infoRes.json().catch(() => ({}));
                return {
                    success: infoRes.ok,
                    engine: 'unreal',
                    operation: 'remote_control',
                    endpoint: `${baseUrl}/remote/info`,
                    status: infoRes.status,
                    response: data
                };
            }
            const isCall = Boolean(job.functionName);
            const endpoint = isCall ? `${baseUrl}/remote/object/call` : `${baseUrl}/remote/object/property`;
            const payload = isCall
                ? {
                    objectPath: job.objectPath,
                    functionName: job.functionName,
                    parameters: job.parameters ?? {},
                    generateTransaction: true
                }
                : {
                    objectPath: job.objectPath,
                    propertyName: job.propertyName,
                    propertyValue: job.propertyValue,
                    access: job.propertyValue === undefined ? 'READ_ACCESS' : 'WRITE_TRANSACTION_ACCESS'
                };
            const res = await fetch(endpoint, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: signal ?? null
            });
            const data = await res.json().catch(() => ({}));
            return {
                success: res.ok,
                engine: 'unreal',
                operation: 'remote_control',
                endpoint,
                status: res.status,
                response: data
            };
        }
        catch (err) {
            return {
                success: false,
                engine: 'unreal',
                operation: 'remote_control',
                endpoint: baseUrl,
                error: `Unreal Remote Control HTTP bridge at ${baseUrl} is unreachable (${err instanceof Error ? err.message : String(err)}). Ensure Unreal Editor is running with the Remote Control API plugin enabled, or use engineOperation="import_assets" / "spawn_actor" for Python CLI automation.`
            };
        }
    }
    const projectRoot = await resolveWorkspacePath(job.projectPath ?? '.', workspace, false);
    await fs.mkdir(projectRoot, { recursive: true });
    const resolvedAssets = [];
    for (const asset of job.assets ?? []) {
        resolvedAssets.push(await resolveWorkspacePath(asset, workspace, true));
    }
    if (job.canonicalEngine === 'unreal') {
        const bridgeDir = path.join(projectRoot, 'Saved', 'CausyneBridge');
        await fs.mkdir(bridgeDir, { recursive: true });
        const scriptPath = path.join(bridgeDir, `causyne_unreal_${job.engineOperation}.py`);
        const pythonCode = buildUnrealPythonScript(job, resolvedAssets);
        await fs.writeFile(scriptPath, pythonCode, 'utf8');
        const unrealBin = findUnrealEngine();
        const projectEntries = await fs.readdir(projectRoot).catch(() => []);
        const uprojectFile = projectEntries.find(f => f.endsWith('.uproject'));
        if (unrealBin && uprojectFile && job.executeHeadless !== false) {
            const uprojectPath = path.join(projectRoot, uprojectFile);
            const { stdout, stderr } = await execFileAsync(unrealBin.executable, [uprojectPath, '-run=pythonscript', `-script=${scriptPath}`, '-unattended', '-nopause', '-nosplash'], { timeout: 180000, maxBuffer: 4 * 1024 * 1024, signal });
            return {
                success: true,
                engine: 'unreal',
                mode: 'executed_cli',
                operation: job.engineOperation,
                executable: unrealBin.executable,
                uproject: uprojectPath,
                scriptPath,
                assetsCount: resolvedAssets.length,
                stdoutTail: stdout.slice(-1000),
                stderrTail: stderr.slice(-500)
            };
        }
        return {
            success: true,
            engine: 'unreal',
            mode: 'staged_python_bridge',
            operation: job.engineOperation,
            scriptPath,
            assetsCount: resolvedAssets.length,
            installedBinary: unrealBin?.executable ?? null
        };
    }
    if (job.canonicalEngine === 'unity') {
        const destRel = (job.destinationFolder || 'Assets/CausyneAssets').replace(/^\/+|\/+$/g, '');
        const normalizedDestRel = destRel.startsWith('Assets') ? destRel : path.join('Assets', destRel);
        const destAbs = path.join(projectRoot, normalizedDestRel);
        const editorDir = path.join(projectRoot, 'Assets', 'Editor');
        await fs.mkdir(destAbs, { recursive: true });
        await fs.mkdir(editorDir, { recursive: true });
        const copiedRelativePaths = [];
        for (const srcFile of resolvedAssets) {
            const fileName = path.basename(srcFile);
            const destFile = path.join(destAbs, fileName);
            if (path.resolve(srcFile) !== path.resolve(destFile)) {
                await fs.copyFile(srcFile, destFile);
            }
            copiedRelativePaths.push(path.posix.join(normalizedDestRel.replace(/\\/g, '/'), fileName));
        }
        const csPath = path.join(editorDir, 'CausyneUnityBridge.cs');
        const csCode = buildUnityEditorScript(job, copiedRelativePaths);
        await fs.writeFile(csPath, csCode, 'utf8');
        const unityBin = findUnityEditor();
        const hasProjectSettings = fsSync.existsSync(path.join(projectRoot, 'ProjectSettings'));
        if (unityBin && hasProjectSettings && job.executeHeadless !== false) {
            const { stdout, stderr } = await execFileAsync(unityBin.executable, [
                '-batchmode',
                '-nographics',
                '-quit',
                '-projectPath',
                projectRoot,
                '-executeMethod',
                'CausyneUnityBridge.ExecuteBatch'
            ], { timeout: 180000, maxBuffer: 4 * 1024 * 1024, signal });
            return {
                success: true,
                engine: 'unity',
                mode: 'executed_batchmode',
                operation: job.engineOperation,
                executable: unityBin.executable,
                editorScriptPath: csPath,
                importedAssets: copiedRelativePaths,
                stdoutTail: stdout.slice(-1000),
                stderrTail: stderr.slice(-500)
            };
        }
        return {
            success: true,
            engine: 'unity',
            mode: 'staged_editor_bridge',
            operation: job.engineOperation,
            editorScriptPath: csPath,
            importedAssets: copiedRelativePaths,
            installedBinary: unityBin?.executable ?? null
        };
    }
    // Godot 4 Engine Bridge
    const destRel = (job.destinationFolder || 'assets/causyne').replace(/^res:\/\/|^\/+|\/+$/g, '');
    const destAbs = path.join(projectRoot, destRel);
    await fs.mkdir(destAbs, { recursive: true });
    const resPaths = [];
    for (const srcFile of resolvedAssets) {
        const fileName = path.basename(srcFile);
        const destFile = path.join(destAbs, fileName);
        if (path.resolve(srcFile) !== path.resolve(destFile)) {
            await fs.copyFile(srcFile, destFile);
        }
        resPaths.push(`res://${destRel.replace(/\\/g, '/')}/${fileName}`);
    }
    const gdScriptPath = path.join(projectRoot, '.causyne_godot_bridge.gd');
    const gdCode = buildGodotImportScript(job, resPaths);
    await fs.writeFile(gdScriptPath, gdCode, 'utf8');
    const godotBin = findGodotEngine();
    const hasProjectGodot = fsSync.existsSync(path.join(projectRoot, 'project.godot'));
    if (godotBin && hasProjectGodot && job.executeHeadless !== false) {
        const { stdout, stderr } = await execFileAsync(godotBin.executable, ['--headless', '--path', projectRoot, '--script', gdScriptPath], { timeout: 60000, maxBuffer: 2 * 1024 * 1024, signal });
        return {
            success: true,
            engine: 'godot',
            mode: 'executed_headless',
            operation: job.engineOperation,
            executable: godotBin.executable,
            scriptPath: gdScriptPath,
            importedAssets: resPaths,
            stdoutTail: stdout.slice(-1000),
            stderrTail: stderr.slice(-500)
        };
    }
    return {
        success: true,
        engine: 'godot',
        mode: 'staged_gdscript_bridge',
        operation: job.engineOperation,
        scriptPath: gdScriptPath,
        importedAssets: resPaths,
        installedBinary: godotBin?.executable ?? null
    };
}
export async function scaffoldCausyneUxpPlugin(outputDirInput, workspace = process.cwd(), options = {}) {
    const pluginDir = await resolveWorkspacePath(outputDirInput || 'causyne-uxp-bridge', workspace, false);
    await fs.mkdir(pluginDir, { recursive: true });
    const wsPort = options.websocketPort && options.websocketPort >= 1024 && options.websocketPort <= 65535
        ? options.websocketPort
        : 8080;
    const manifest = {
        id: 'com.causyne.studio.bridge',
        name: 'Causyne Studio Bridge',
        version: '1.0.0',
        main: 'index.html',
        manifestVersion: 5,
        host: [
            { app: 'PS', minVersion: '24.4.0' },
            { app: 'PPRO', minVersion: '25.2.0' }
        ],
        entrypoints: [
            {
                type: 'panel',
                id: 'com.causyne.studio.bridge.panel',
                label: { default: 'Causyne Bridge' },
                minimumSize: { width: 280, height: 360 },
                maximumSize: { width: 2400, height: 2400 },
                preferredDockedSize: { width: 340, height: 520 },
                preferredFloatingSize: { width: 380, height: 600 }
            }
        ],
        requiredPermissions: {
            localFileSystem: 'fullAccess',
            network: {
                domains: [`ws://127.0.0.1:${wsPort}`, `ws://localhost:${wsPort}`, `http://127.0.0.1:${wsPort}`]
            },
            webview: {
                allow: 'yes',
                domains: ['https://*.causyne.com', `http://127.0.0.1:${wsPort}`],
                enableMessageBridge: 'localAndRemote'
            },
            ipc: {
                enablePluginCommunication: true
            }
        }
    };
    const bridgeJs = `// Causyne Studio UXP Native Bridge (Photoshop & Premiere Pro)
const uxp = require("uxp");
const fs = uxp.storage.localFileSystem;

function getHostModule(name) {
  try { return require(name); } catch (_) { return null; }
}

const photoshop = getHostModule("photoshop");
const premierepro = getHostModule("premierepro");

const selectionMaskCache = new Map();
const MAX_MASKS = 128;

function rememberSelection(docId, bounds) {
  if (selectionMaskCache.has(docId)) selectionMaskCache.delete(docId);
  selectionMaskCache.set(docId, { bounds, capturedAt: Date.now() });
  while (selectionMaskCache.size > MAX_MASKS) {
    const oldest = selectionMaskCache.keys().next().value;
    if (oldest === undefined) break;
    selectionMaskCache.delete(oldest);
  }
}

async function exportActivePhotoshopCanvasPreview(options = {}) {
  if (!photoshop) throw new Error("Photoshop UXP host is not active");
  const doc = photoshop.app.activeDocument;
  if (!doc) throw new Error("No active document in Photoshop");
  const maxDimension = Math.min(1024, Math.max(64, Math.round(Number(options.maxDimension) || 1024)));
  let selectionBounds = null;
  try {
    const sb = doc.selection && doc.selection.bounds;
    if (sb) {
      selectionBounds = { left: sb.left, top: sb.top, right: sb.right, bottom: sb.bottom };
      rememberSelection(doc.id, selectionBounds);
    }
  } catch (_) {}
  return {
    documentId: doc.id,
    documentName: doc.name,
    width: doc.width,
    height: doc.height,
    maxDimension,
    selectionBounds
  };
}

async function placeImageOnCanvas(payload = {}) {
  if (!photoshop) throw new Error("Photoshop UXP host is not active");
  const doc = photoshop.app.activeDocument;
  if (!doc) throw new Error("No active document in Photoshop");
  const entry = await fs.getEntryWithUrl("file:" + payload.filePath);
  const token = fs.createSessionToken(entry);

  await photoshop.core.executeAsModal(async () => {
    await photoshop.action.batchPlay([
      {
        _obj: "placeEvent",
        null: { _path: token, _kind: "local" },
        freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" }
      }
    ], { synchronousExecution: true });

    if (payload.applySelectionMask && selectionMaskCache.has(doc.id)) {
      await photoshop.action.batchPlay([
        {
          _obj: "make",
          new: { _class: "channel" },
          at: { _ref: "channel", _enum: "channel", _value: "mask" },
          using: { _enum: "userMaskEnabled", _value: "revealSelection" }
        }
      ], { synchronousExecution: true });
    }
  }, { commandName: "Causyne Place Asset" });

  return { status: "placed", documentId: doc.id, documentName: doc.name };
}

async function handleBridgeCommand(msg) {
  if (msg.action === "export_canvas_preview") return await exportActivePhotoshopCanvasPreview(msg);
  if (msg.action === "place_in_active_canvas") return await placeImageOnCanvas(msg);
  throw new Error("Unsupported UXP action: " + msg.action);
}

window.causyneUxpBridge = {
  exportActivePhotoshopCanvasPreview,
  placeImageOnCanvas,
  handleBridgeCommand
};
`;
    const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Causyne Studio Bridge</title>
  <style>
    body { background: #121316; color: #eceef2; font-family: system-ui, sans-serif; margin: 0; padding: 16px; }
    .badge { display: inline-block; padding: 4px 8px; border-radius: 4px; background: #1e222a; font-size: 11px; letter-spacing: 0.04em; }
    h1 { font-size: 15px; margin: 12px 0 6px; font-weight: 600; }
    p { font-size: 12px; color: #9aa0ac; line-height: 1.45; margin: 0; }
  </style>
</head>
<body>
  <span class="badge">CAUSYNE UXP BRIDGE v1.0</span>
  <h1>Direct Canvas &amp; Sequence Link</h1>
  <p>Connected to local Causyne Agent over direct machine IPC (ws://127.0.0.1:${wsPort}).</p>
  <script src="bridge.js"></script>
</body>
</html>
`;
    const manifestPath = path.join(pluginDir, 'manifest.json');
    const bridgePath = path.join(pluginDir, 'bridge.js');
    const htmlPath = path.join(pluginDir, 'index.html');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    await fs.writeFile(bridgePath, bridgeJs, 'utf8');
    await fs.writeFile(htmlPath, indexHtml, 'utf8');
    return {
        success: true,
        pluginDir,
        files: [manifestPath, bridgePath, htmlPath],
        websocketEndpoint: `ws://127.0.0.1:${wsPort}`
    };
}
export const MOCK_UNREAL_PY = `# Simulated unreal Python module for cross-platform verification
class Vector:
    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.x, self.y, self.z = x, y, z

class Rotator:
    def __init__(self, r=0.0, p=0.0, y=0.0):
        self.r, self.p, self.y = r, p, y

class AssetImportTask:
    def __init__(self):
        self.props = {}
    def set_editor_property(self, key, val):
        self.props[key] = val

class _AssetTools:
    def import_asset_tasks(self, tasks):
        return len(tasks)

class AssetToolsHelpers:
    @staticmethod
    def get_asset_tools():
        return _AssetTools()

class EditorAssetLibrary:
    @staticmethod
    def save_directory(dest_path, only_if_is_dirty=False, recursive=True):
        return True
    @staticmethod
    def load_asset(asset_path):
        return {"asset_path": asset_path}

class _SpawnedActor:
    def __init__(self):
        self.label = ""
        self.scale = Vector(1, 1, 1)
    def set_actor_label(self, label):
        self.label = label
    def set_actor_scale3d(self, scale):
        self.scale = scale

class StaticMeshActor:
    pass

class EditorLevelLibrary:
    @staticmethod
    def spawn_actor_from_object(obj, loc, rot):
        return _SpawnedActor()
    @staticmethod
    def spawn_actor_from_class(cls, loc, rot):
        return _SpawnedActor()
    @staticmethod
    def save_current_level():
        return True

def log(msg):
    print(str(msg))
`;
export async function runSimulatedUnrealPython(scriptPath) {
    const simDir = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-unreal-sim-'));
    try {
        await fs.writeFile(path.join(simDir, 'unreal.py'), MOCK_UNREAL_PY, 'utf8');
        const pathSep = os.platform() === 'win32' ? ';' : ':';
        const pyBin = os.platform() === 'win32' ? 'python' : 'python3';
        const env = {
            ...process.env,
            PYTHONPATH: [simDir, process.env.PYTHONPATH || ''].filter(Boolean).join(pathSep)
        };
        const { stdout } = await execFileAsync(pyBin, [scriptPath], { timeout: 15000, env });
        return {
            success: stdout.includes('CAUSYNE_UNREAL_IMPORT_COMPLETE') || stdout.includes('CAUSYNE_UNREAL_SPAWN_COMPLETE'),
            stdout: stdout.trim()
        };
    }
    finally {
        await fs.rm(simDir, { recursive: true, force: true }).catch(() => { });
    }
}
export async function verifyAllCreativeAndGameBridges(workspace = process.cwd()) {
    const tempWork = await fs.mkdtemp(path.join(workspace, '.tmp_causyne_bridge_verify_'));
    try {
        const sampleAsset = path.join(tempWork, 'sample_render.png');
        await fs.writeFile(sampleAsset, 'SIMULATED_PNG_DATA', 'utf8');
        // 1. Cross-platform OS command & environment matrix (macOS darwin + Windows win32 + Linux)
        const macPsPlan = buildAdobeHostInvocationPlan('darwin', 'photoshop', '/tmp/test.jsx');
        const winPsPlan = buildAdobeHostInvocationPlan('win32', 'photoshop', 'C:\\temp\\test.jsx');
        const macAePlan = buildAdobeHostInvocationPlan('darwin', 'after-effects', '/tmp/ae.jsx');
        const winPrPlan = buildAdobeHostInvocationPlan('win32', 'premiere', 'C:\\temp\\pr.jsx');
        const resolveMacCfg = buildResolvePlatformConfig('darwin', {});
        const resolveWinCfg = buildResolvePlatformConfig('win32', {});
        const resolveLinuxCfg = buildResolvePlatformConfig('linux', {});
        const crossPlatformMatrixOk = Boolean(macPsPlan?.command === 'osascript' &&
            winPsPlan?.command.endsWith('Photoshop.exe') &&
            macAePlan?.args[1]?.includes('DoScriptFile') &&
            winPrPlan?.command.endsWith('Adobe Premiere Pro.exe') &&
            resolveMacCfg.scriptLib.endsWith('fusionscript.so') &&
            resolveWinCfg.scriptLib.endsWith('fusionscript.dll') &&
            resolveLinuxCfg.scriptLib.endsWith('fusionscript.so'));
        // 2. Simulated Adobe ExtendScript DOM execution (Photoshop, Premiere, After Effects, Illustrator, InDesign)
        const relAsset = path.relative(workspace, sampleAsset);
        const relPreview = path.relative(workspace, path.join(tempWork, 'ps_preview.png'));
        const psPreviewRes = await runAdobeLiveBridge({
            host: 'photoshop',
            liveOperation: 'export_canvas_preview',
            output: relPreview,
            maxDimension: 512,
            simulateHost: true
        }, workspace);
        const psPlaceRes = await runAdobeLiveBridge({
            host: 'photoshop',
            liveOperation: 'place_in_active_canvas',
            input: relAsset,
            fitMode: 'selection',
            applySelectionMask: true,
            simulateHost: true
        }, workspace);
        const prInsertRes = await runAdobeLiveBridge({
            host: 'premiere',
            liveOperation: 'insert_in_active_timeline',
            input: relAsset,
            atPlayhead: true,
            simulateHost: true
        }, workspace);
        const aeInsertRes = await runAdobeLiveBridge({
            host: 'after-effects',
            liveOperation: 'insert_in_active_timeline',
            input: relAsset,
            atPlayhead: true,
            simulateHost: true
        }, workspace);
        // 3. DaVinci Resolve Studio Python Bridge execution (real python3 + simulated DaVinciResolveScript)
        const resolveInspectRes = await runResolveBridge({ action: 'inspectActive' }, { simulate: true });
        const resolveAssembleRes = await runResolveBridge({
            action: 'importAndAssemble',
            mediaPath: sampleAsset,
            markerName: 'Causyne AI Shot'
        }, { simulate: true });
        const resolveGradeRes = await runResolveBridge({
            action: 'applyLutOrGrade',
            lutPath: '/luts/Rec709_Film.cube',
            cdl: { slope: '1.05 1.0 0.98', offset: '0 0 0', power: '1 1 1', saturation: '1.1' }
        }, { simulate: true });
        // 4. Unreal Engine 5 Python execution + Live Remote Control HTTP loopback server test
        const unrealStageRes = await runGameEngineBridge({
            engine: 'unreal',
            engineOperation: 'import_assets',
            projectPath: path.relative(workspace, path.join(tempWork, 'UE5Verify')),
            assets: [relAsset],
            executeHeadless: false
        }, workspace);
        const unrealPySim = await runSimulatedUnrealPython(String(unrealStageRes.scriptPath));
        let unrealRemoteControlOk = false;
        const server = http.createServer((req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.url === '/remote/info') {
                res.end(JSON.stringify({ Routes: [{ Path: '/remote/object/call' }] }));
                return;
            }
            if (req.url === '/remote/object/call' && req.method === 'PUT') {
                res.end(JSON.stringify({ ReturnValue: true }));
                return;
            }
            res.statusCode = 404;
            res.end('{}');
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()));
        try {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : 30010;
            const rcCall = await runGameEngineBridge({
                engine: 'unreal',
                engineOperation: 'remote_control',
                remotePort: port,
                objectPath: '/Script/UnrealEd.Default__EditorActorSubsystem',
                functionName: 'SpawnActorFromClass'
            }, workspace);
            unrealRemoteControlOk = Boolean(rcCall.success);
        }
        finally {
            await new Promise(resolve => server.close(() => resolve()));
        }
        // 5. Unity C# & Godot GDScript staging verification
        const unityStageRes = await runGameEngineBridge({
            engine: 'unity',
            engineOperation: 'spawn_actor',
            projectPath: path.relative(workspace, path.join(tempWork, 'UnityVerify')),
            assets: [relAsset],
            executeHeadless: false
        }, workspace);
        const godotStageRes = await runGameEngineBridge({
            engine: 'godot',
            engineOperation: 'spawn_actor',
            projectPath: path.relative(workspace, path.join(tempWork, 'GodotVerify')),
            assets: [relAsset],
            executeHeadless: false
        }, workspace);
        const allPassed = Boolean(crossPlatformMatrixOk &&
            psPreviewRes.success &&
            psPlaceRes.success &&
            prInsertRes.success &&
            aeInsertRes.success &&
            resolveInspectRes.success &&
            resolveAssembleRes.success &&
            resolveGradeRes.success &&
            unrealPySim.success &&
            unrealRemoteControlOk &&
            unityStageRes.success &&
            godotStageRes.success);
        return {
            success: allPassed,
            crossPlatformMatrix: {
                darwinAndWin32Verified: crossPlatformMatrixOk,
                macPhotoshopCommand: macPsPlan?.command,
                winPhotoshopCommand: winPsPlan?.command,
                resolveMacLib: resolveMacCfg.scriptLib,
                resolveWinLib: resolveWinCfg.scriptLib,
                resolveLinuxLib: resolveLinuxCfg.scriptLib
            },
            adobeDomSimulation: {
                photoshopPreview: Boolean(psPreviewRes.success),
                photoshopSelectionMaskPlace: Boolean(psPlaceRes.success),
                premiereTimelineInsert: Boolean(prInsertRes.success),
                afterEffectsCompInsert: Boolean(aeInsertRes.success)
            },
            davinciResolvePythonSimulation: {
                inspectActive: Boolean(resolveInspectRes.success),
                importAndAssemble: Boolean(resolveAssembleRes.success),
                applyLutOrGrade: Boolean(resolveGradeRes.success)
            },
            gameEnginesVerification: {
                unrealPythonExecution: unrealPySim.success,
                unrealRemoteControlHttp: unrealRemoteControlOk,
                unityCSharpStaged: Boolean(unityStageRes.success),
                godotGdScriptStaged: Boolean(godotStageRes.success)
            }
        };
    }
    finally {
        await fs.rm(tempWork, { recursive: true, force: true }).catch(() => { });
    }
}
