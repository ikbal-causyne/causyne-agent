/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted for Causyne Vision Desktop & Coordinate Grounding Engine.
 */

export interface ScreenContext {
  width: number;
  height: number;
  scaleFactor?: number;
  targetSpace?: 'logical' | 'physical';
}

export type ActionVerb =
  | 'click'
  | 'left_click'
  | 'right_click'
  | 'double_click'
  | 'triple_click'
  | 'middle_click'
  | 'mouse_down'
  | 'mouse_up'
  | 'drag'
  | 'move'
  | 'type'
  | 'press_key'
  | 'hotkey'
  | 'scroll'
  | 'wait'
  | 'finished';

export interface VisionAction {
  action: ActionVerb;
  thought?: string;
  reflection?: string;
  coordinates?: { x: number; y: number };
  startCoordinates?: { x: number; y: number };
  endCoordinates?: { x: number; y: number };
  text?: string;
  key?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  seconds?: number;
  rawStr?: string;
}

export interface DesktopActEquivalent {
  verb: 'press' | 'clickxy' | 'type' | 'key' | 'wait' | 'scroll' | 'drag';
  x?: number | undefined;
  y?: number | undefined;
  fromX?: number | undefined;
  fromY?: number | undefined;
  toX?: number | undefined;
  toY?: number | undefined;
  text?: string | undefined;
  keyCode?: number | undefined;
  chord?: string | undefined;
  modifiers?: ('cmd' | 'ctrl' | 'alt' | 'shift')[] | undefined;
  key?: string | undefined;
  target?: string | undefined;
  seconds?: number | undefined;
  direction?: ('up' | 'down' | 'left' | 'right') | undefined;
  steps?: number | undefined;
}

const DEFAULT_FACTOR: [number, number] = [1000, 1000];

/**
 * Extract numbers from a coordinate string like "(250, 400)" or "[100, 200, 300, 400]"
 */
export function extractCoordinateNumbers(raw: string): number[] {
  const clean = String(raw || '').replace(/[()[\]]/g, ' ').trim();
  if (!clean) return [];
  return clean
    .split(/[\s,]+/)
    .map((s) => Number.parseFloat(s))
    .filter((n) => Number.isFinite(n));
}

/**
 * Ground normalized coordinates (0-1000) to actual screen units.
 * Defaults to OS logical points on macOS/modern desktop actuators to prevent double-scaling.
 */
