import os from 'node:os';
import fs from 'node:fs';
import { getErrorMessage } from './toolPathSafety.js';
const MCP_URL = 'http://127.0.0.1:19789/mcp';
export const palmierAutomator = {
    schema: {
        name: 'palmier_act',
        description: 'Automate an existing Palmier Pro installation through its local MCP server. Causyne does not download or install the application.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['checkConnection', 'importAndAssemble']
                },
                mediaPath: {
                    type: 'string',
                    description: 'Absolute path to media directory to import (for importAndAssemble)'
                },
                fps: {
                    type: 'string',
                    description: 'Timeline framerate (e.g. 23.976) or "auto"'
                },
                resolution_x: {
                    type: 'string',
                    description: 'Timeline width or "auto"'
                },
                resolution_y: {
                    type: 'string',
                    description: 'Timeline height or "auto"'
                }
            },
            required: ['action']
        }
    },
    async execute(args = {}, _context) {
        if (os.platform() !== 'darwin') {
            return { success: false, error: 'Palmier Pro is a macOS native application. Not supported on this OS.' };
        }
        const sendMcpRequest = async (method, params) => {
            try {
                const response = await fetch(MCP_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    redirect: 'error',
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: Date.now(),
                        method,
                        params
                    })
                });
                if (!response.ok) {
                    throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
                }
                const data = await response.json();
                if (data?.error)
                    throw new Error(data.error.message || JSON.stringify(data.error));
                return data?.result && typeof data.result === 'object' ? data.result : {};
            }
            catch (err) {
                throw new Error(`MCP Connection Error (Is Palmier Pro running?): ${getErrorMessage(err)}`);
            }
        };
        try {
            const action = args?.action;
            if (action === 'checkConnection') {
                const res = await sendMcpRequest('tools/list', {});
                return {
                    success: true,
                    message: 'Successfully connected to Palmier Pro MCP Server.',
                    tools: res.tools
                };
            }
            if (action === 'importAndAssemble') {
                if (!args?.mediaPath || !fs.existsSync(args.mediaPath)) {
                    return { success: false, error: `Media path not found: ${String(args?.mediaPath ?? '')}` };
                }
                const res = await sendMcpRequest('tools/call', {
                    name: 'import_and_assemble',
                    arguments: {
                        mediaPath: args.mediaPath,
                        fps: args.fps || 'auto',
                        resolution_x: args.resolution_x || 'auto',
                        resolution_y: args.resolution_y || 'auto'
                    }
                });
                return { success: true, message: 'Successfully imported and assembled media in Palmier Pro via MCP.', result: res };
            }
            return { success: false, error: `Unknown action: ${String(action ?? '')}` };
        }
        catch (err) {
            return { success: false, error: getErrorMessage(err) };
        }
    }
};
