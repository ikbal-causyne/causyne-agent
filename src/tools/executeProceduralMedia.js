import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import util from 'node:util';
import { sanitizeSubprocessEnv } from './subprocessEnv.js';
import { getErrorMessage, assertSafeWorkspaceOutput, resolveScopedPath, sanitizeToolError, sanitizeToolText } from './toolPathSafety.js';
const MAX_PROCEDURAL_CODE_CHARS = 2 * 1024 * 1024;
const execFilePromise = util.promisify(execFile);
export const executeProceduralMedia = {
    schema: {
        name: 'execute_procedural_media',
        description: 'Sandboxed Procedural Generation (Mode A). Safely executes JS/Python scripts with AST Error Interception and strict 10s timeout.',
        parameters: {
            type: 'object',
            properties: {
                code: { type: 'string', description: 'The JavaScript/Python code. MUST save output to outputFileName.' },
                language: { type: 'string', enum: ['javascript', 'python'] },
                outputFileName: { type: 'string', description: 'Absolute path for output.' }
            },
            required: ['code', 'language', 'outputFileName']
        }
    },
    execute: async (args = {}, sandbox) => {
        try {
            const code = args?.code;
            const language = args?.language;
            if (typeof code !== 'string' || typeof language !== 'string' || typeof args?.outputFileName !== 'string') {
                return { success: false, error: 'code, language, and outputFileName are required.' };
            }
            if (code.length > MAX_PROCEDURAL_CODE_CHARS) {
                return { success: false, error: `Procedural script exceeds maximum size of ${MAX_PROCEDURAL_CODE_CHARS} characters.` };
            }
            const outputFilePath = await assertSafeWorkspaceOutput(args.outputFileName, sandbox);
            const workspaceDir = path.dirname(outputFilePath);
            if (!fs.existsSync(workspaceDir))
                fs.mkdirSync(workspaceDir, { recursive: true });
            const lang = language.toLowerCase();
            if (lang === 'javascript') {
                const scriptPath = path.join(workspaceDir, `temp_proc_${process.pid}_${crypto.randomBytes(6).toString('hex')}.cjs`);
                fs.writeFileSync(scriptPath, code, { flag: 'wx', mode: 0o600 });
                try {
                    const execOpts = {
                        cwd: workspaceDir,
                        timeout: 10000,
                        maxBuffer: 4 * 1024 * 1024,
                        windowsHide: true,
                        env: sanitizeSubprocessEnv(process.env),
                        ...(sandbox?.signal ? { signal: sandbox.signal } : {})
                    };
                    await execFilePromise(process.execPath, [scriptPath], execOpts);
                }
                catch (jsErr) {
                    const e = jsErr;
                    const detail = e?.stderr ? sanitizeToolText(e.stderr, 1200) : sanitizeToolError(jsErr, 1200);
                    return {
                        success: false,
                        error: `[AUTO-CORRECTION REQUIRED] JavaScript Execution Error: ${detail}\nPlease fix the math/syntax in the script and retry.`
                    };
                }
                finally {
                    try {
                        fs.unlinkSync(scriptPath);
                    }
                    catch { /* ignore */ }
                }
            }
            else if (lang === 'python') {
                const scriptPath = path.join(workspaceDir, `temp_proc_${process.pid}_${crypto.randomBytes(6).toString('hex')}.py`);
                fs.writeFileSync(scriptPath, code, { flag: 'wx', mode: 0o600 });
                try {
                    const pythonBin = process.platform === 'win32' ? 'python.exe' : 'python3';
                    const execOpts = {
                        cwd: workspaceDir,
                        timeout: 10000,
                        maxBuffer: 4 * 1024 * 1024,
                        windowsHide: true,
                        env: sanitizeSubprocessEnv(process.env),
                        ...(sandbox?.signal ? { signal: sandbox.signal } : {})
                    };
                    await execFilePromise(pythonBin, [scriptPath], execOpts);
                }
                catch (pyError) {
                    const e = pyError;
                    const detail = e?.stderr ? sanitizeToolText(e.stderr, 1200) : sanitizeToolError(pyError, 1200);
                    return {
                        success: false,
                        error: `[AUTO-CORRECTION REQUIRED] Python Execution Error: ${detail}\nPlease fix the math/syntax and retry.`
                    };
                }
                finally {
                    try {
                        fs.unlinkSync(scriptPath);
                    }
                    catch { /* ignore */ }
                }
            }
            else {
                return { success: false, error: 'Unsupported language. Use javascript or python.' };
            }
            if (fs.existsSync(outputFilePath)) {
                const stat = fs.lstatSync(outputFilePath);
                if (stat.isSymbolicLink() || !stat.isFile()) {
                    return { success: false, error: '[AUTO-CORRECTION REQUIRED] Output path must be a regular file, not a symlink or directory.' };
                }
                resolveScopedPath(outputFilePath, sandbox);
                if (stat.size === 0) {
                    return { success: false, error: `[AUTO-CORRECTION REQUIRED] Script executed but output file (${args.outputFileName}) is 0 bytes. Code failed to generate valid media.` };
                }
                return {
                    success: true,
                    message: `Procedural media generated successfully at ${outputFilePath} (${stat.size} bytes)`,
                    filePath: outputFilePath
                };
            }
            else {
                return { success: false, error: `[AUTO-CORRECTION REQUIRED] Script executed, but expected output file (${args.outputFileName}) was not created.` };
            }
        }
        catch (err) {
            return { success: false, error: sanitizeToolError(err) };
        }
    }
};
