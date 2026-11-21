import os from 'node:os';
import fs from 'node:fs';
import { getErrorMessage, resolveScopedPath, sanitizeToolError } from './toolPathSafety.js';
const MCP_URL = 'http://127.0.0.1:19789/mcp';
const PALMIER_TIMEOUT_MS = 15_000;
const MAX_PALMIER_RESPONSE_BYTES = 2 * 1024 * 1024;
function validateNumericOrAuto(value, label, min, max) {
    if (value === undefined || value === null || value === '')
        return 'auto';
    const str = String(value).trim();
    if (!str || str.toLowerCase() === 'auto')
        return 'auto';
    const num = Number(str);
    if (!Number.isFinite(num) || num < min || num > max) {
        throw new Error(`Invalid ${label}: must be "auto" or a number between ${min} and ${max}.`);
    }
    return str;
}
async function readBoundedText(response, maxBytes) {
    if (!response.body)
        return '';
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (value) {
                total += value.byteLength;
                if (total > maxBytes) {
                    await reader.cancel().catch(() => { });
                    throw new Error(`Palmier MCP response exceeded ${maxBytes} bytes.`);
                }
                chunks.push(value);
            }
        }
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks).toString('utf8');
}
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
    async execute(args = {}, context) {
        if (os.platform() !== 'darwin') {
            return { success: false, error: 'Palmier Pro is a macOS native application. Not supported on this OS.' };
        }
        const sendMcpRequest = async (method, params) => {
            try {
                const timeoutSignal = AbortSignal.timeout(PALMIER_TIMEOUT_MS);
                const signal = context?.signal
                    ? AbortSignal.any([context.signal, timeoutSignal])
                    : timeoutSignal;
                const response = await fetch(MCP_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    redirect: 'error',
                    signal,
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
                const rawBody = await readBoundedText(response, MAX_PALMIER_RESPONSE_BYTES);
                const data = JSON.parse(rawBody || '{}');
                if (data?.error)
                    throw new Error(data.error.message || JSON.stringify(data.error));
                return data?.result && typeof data.result === 'object' ? data.result : {};
            }
            catch (err) {
                throw new Error(`MCP Connection Error (Is Palmier Pro running?): ${sanitizeToolError(err)}`);
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
                if (typeof args?.mediaPath !== 'string' || !args.mediaPath.trim()) {
                    return { success: false, error: 'mediaPath is required for importAndAssemble.' };
                }
                const resolvedMediaPath = resolveScopedPath(args.mediaPath, context);
                let mediaStat;
                try {
                    mediaStat = fs.lstatSync(resolvedMediaPath);
                }
                catch {
                    return { success: false, error: `Media path not found: ${resolvedMediaPath}` };
                }
                if (mediaStat.isSymbolicLink() || (!mediaStat.isDirectory() && !mediaStat.isFile())) {
                    return { success: false, error: 'Media path must be a regular file or directory within the authorized workspace.' };
                }
                const fps = validateNumericOrAuto(args.fps, 'fps', 1, 1000);
                const resolutionX = validateNumericOrAuto(args.resolution_x, 'resolution_x', 16, 16384);
                const resolutionY = validateNumericOrAuto(args.resolution_y, 'resolution_y', 16, 16384);
                const res = await sendMcpRequest('tools/call', {
                    name: 'import_and_assemble',
                    arguments: {
                        mediaPath: resolvedMediaPath,
                        fps,
                        resolution_x: resolutionX,
                        resolution_y: resolutionY
                    }
                });
                return { success: true, message: 'Successfully imported and assembled media in Palmier Pro via MCP.', result: res };
            }
            return { success: false, error: `Unknown action: ${String(action ?? '')}` };
        }
        catch (err) {
            return { success: false, error: sanitizeToolError(err) };
        }
    }
};
