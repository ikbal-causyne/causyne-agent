import { pathToFileURL } from 'node:url';

const MAX_INPUT_BYTES = 1024 * 1024;
const RESULT_PREFIX = 'CAUSYNE_PLUGIN_RESULT:';

function writeResult(payload: unknown): void {
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(payload)}\n`);
}

async function readInput(): Promise<Record<string, unknown>> {
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
      throw new Error('Plugin input exceeds 1 MB');
    }
  }
  return JSON.parse(input || '{}') as Record<string, unknown>;
}

async function main(): Promise<void> {
  const entry = process.argv[2];
  const exportName = process.argv[3] || 'execute';
  if (!entry) throw new Error('Plugin entry path is required');

  const payload = await readInput();
  const imported = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
  const execute = imported[exportName];
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
