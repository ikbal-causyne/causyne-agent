/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted for Causyne Vision Desktop & Coordinate Grounding Engine.
 */
const DEFAULT_FACTOR = [1000, 1000];
/**
 * Extract numbers from a coordinate string like "(250, 400)" or "[100, 200, 300, 400]"
 */
export function extractCoordinateNumbers(raw) {
    const clean = String(raw || '').replace(/[()[\]]/g, ' ').trim();
    if (!clean)
        return [];
    return clean
        .split(/[\s,]+/)
        .map((s) => Number.parseFloat(s))
        .filter((n) => Number.isFinite(n));
}
/**
 * Ground normalized coordinates (0-1000) to actual screen pixels.
 */
export function groundPoint(nums, screen = { width: 1920, height: 1080, scaleFactor: 1 }, factor = DEFAULT_FACTOR) {
    if (nums.length < 2)
        return null;
    const rawX = nums[0] ?? 0;
    const rawY = nums[1] ?? 0;
    const scale = screen.scaleFactor || 1;
    const normX = Math.max(0, Math.min(1, rawX / factor[0]));
    const normY = Math.max(0, Math.min(1, rawY / factor[1]));
    return {
        x: Math.round(normX * screen.width * scale),
        y: Math.round(normY * screen.height * scale)
    };
}
/**
 * Ground a bounding box (x1, y1, x2, y2) into its midpoint (center click).
 */
export function groundBoxCenter(nums, screen = { width: 1920, height: 1080, scaleFactor: 1 }, factor = DEFAULT_FACTOR) {
    if (nums.length < 2)
        return null;
    if (nums.length === 2) {
        return groundPoint(nums, screen, factor);
    }
    const x1 = nums[0] ?? 0;
    const y1 = nums[1] ?? 0;
    const x2 = nums[2] ?? x1;
    const y2 = nums[3] ?? y1;
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    return groundPoint([midX, midY], screen, factor);
}
/**
 * Parse vision grounding action format:
 * E.g. Action: click(start_box='(240, 500)')
 */