export function groundPoint(
  nums: number[],
  screen: ScreenContext = { width: 1920, height: 1080, scaleFactor: 1 },
  factor: [number, number] = DEFAULT_FACTOR
): { x: number; y: number } | null {
  if (nums.length < 2) return null;
  const rawX = nums[0] ?? 0;
  const rawY = nums[1] ?? 0;
  const targetSpace = screen.targetSpace ?? 'logical';
  const scale = targetSpace === 'physical' ? (screen.scaleFactor || 1) : 1;

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
export function groundBoxCenter(
  nums: number[],
  screen: ScreenContext = { width: 1920, height: 1080, scaleFactor: 1 },
  factor: [number, number] = DEFAULT_FACTOR
): { x: number; y: number } | null {
  if (nums.length < 2) return null;
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
export function parseSingleAction(
  rawAction: string,
  screenContext: ScreenContext = { width: 1920, height: 1080, scaleFactor: 1 }
): VisionAction | null {
  let line = (rawAction || '').trim();
  if (!line) return null;

  // Strip leading Action: or Action_Summary: prefixes
  line = line.replace(/^(?:Action(?:_Summary)?[:：]\s*)/i, '').trim();

  const callMatch = line.match(/^([a-zA-Z_0-9]+)\s*\((.*)\)$/);
  if (!callMatch) {
    if (/finished/i.test(line)) {
      return { action: 'finished', rawStr: line };
    }
    return null;
  }

  const funcName = callMatch[1]?.toLowerCase() as ActionVerb;
  const argsRaw = callMatch[2] || '';

  const argsMap: Record<string, string> = {};
  const kvRegex = /([a-zA-Z_0-9]+)\s*=\s*(?:['"]([^'"]+)['"]|([^,\s'")]+))/g;
  let match: RegExpExecArray | null;
  while ((match = kvRegex.exec(argsRaw)) !== null) {
    const key = match[1];
    const val = match[2] ?? match[3];
    if (key && val !== undefined) {
      argsMap[key] = val;
    }
  }

  if (Object.keys(argsMap).length === 0) {
    const boxMatch = argsRaw.match(/['"]?(\([0-9\s,.]+\)|\[[0-9\s,.]+\])['"]?/);
    if (boxMatch && boxMatch[1]) {
      argsMap['start_box'] = boxMatch[1];
    }
  }

  const actionObj: VisionAction = {
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
export function parseVisionGroundingPrediction(
  predictionText: string,
  screenContext: ScreenContext = { width: 1920, height: 1080, scaleFactor: 1 }
): { thought?: string | undefined; reflection?: string | undefined; actions: VisionAction[] } {
  let thought: string | undefined;
  let reflection: string | undefined;

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

  const actionLines: string[] = [];
  if (/Action[:：]/i.test(text)) {
    const parts = text.split(/Action[:：]/i);
    for (let i = 1; i < parts.length; i++) {
      const seg = parts[i] || '';
      const lines = seg.split(/\n+/).map((l) => l.trim()).filter(Boolean);
      actionLines.push(...lines);
    }
  } else {
    actionLines.push(...text.split(/\n+/).map((l) => l.trim()).filter(Boolean));
  }

  const actions: VisionAction[] = [];

  for (const line of actionLines) {
    const parsed = parseSingleAction(line, screenContext);
    if (parsed) {
      if (thought && !parsed.thought) parsed.thought = thought;
      if (reflection && !parsed.reflection) parsed.reflection = reflection;
      actions.push(parsed);
    }
  }

  return { thought, reflection, actions };
}

const MAC_KEY_CODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9,
  b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, 9: 25, 7: 26, 8: 28, 0: 29,
  o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40,
  n: 45, m: 46,
  return: 36, enter: 36, tab: 48, space: 49,
  backspace: 51, delete: 51, escape: 53, esc: 53,
  command: 55, cmd: 55, shift: 56,
  option: 58, alt: 58, control: 59, ctrl: 59,
  up: 126, down: 125, left: 123, right: 124
};

function parseCompoundKeyChord(raw: string): {
  chord: string;
  modifiers: ('cmd' | 'ctrl' | 'alt' | 'shift')[];
  baseKey?: string | undefined;
  keyCode?: number | undefined;
} {
  const parts = raw.toLowerCase().split(/[+\-_ ]+/).map((p) => p.trim()).filter(Boolean);
  const modifiers: ('cmd' | 'ctrl' | 'alt' | 'shift')[] = [];
  let baseKey: string | undefined;

  for (const p of parts) {
    if (p === 'cmd' || p === 'command' || p === 'meta' || p === 'super') {
      modifiers.push('cmd');
    } else if (p === 'ctrl' || p === 'control') {
      modifiers.push('ctrl');
    } else if (p === 'alt' || p === 'option') {
      modifiers.push('alt');
    } else if (p === 'shift') {
      modifiers.push('shift');
    } else {
      baseKey = p;
    }
  }

  const keyCode = baseKey ? MAC_KEY_CODES[baseKey] : undefined;
  return { chord: raw, modifiers, baseKey, keyCode };
}

/**
 * Convert parsed vision grounding actions into Causyne desktop_act equivalent instructions.
 */
export function visionGroundingToDesktopAct(actions: VisionAction[]): DesktopActEquivalent[] {
  const result: DesktopActEquivalent[] = [];

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
        const rawKey = (act.key || '').trim();
        if (!rawKey) break;

        if (rawKey.includes('+') || rawKey.includes('-')) {
          const chordInfo = parseCompoundKeyChord(rawKey);
          result.push({
            verb: 'key',
            chord: chordInfo.chord,
            modifiers: chordInfo.modifiers,
            key: chordInfo.baseKey,
            keyCode: chordInfo.keyCode
          });
        } else {
          const keyName = rawKey.toLowerCase();
          const code = MAC_KEY_CODES[keyName];
          if (code !== undefined) {
            result.push({ verb: 'key', keyCode: code, key: keyName });
          } else {
            result.push({ verb: 'type', text: rawKey });
          }
        }
        break;
      }
      case 'scroll': {
        result.push({
          verb: 'scroll',
          direction: act.direction || 'down',
          seconds: act.seconds || 1,
          ...(act.coordinates ? { x: act.coordinates.x, y: act.coordinates.y } : {})
        });
        break;
      }
      case 'wait': {
        result.push({ verb: 'wait', seconds: act.seconds || 1 });
        break;
      }
      case 'drag': {
        const fromX = act.startCoordinates?.x ?? act.coordinates?.x ?? 0;
        const fromY = act.startCoordinates?.y ?? act.coordinates?.y ?? 0;
        const toX = act.endCoordinates?.x ?? fromX;
        const toY = act.endCoordinates?.y ?? fromY;
        result.push({
          verb: 'drag',
          fromX,
          fromY,
          toX,
          toY,
          x: toX,
          y: toY
        });
        break;
      }
      case 'finished':
      default:
        break;
    }
  }

  return result;
}
