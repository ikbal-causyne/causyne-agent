/**
 * Causyne Agent — Programmatic Tool Calling Runtime (`run_code`)
 *
 * Executes bounded TypeScript/JavaScript orchestration scripts inside an isolated
 * Node child process (OS-sandboxed via `osSandbox.ts`, scrubbed `process.env = {}`,
 * V8 heap cap `--max-old-space-size=256`, wall-clock timeout, and dedicated
 * NDJSON-RPC control pipe).
 *
 * Inside the script:
 *   - `await tools.<tool_name>(args)` invokes safe, sandbox-validated Causyne tools
 *     (including `Promise.all(...)` concurrent reads and programmatic filtering).
 *   - `inspect(...values)` records only the final distilled results to return to the
 *     model context, preventing large intermediate payloads from polluting history.
 *
 * Security invariants:
 *   - Every host tool sub-call passes through workspace sandbox validation and refuses
 *     recursive `run_code` or unapproved destructive/shell operations.
 *   - Strictly additive per ACP capability policy; never strips peer-native tools.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolveOsSandboxMode, wrapCommandWithOsSandbox } from './osSandbox.js';
import { boundedInteger, getErrorMessage, resolveToolWorkspaceRoots, sanitizeToolError } from './toolPathSafety.js';
import { redactTextSecrets } from '../providers/byokHttp.js';
import { fsRead } from './fsRead.js';
import { fsList } from './fsList.js';
import { fsFind } from './fsFind.js';
import { fsSearch } from './fsSearch.js';
import { codeSearcher } from './codeSearcher.js';
import { codebaseSearch } from './codebaseSearch.js';
import { codeVerifySyntax, codeListSymbols } from './codeTools.js';
import { codeSearchAst } from './codeSearchAst.js';
import { repoMapTool } from './repoMap.js';
import { pdfRead } from './pdfReader.js';
import { webSearch } from './webSearch.js';
import { webFetch } from './webFetch.js';
const MAX_CODE_CHARS = 32_000;
const MAX_OUTPUT_CHARS = 24_000;
const MAX_SUB_CALLS_PER_RUN = 40;
const MAX_PENDING_CALLS = 8;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const PTC_ALLOWED_TOOLS = Object.freeze({
    fs_read: fsRead,
    fs_list: fsList,
    fs_find: fsFind,
    fs_search: fsSearch,
    code_search_ripgrep: codeSearcher,
    codebase_search: codebaseSearch,
    code_verify_syntax: codeVerifySyntax,
    code_list_symbols: codeListSymbols,
    code_search_ast: codeSearchAst,
    code_repo_map: repoMapTool,
    pdf_read: pdfRead,
    web_search: webSearch,
    web_fetch: webFetch
});
const PTC_WORKER_SCRIPT = `
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const mod = require('node:module');

const rpcIn = fs.createReadStream(null, { fd: 3, encoding: 'utf8' });
const rpcOut = fs.createWriteStream(null, { fd: 4 });

let nextId = 1;
const pending = new Map();
const inspected = [];
let inspectedChars = 0;
const MAX_INSPECT_CHARS = 24000;

function sendRpc(obj) {
  try {
    rpcOut.write(JSON.stringify(obj) + '\\n');
  } catch {}
}

let inBuf = '';
rpcIn.on('data', (chunk) => {
  inBuf += chunk;
  let nl = inBuf.indexOf('\\n');
  while (nl !== -1) {
    const line = inBuf.slice(0, nl).trim();
    inBuf = inBuf.slice(nl + 1);
    if (line) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'run') {
          void executeScript(msg.code, msg.toolNames || []);
        } else if (msg.type === 'tool_result') {
          const slot = pending.get(msg.id);
          if (slot) {
            pending.delete(msg.id);
            if (msg.ok) slot.resolve(msg.result);
            else slot.reject(new Error(msg.error || 'Tool call failed'));
          }
        }
      } catch {}
    }
    nl = inBuf.indexOf('\\n');
  }
});

function callHostTool(name, args) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    sendRpc({ type: 'tool_call', id, name, args: args && typeof args === 'object' ? args : {} });
  });
}

function formatInspectValue(val) {
  if (typeof val === 'string') return val;
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
}

function inspect(...values) {
  for (const val of values) {
    const text = formatInspectValue(val);
    if (inspectedChars + text.length > MAX_INSPECT_CHARS) {
      const remaining = Math.max(0, MAX_INSPECT_CHARS - inspectedChars);
      if (remaining > 0) inspected.push(text.slice(0, remaining) + '\\n...[truncated]');
      inspectedChars = MAX_INSPECT_CHARS;
      return;
    }
    inspected.push(text);
    inspectedChars += text.length;
  }
}

async function executeScript(rawCode, toolNames) {
  try {
    const wrappedSrc = 'async (tools, inspect, console) => {\\n' + String(rawCode || '') + '\\n}';
    const jsCode = typeof mod.stripTypeScriptTypes === 'function'
      ? mod.stripTypeScriptTypes(wrappedSrc, { mode: 'strip' })
      : wrappedSrc;

    const toolsObj = Object.create(null);
    for (const name of toolNames) {
      toolsObj[name] = (args) => callHostTool(name, args);
    }
    Object.freeze(toolsObj);

    const safeConsole = Object.freeze({
      log: (...a) => inspect(...a),
      info: (...a) => inspect(...a),
      warn: (...a) => inspect('[warn]', ...a),
      error: (...a) => inspect('[error]', ...a)
    });

    const script = new vm.Script('(' + jsCode + ')', { filename: 'causyne-ptc.ts' });
    const fn = script.runInNewContext({
      Promise,
      JSON,
      Math,
      Date,
      Array,
      Object,
      Map,
      Set,
      RegExp,
      Number,
      String,
      Boolean,
      Error,
      TypeError,
      RangeError,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      Intl,
      setTimeout,
      clearTimeout
    });

    const returned = await fn(toolsObj, inspect, safeConsole);
    if (returned !== undefined && inspected.length === 0) {
      inspect(returned);
    }
    sendRpc({ type: 'done', ok: true, output: inspected.join('\\n') });
    rpcOut.end(() => process.exit(0));
    setTimeout(() => process.exit(0), 50).unref?.();
  } catch (err) {
    sendRpc({
      type: 'done',
      ok: false,
      error: err && err.message ? String(err.message) : String(err),
      output: inspected.join('\\n')
    });
    rpcOut.end(() => process.exit(0));
    setTimeout(() => process.exit(0), 50).unref?.();
  }
}

sendRpc({ type: 'ready' });
`;
export async function executeProgrammaticScript(code, context = {}, options = {}) {
    if (typeof code !== 'string' || !code.trim()) {
        return { success: false, error: 'code must be a non-empty TypeScript/JavaScript snippet.' };
    }
    if (code.length > MAX_CODE_CHARS) {
        return { success: false, error: `code exceeds maximum size (${MAX_CODE_CHARS} characters).` };
    }
    if (code.includes('\0')) {
        return { success: false, error: 'code cannot contain NUL bytes.' };
    }
    const scope = resolveToolWorkspaceRoots(context);
    const workspaceRoot = scope.primaryRoot || process.cwd();
    const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    const toolNames = Object.keys(PTC_ALLOWED_TOOLS);
    const nodeArgs = ['--max-old-space-size=256', '-e', PTC_WORKER_SCRIPT];
    const sandboxRes = resolveOsSandboxMode(process.env, typeof context.osSandbox === 'string' ? context.osSandbox : undefined);
    const wrapped = wrapCommandWithOsSandbox(process.execPath, nodeArgs, {
        mode: sandboxRes.mode,
        strict: sandboxRes.strict,
        allowNetwork: false,
        cwd: workspaceRoot,
        workspaceRoots: scope.roots.length > 0 ? scope.roots : [workspaceRoot]
    });
    // Use Node extra fds 3 (host->worker) and 4 (worker->host) so RPC never collides with stdout/stderr
    const proc = spawn(wrapped.command, wrapped.args, {
        cwd: workspaceRoot,
        env: {},
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
        windowsHide: true
    });
    const hostToWorker = proc.stdio[3];
    const workerToHost = proc.stdio[4];
    if (!hostToWorker || !workerToHost) {
        try {
            proc.kill('SIGKILL');
        }
        catch { /* ignore */ }
        return { success: false, error: 'Failed to initialize programmatic runtime RPC pipes.' };
    }
    let subCallsExecuted = 0;
    let activeSubCalls = 0;
    let settled = false;
    let stderrTail = '';
    proc.stderr?.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096);
    });
    return new Promise((resolve) => {
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            context.signal?.removeEventListener('abort', onAbort);
            try {
                hostToWorker.end();
            }
            catch { /* ignore */ }
            if (proc.exitCode !== null || proc.killed) {
                resolve(result);
                return;
            }
            let resolved = false;
            const done = () => {
                if (resolved)
                    return;
                resolved = true;
                clearTimeout(killTimer);
                clearTimeout(waitTimer);
                resolve(result);
            };
            proc.once('close', done);
            proc.once('exit', done);
            try {
                proc.kill('SIGTERM');
            }
            catch { /* ignore */ }
            const killTimer = setTimeout(() => {
                try {
                    if (proc.exitCode === null)
                        proc.kill('SIGKILL');
                }
                catch { /* ignore */ }
            }, 250);
            killTimer.unref?.();
            const waitTimer = setTimeout(done, 800);
            waitTimer.unref?.();
        };
        const onAbort = () => {
            finish({ success: false, error: 'Programmatic script execution aborted.', subCallsExecuted });
        };
        if (context.signal?.aborted) {
            onAbort();
            return;
        }
        context.signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => {
            finish({
                success: false,
                error: `Programmatic script timed out after ${timeoutMs}ms.`,
                subCallsExecuted
            });
        }, timeoutMs);
        timer.unref?.();
        const sendToWorker = (obj) => {
            if (settled)
                return;
            try {
                hostToWorker.write(`${JSON.stringify(obj)}\n`);
            }
            catch {
                // Worker pipe closed
            }
        };
        let rpcBuf = '';
        workerToHost.on('data', (chunk) => {
            rpcBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            let nl = rpcBuf.indexOf('\n');
            while (nl !== -1) {
                const line = rpcBuf.slice(0, nl).trim();
                rpcBuf = rpcBuf.slice(nl + 1);
                if (line) {
                    try {
                        const msg = JSON.parse(line);
                        if (msg.type === 'ready') {
                            sendToWorker({ type: 'run', code, toolNames });
                        }
                        else if (msg.type === 'tool_call' && typeof msg.id === 'number' && typeof msg.name === 'string') {
                            const callId = msg.id;
                            const toolName = msg.name;
                            const callArgs = msg.args && typeof msg.args === 'object' ? msg.args : {};
                            if (subCallsExecuted >= MAX_SUB_CALLS_PER_RUN) {
                                sendToWorker({
                                    type: 'tool_result',
                                    id: callId,
                                    ok: false,
                                    error: `Sub-call budget exceeded (${MAX_SUB_CALLS_PER_RUN} calls per script).`
                                });
                            }
                            else if (activeSubCalls >= MAX_PENDING_CALLS) {
                                sendToWorker({
                                    type: 'tool_result',
                                    id: callId,
                                    ok: false,
                                    error: `Too many concurrent tool calls (limit ${MAX_PENDING_CALLS}).`
                                });
                            }
                            else if (!Object.hasOwn(PTC_ALLOWED_TOOLS, toolName)) {
                                sendToWorker({
                                    type: 'tool_result',
                                    id: callId,
                                    ok: false,
                                    error: `Tool "${toolName}" is not permitted inside run_code.`
                                });
                            }
                            else {
                                subCallsExecuted++;
                                activeSubCalls++;
                                const impl = PTC_ALLOWED_TOOLS[toolName];
                                void impl.execute(callArgs, context)
                                    .then((res) => {
                                    sendToWorker({ type: 'tool_result', id: callId, ok: true, result: res });
                                })
                                    .catch((err) => {
                                    sendToWorker({ type: 'tool_result', id: callId, ok: false, error: getErrorMessage(err) });
                                })
                                    .finally(() => {
                                    activeSubCalls = Math.max(0, activeSubCalls - 1);
                                });
                            }
                        }
                        else if (msg.type === 'done') {
                            const rawOut = redactTextSecrets(String(msg.output || '')).slice(0, MAX_OUTPUT_CHARS);
                            if (msg.ok) {
                                finish({
                                    success: true,
                                    output: rawOut || '(script completed with no inspected output)',
                                    subCallsExecuted,
                                    availableTools: toolNames
                                });
                            }
                            else {
                                finish({
                                    success: false,
                                    error: redactTextSecrets(msg.error || 'Programmatic script failed.'),
                                    ...(rawOut ? { output: rawOut } : {}),
                                    subCallsExecuted
                                });
                            }
                        }
                    }
                    catch {
                        // Ignore malformed line
                    }
                }
                nl = rpcBuf.indexOf('\n');
            }
        });
        proc.on('exit', (exitCode) => {
            if (!settled) {
                finish({
                    success: false,
                    error: `Programmatic runtime exited unexpectedly (code ${String(exitCode)})${stderrTail ? `: ${redactTextSecrets(stderrTail.trim()).slice(0, 300)}` : ''}`,
                    subCallsExecuted
                });
            }
        });
        proc.on('error', (err) => {
            finish({ success: false, error: sanitizeToolError(err), subCallsExecuted });
        });
    });
}
// Keep unused-import lint clean for optional CJS bridge reference
void createRequire;
export const runCodeTool = {
    schema: {
        name: 'run_code',
        description: 'Execute a sandboxed TypeScript/JavaScript orchestration script that calls read/search workspace tools programmatically via `await tools.<name>(args)` (including `Promise.all`) and emits only concise distilled output via `inspect(...)`. Eliminates multi-turn context bloat for batch audits and aggregations.',
        parameters: {
            type: 'object',
            properties: {
                code: {
                    type: 'string',
                    description: 'Async function body in TypeScript or JavaScript. Available globals: `tools` (`fs_read`, `fs_list`, `fs_find`, `fs_search`, `code_search_ripgrep`, `codebase_search`, `code_verify_syntax`, `code_list_symbols`, `code_search_ast`, `code_repo_map`, `pdf_read`, `web_search`, `web_fetch`), `inspect(...values)`, and `console.log`.'
                },
                timeoutMs: {
                    type: 'integer',
                    description: 'Optional execution timeout in ms (1000-60000, default 30000).'
                }
            },
            required: ['code'],
            additionalProperties: false
        }
    },
    async execute(args, context = {}) {
        try {
            return await executeProgrammaticScript(args?.code ?? '', context, { timeoutMs: args?.timeoutMs });
        }
        catch (error) {
            return { success: false, error: sanitizeToolError(error) };
        }
    }
};
