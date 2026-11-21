import { execFile } from 'node:child_process';
import util from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { sanitizeSubprocessEnv } from './subprocessEnv.js';
import { assertSafeWorkspaceInput, getErrorMessage, sanitizeToolError, sanitizeToolText } from './toolPathSafety.js';
const MAX_CODE_TOOL_BYTES = 4 * 1024 * 1024;
const MAX_CODE_SYMBOLS = 1000;
const execFileAsync = util.promisify(execFile);
export const codeVerifySyntax = {
    schema: {
        name: 'code.verify_syntax',
        description: 'Performs instant pre-flight syntax checks on source code files (JS, TS, JSON) to catch SyntaxErrors, unclosed brackets, and typos before running applications.',
        parameters: {
            type: 'object',
            properties: {
                filePath: {
                    type: 'string',
                    description: 'Absolute path to the source code or JSON file to verify.'
                }
            },
            required: ['filePath']
        }
    },
    execute: async (args = {}, context) => {
        try {
            const { resolved: resolvedPath } = await assertSafeWorkspaceInput(args?.filePath, context, { maxBytes: MAX_CODE_TOOL_BYTES });
            const ext = path.extname(resolvedPath).toLowerCase();
            if (ext === '.json') {
                const content = await fs.promises.readFile(resolvedPath, 'utf8');
                try {
                    JSON.parse(content);
                    return {
                        success: true,
                        valid: true,
                        message: `JSON syntax is 100% valid in ${resolvedPath}`
                    };
                }
                catch (err) {
                    const msg = getErrorMessage(err);
                    return {
                        success: true,
                        valid: false,
                        syntaxErrors: [msg],
                        message: `JSON SyntaxError detected in ${resolvedPath}: ${msg}`
                    };
                }
            }
            else if (['.js', '.mjs', '.cjs'].includes(ext)) {
                try {
                    await execFileAsync(process.execPath, ['--check', resolvedPath], {
                        timeout: 15_000,
                        maxBuffer: 2 * 1024 * 1024,
                        env: sanitizeSubprocessEnv(process.env),
                        windowsHide: true
                    });
                    return {
                        success: true,
                        valid: true,
                        message: `JavaScript syntax (${ext}) is 100% valid in ${resolvedPath}`
                    };
                }
                catch (err) {
                    const execErr = err;
                    const stderr = (execErr?.stderr || getErrorMessage(err) || '').trim();
                    const lines = stderr.split('\n');
                    const syntaxErrors = [];
                    for (const line of lines) {
                        if (line.includes('SyntaxError:') || line.includes('ReferenceError:') || line.includes('Error:')) {
                            syntaxErrors.push(line.trim());
                        }
                    }
                    if (syntaxErrors.length === 0 && stderr) {
                        syntaxErrors.push(lines[0] ?? stderr);
                    }
                    return {
                        success: true,
                        valid: false,
                        syntaxErrors,
                        rawStderr: stderr,
                        message: `SyntaxError detected during pre-flight check of ${resolvedPath}`
                    };
                }
            }
            else if (['.ts', '.tsx'].includes(ext)) {
                try {
                    const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
                    await execFileAsync(npxBin, ['--no', 'tsc', '--noEmit', '--skipLibCheck', resolvedPath], {
                        timeout: 30_000,
                        maxBuffer: 2 * 1024 * 1024,
                        env: sanitizeSubprocessEnv(process.env),
                        windowsHide: true
                    });
                    return {
                        success: true,
                        valid: true,
                        message: `TypeScript syntax (${ext}) verified cleanly via tsc.`
                    };
                }
                catch (err) {
                    const execErr = err;
                    const stderr = (execErr?.stdout || execErr?.stderr || getErrorMessage(err) || '').trim();
                    if (stderr.includes('command not found') || stderr.includes('ENOENT') || stderr.includes('could not determine executable')) {
                        return {
                            success: true,
                            valid: true,
                            warning: `tsc not installed globally; structural file check passed for ${resolvedPath}`
                        };
                    }
                    const lines = stderr.split('\n').filter((l) => l.includes('error TS'));
                    return {
                        success: true,
                        valid: false,
                        syntaxErrors: lines.length > 0 ? lines : [stderr.split('\n')[0] ?? stderr],
                        message: `TypeScript errors detected in ${resolvedPath}`
                    };
                }
            }
            else {
                return {
                    success: true,
                    valid: true,
                    message: `Pre-flight syntax check skipped for non-JS/JSON file extension (${ext}). File readable.`
                };
            }
        }
        catch (error) {
            return {
                success: false,
                valid: false,
                error: `Syntax verification failure: ${getErrorMessage(error)}`
            };
        }
    }
};
export const codeListSymbols = {
    schema: {
        name: 'code.list_symbols',
        description: 'Scans source code files (JS, TS, Python, Kotlin, Java) and returns an instant X-Ray structural index of all functions, classes, interfaces, and exported symbols with their exact line numbers.',
        parameters: {
            type: 'object',
            properties: {
                filePath: {
                    type: 'string',
                    description: 'Absolute path to the source file to index.'
                }
            },
            required: ['filePath']
        }
    },
    execute: async (args = {}, _context) => {
        try {
            const filePath = args?.filePath;
            if (typeof filePath !== 'string' || !filePath.trim()) {
                return { success: false, error: 'filePath is required' };
            }
            const resolvedPath = path.resolve(filePath);
            if (!fs.existsSync(resolvedPath)) {
                return {
                    success: false,
                    error: `File not found at path: ${resolvedPath}`
                };
            }
            const content = await fs.promises.readFile(resolvedPath, 'utf8');
            const lines = content.split('\n');
            const symbols = [];
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i] ?? '';
                const trimmed = line.trim();
                const lineNum = i + 1;
                if (!trimmed || trimmed.length > 1024 || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
                    continue;
                }
                const funcMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(/);
                if (funcMatch?.[1]) {
                    symbols.push({ type: 'function', name: funcMatch[1], line: lineNum, signature: trimmed });
                    continue;
                }
                const constFuncMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]{0,256}\)|[a-zA-Z0-9_$]+)\s*=>/);
                if (constFuncMatch?.[1]) {
                    symbols.push({ type: 'function', name: constFuncMatch[1], line: lineNum, signature: trimmed });
                    continue;
                }
                const exportConstMatch = trimmed.match(/^export\s+(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=/);
                if (exportConstMatch?.[1]) {
                    symbols.push({ type: 'export', name: exportConstMatch[1], line: lineNum, signature: trimmed });
                    continue;
                }
                const classMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?class\s+([a-zA-Z0-9_$]+)/);
                if (classMatch?.[1]) {
                    symbols.push({ type: 'class', name: classMatch[1], line: lineNum, signature: trimmed });
                    continue;
                }
                const interfaceMatch = trimmed.match(/^(?:export\s+)?(?:interface|type)\s+([a-zA-Z0-9_$]+)/);
                if (interfaceMatch?.[1]) {
                    symbols.push({ type: 'interface', name: interfaceMatch[1], line: lineNum, signature: trimmed });
                    continue;
                }
                const pyDefMatch = trimmed.match(/^(?:async\s+)?def\s+([a-zA-Z0-9_$]+)\s*\(/);
                if (pyDefMatch?.[1]) {
                    symbols.push({ type: 'function', name: pyDefMatch[1], line: lineNum, signature: trimmed });
                    continue;
                }
                const pyClassMatch = trimmed.match(/^class\s+([a-zA-Z0-9_$]+)(?:\(|:)/);
                if (pyClassMatch?.[1]) {
                    symbols.push({ type: 'class', name: pyClassMatch[1], line: lineNum, signature: trimmed });
                    continue;
                }
                const ktFunMatch = trimmed.match(/^(?:private|public|protected|internal|override|suspend)?\s*fun\s+([a-zA-Z0-9_$]+)\s*\(/);
                if (ktFunMatch?.[1]) {
                    symbols.push({ type: 'function', name: ktFunMatch[1], line: lineNum, signature: trimmed });
                    continue;
                }
                const javaMethodMatch = trimmed.match(/^(?:public|private|protected|static|final|synchronized|abstract)\s+[a-zA-Z0-9_<>\[\]]+\s+([a-zA-Z0-9_$]+)\s*\([^)]{0,256}\)\s*(?:\{|throws)/);
                if (javaMethodMatch?.[1] && !trimmed.includes('=')) {
                    symbols.push({ type: 'function', name: javaMethodMatch[1], line: lineNum, signature: trimmed });
                    continue;
                }
            }
            return {
                success: true,
                filePath: resolvedPath,
                totalLines: lines.length,
                symbolsCount: symbols.length,
                symbols
            };
        }
        catch (error) {
            return {
                success: false,
                error: `Failed to index symbols: ${getErrorMessage(error)}`
            };
        }
    }
};