export function parseSingleAction(rawAction, screenContext = { width: 1920, height: 1080, scaleFactor: 1 }) {
    const line = rawAction.trim();
    if (!line)
        return null;
    const callMatch = line.match(/^([a-zA-Z_0-9]+)\s*\((.*)\)$/);
    if (!callMatch) {
        if (/finished/i.test(line)) {
            return { action: 'finished', rawStr: line };
        }
        return null;
    }
    const funcName = callMatch[1]?.toLowerCase();
    const argsRaw = callMatch[2] || '';
    const argsMap = {};
    const kvRegex = /([a-zA-Z_0-9]+)\s*=\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = kvRegex.exec(argsRaw)) !== null) {
        const key = match[1];
        const val = match[2];
        if (key && val) {
            argsMap[key] = val;
        }
    }
    if (Object.keys(argsMap).length === 0) {
        const boxMatch = argsRaw.match(/['"]?(\([0-9\s,.]+\)|\[[0-9\s,.]+\])['"]?/);
        if (boxMatch && boxMatch[1]) {
            argsMap['start_box'] = boxMatch[1];
        }
    }
    const actionObj = {
        action: funcName,
        rawStr: line
    };
    const startBox = argsMap['start_box'] || argsMap['point'] || argsMap['box'];
    if (startBox) {
        const nums = extractCoordinateNumbers(startBox);
        const center = groundBoxCenter(nums, screenContext);
        if (center) {
            actionObj.coordinates = center;
            actionObj.startCoordinates = center;
        }
    }
    const endBox = argsMap['end_box'];
    if (endBox) {
        const nums = extractCoordinateNumbers(endBox);
        const center = groundBoxCenter(nums, screenContext);
        if (center) {
            actionObj.endCoordinates = center;
        }
    }
    if (argsMap['content']) {
        actionObj.text = argsMap['content'];
    }
    if (argsMap['text']) {
        actionObj.text = argsMap['text'];
    }
    if (argsMap['key']) {
        actionObj.key = argsMap['key'];
    }
    if (argsMap['direction']) {
        const dir = argsMap['direction'].toLowerCase();
        if (dir === 'up' || dir === 'down' || dir === 'left' || dir === 'right') {
            actionObj.direction = dir;
        }
    }
    if (argsMap['time'] || argsMap['seconds']) {
        const sec = Number.parseFloat(argsMap['time'] || argsMap['seconds'] || '1');
        actionObj.seconds = Number.isFinite(sec) ? sec : 1;
    }
    return actionObj;
}
/**
 * Parse complete vision grounding prediction text with Thought and Action blocks.
 */
export function parseVisionGroundingPrediction(predictionText, screenContext = { width: 1920, height: 1080, scaleFactor: 1 }) {
    let thought;
    let reflection;
    const text = (predictionText || '').trim();
    if (text.includes('Thought:')) {
        const tMatch = text.match(/Thought:\s*([\s\S]+?)(?=\s*Action[:：]|$)/i);
        if (tMatch && tMatch[1]) {
            thought = tMatch[1].trim();
        }
    }
    if (text.includes('Reflection:')) {
        const rMatch = text.match(/Reflection:\s*([\s\S]+?)(?=\s*(?:Action_Summary|Action)[:：]|$)/i);
        if (rMatch && rMatch[1]) {
            reflection = rMatch[1].trim();
        }
    }
    const actionLines = [];
    if (/Action[:：]/i.test(text)) {
        const parts = text.split(/Action[:：]/i);
        for (let i = 1; i < parts.length; i++) {
            const seg = parts[i] || '';
            const lines = seg.split(/\n+/).map((l) => l.trim()).filter(Boolean);
            actionLines.push(...lines);
        }
    }
    else {
        actionLines.push(...text.split(/\n+/).map((l) => l.trim()).filter(Boolean));
    }
    const actions = [];
    for (const line of actionLines) {
        const parsed = parseSingleAction(line, screenContext);
        if (parsed) {
            if (thought && !parsed.thought)
                parsed.thought = thought;
            if (reflection && !parsed.reflection)
                parsed.reflection = reflection;
            actions.push(parsed);
        }
    }
    return { thought, reflection, actions };
}
const MAC_KEY_CODES = {
    return: 36,
    enter: 36,
    tab: 48,
    space: 49,
    backspace: 51,
    escape: 53,
    esc: 53,
    up: 126,
    down: 125,
    left: 123,
    right: 124
};
/**
 * Convert parsed vision grounding actions into Causyne desktop_act equivalent instructions.
 */
export function visionGroundingToDesktopAct(actions) {
    const result = [];
    for (const act of actions) {
        switch (act.action) {
            case 'click':
            case 'left_click':
            case 'double_click':
            case 'triple_click': {
                const point = act.coordinates;
                if (point) {
                    result.push({
                        verb: 'clickxy',
                        x: point.x,
                        y: point.y
                    });
                    if (act.action === 'double_click') {
                        result.push({ verb: 'clickxy', x: point.x, y: point.y });
                    }
                }
                break;
            }
            case 'type': {
                if (act.coordinates) {
                    result.push({ verb: 'clickxy', x: act.coordinates.x, y: act.coordinates.y });
                }
                if (act.text) {
                    result.push({ verb: 'type', text: act.text });
                }
                break;
            }
            case 'press_key':
            case 'hotkey': {
                const keyName = (act.key || '').toLowerCase().trim();
                const code = MAC_KEY_CODES[keyName];
                if (code !== undefined) {
                    result.push({ verb: 'key', keyCode: code });
                }
                else if (keyName) {
                    result.push({ verb: 'type', text: keyName });
                }
                break;
            }
            case 'wait': {
                result.push({ verb: 'wait', seconds: act.seconds || 1 });
                break;
            }
            case 'drag': {
                if (act.startCoordinates) {
                    result.push({ verb: 'clickxy', x: act.startCoordinates.x, y: act.startCoordinates.y });
                }
                if (act.endCoordinates) {
                    result.push({ verb: 'clickxy', x: act.endCoordinates.x, y: act.endCoordinates.y });
                }
                break;
            }
            case 'finished':
            default:
                break;
        }
    }
    return result;
}
