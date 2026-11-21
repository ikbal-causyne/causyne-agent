import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const MAX_INPUT_BYTES = 1024 * 1024;
const RESULT_PREFIX = 'CAUSYNE_PLUGIN_RESULT:';
const EXPORT_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const FORBIDDEN_EXPORTS = new Set(['__proto__', 'constructor', 'prototype']);
function writeResult(payload) {
    let serialized;
    try {
        serialized = JSON.stringify(payload) ?? '{"success":false,"error":"Plugin returned undefined"}';
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        serialized = JSON.stringify({ success: false, error: `Plugin result could not be serialized: ${msg}` });
    }
    process.stdout.write(`${RESULT_PREFIX}${serialized}\n`);
}
async function readInput() {
    let input = '';
    for await (const chunk of process.stdin) {
        input += String(chunk);
        if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
            throw new Error('Plugin input exceeds 1 MB');
        }
    }
    return JSON.parse(input || '{}');
}
async function main() {
    const entry = process.argv[2];
    const exportName = process.argv[3] || 'execute';
    if (!entry || entry.includes('\0') || !path.isAbsolute(entry)) {
        throw new Error('Plugin entry must be an absolute path');
    }
    if (!EXPORT_IDENT.test(exportName) || FORBIDDEN_EXPORTS.has(exportName)) {
        throw new Error(`Invalid plugin export name ${JSON.stringify(exportName)}`);
    }
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('Plugin entry must be a regular non-symlink file');
    }
    const payload = await readInput();
    const imported = (await import(pathToFileURL(entry).href));
    const execute = Object.hasOwn(imported, exportName) ? imported[exportName] : undefined;
    if (typeof execute !== 'function') {
        throw new Error(`Plugin export ${JSON.stringify(exportName)} is not a function`);
    }
    const result = await execute(payload.args || {}, payload.context || {});
    writeResult(result && typeof result === 'object'
        ? result
        : { success: true, output: result });
}
console.log = (...values) => process.stderr.write(`${values.map(String).join(' ')}\n`);
console.info = console.log;
console.warn = console.log;
console.error = console.log;
main().catch((error) => {
    const errObj = error && typeof error === 'object' ? error : null;
    const details = [error instanceof Error ? error.message : String(error)];
    if (errObj?.permission)
        details.push(`permission=${String(errObj.permission)}`);
    if (errObj?.resource)
        details.push(`resource=${String(errObj.resource)}`);
    writeResult({ success: false, error: details.join(' ') });
    process.exitCode = 1;
});
