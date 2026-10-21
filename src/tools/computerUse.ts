/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Computer Use & UI-TARS Tool Wrapper for Causyne Agent.
 */

import { parseUiTarsPrediction, uiTarsToDesktopAct, groundBoxCenter, type ScreenContext } from '../computerUse/uiTars.js';
import { desktopAct } from './desktopAct.js';
import { auditLog } from '../auditLog.js';

export interface ComputerUseArgs {
  action?: 'execute_prediction' | 'click' | 'type' | 'key' | 'drag' | 'wait';
  prediction?: string;
  coordinates?: number[];
  text?: string;
  key?: string;
  seconds?: number;
  app?: string;
  screenContext?: ScreenContext;
}

export const computerUse = {
  schema: {
    name: 'computer_use',
    description: 'Ground and execute graphical computer-use actions (click coordinates, type text, send key presses, drag, wait) derived from vision-language models and UI-TARS predictions. Automatically translates normalized bounding boxes and coordinates against current screen dimensions with safety boundary checks. Requires explicit approval.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['execute_prediction', 'click', 'type', 'key', 'drag', 'wait'],
          description: 'Type of computer-use action to perform.'
        },
        prediction: {
          type: 'string',
          description: 'Raw prediction text from a UI-TARS or vision-language model, e.g. "Thought: Click search bar. Action: click(start_box=\'(500, 200)\')".'
        },
        coordinates: {
          type: 'array',
          items: { type: 'number' },
          description: 'Coordinates as [x, y] or bounding box [x1, y1, x2, y2] normalized (0-1000) or in screen pixels.'
        },
        text: {
          type: 'string',
          description: 'Text to type into the active or targeted element.'
        },
        key: {
          type: 'string',
          description: 'Key or hotkey to press, e.g. "return", "tab", "escape".'
        },
        seconds: {
          type: 'number',
          description: 'Seconds to wait (0.1 to 10).'
        },
        app: {
          type: 'string',
          description: 'Application to focus before executing actions, e.g. "Safari".'
        },
        screenContext: {
          type: 'object',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
            scaleFactor: { type: 'number' }
          },
          description: 'Current display dimensions and scale factor for coordinate grounding.'
        }
      }
    }
  },

  async execute(args: ComputerUseArgs = {}, context: any = {}): Promise<{ success: boolean; output?: string; error?: string; actions?: any[] }> {
    const screen: ScreenContext = args.screenContext || { width: 1920, height: 1080, scaleFactor: 1 };
    const app = typeof args.app === 'string' ? args.app.trim() : '';

    let desktopActions: any[] = [];

    // Mode 1: Parse full model prediction from UI-TARS
    if (args.prediction || args.action === 'execute_prediction') {
      const pred = args.prediction || '';
      if (!pred.trim()) {
        return { success: false, error: 'No prediction string provided for execute_prediction.' };
      }
      const parsed = parseUiTarsPrediction(pred, screen);
      if (parsed.actions.length === 0) {
        return { success: false, error: 'Could not parse any executable GUI actions from prediction string.' };
      }
      desktopActions = uiTarsToDesktopAct(parsed.actions);
    } else {
      // Mode 2: Direct action request
      const actionType = args.action || 'click';
      if (actionType === 'click') {
        const coords = args.coordinates || [];
        const point = groundBoxCenter(coords, screen);
        if (!point) return { success: false, error: 'Click requires valid coordinates [x, y].' };
        desktopActions.push({ verb: 'clickxy', x: point.x, y: point.y });
      } else if (actionType === 'type') {
        if (args.coordinates && args.coordinates.length >= 2) {
          const point = groundBoxCenter(args.coordinates, screen);
          if (point) desktopActions.push({ verb: 'clickxy', x: point.x, y: point.y });
        }
        if (!args.text) return { success: false, error: 'Type action requires "text" parameter.' };
        desktopActions.push({ verb: 'type', text: args.text });
      } else if (actionType === 'key') {
        if (!args.key) return { success: false, error: 'Key action requires "key" parameter.' };
        const keyMap: Record<string, number> = {
          return: 36, enter: 36, tab: 48, space: 49, backspace: 51, escape: 53, esc: 53
        };
        const keyCode = keyMap[args.key.toLowerCase()];
        if (keyCode !== undefined) {
          desktopActions.push({ verb: 'key', keyCode });
        } else {
          desktopActions.push({ verb: 'type', text: args.key });
        }
      } else if (actionType === 'wait') {
        desktopActions.push({ verb: 'wait', seconds: Math.min(10, Math.max(0.1, args.seconds || 1)) });
      } else {
        return { success: false, error: `Unsupported computer_use action: ${actionType}` };
      }
    }

    if (desktopActions.length === 0) {
      return { success: false, error: 'No actions to execute.' };
    }

    if (desktopActions.length > 12) {
      return { success: false, error: `Maximum 12 actions allowed per call; got ${desktopActions.length}.` };
    }

    auditLog.log({
      event: 'computer_use_actuation',
      app,
      actionCount: desktopActions.length,
      verbs: desktopActions.map((a) => a.verb)
    });

    const execResult = await desktopAct.execute({ app, actions: desktopActions }, context);
    const finalRes: { success: boolean; output?: string; error?: string; actions?: any[] } = {
      success: Boolean(execResult.success),
      actions: desktopActions
    };
    if (execResult.output) finalRes.output = execResult.output;
    if (execResult.error) finalRes.error = execResult.error;
    return finalRes;
  }
};
