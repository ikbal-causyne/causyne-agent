import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_INPUT_BYTES = 1024 * 1024;
const RAW_TOKEN = typeof process.env.CAUSYNE_PLUGIN_TOKEN === 'string' && /^[0-9a-f]{16,64}$/i.test(process.env.CAUSYNE_PLUGIN_TOKEN)
  ? process.env.CAUSYNE_PLUGIN_TOKEN
  : '';
const RESULT_PREFIX = RAW_TOKEN ? `CAUSYNE_PLUGIN_RESULT:${RAW_TOKEN}:` : 'CAUSYNE_PLUGIN_RESULT:';
const EXPORT_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const FORBIDDEN_EXPORTS = new Set(['__proto__', 'constructor', 'prototype']);

function writeResult(payload: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload) ?? '{"success":false,"error":"Plugin returned undefined"}';
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    serialized = JSON.stringify({ success: false, error: `Plugin result could not be serialized: ${msg}` });
  }
  process.stdout.write(`${RESULT_PREFIX}${serialized}\n`);
}

async function readInput(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    totalBytes += buf.length;
    if (totalBytes > MAX_INPUT_BYTES) {
      throw new Error('Plugin input exceeds 1 MB');
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks, totalBytes).toString('utf8').trim();
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

async function main(): Promise<void> {
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
  const imported = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
  const execute = Object.hasOwn(imported, exportName) ? imported[exportName] : undefined;
  if (typeof execute !== 'function') {
    throw new Error(`Plugin export ${JSON.stringify(exportName)} is not a function`);
  }

  const result = await execute(payload.args || {}, payload.context || {});
  writeResult(result && typeof result === 'object'
    ? result
    : { success: true, output: result });
}

console.log = (...values: unknown[]) => process.stderr.write(`${values.map(String).join(' ')}\n`);
console.info = console.log;
console.warn = console.log;
console.error = console.log;

main().catch((error: unknown) => {
  const errObj = error && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  const details = [error instanceof Error ? error.message : String(error)];
  if (errObj?.permission) details.push(`permission=${String(errObj.permission)}`);
  if (errObj?.resource) details.push(`resource=${String(errObj.resource)}`);
  writeResult({ success: false, error: details.join(' ') });
  process.exitCode = 1;
});
