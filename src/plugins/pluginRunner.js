import { pathToFileURL } from 'node:url';

const MAX_INPUT_BYTES = 1024 * 1024;
const RESULT_PREFIX = 'CAUSYNE_PLUGIN_RESULT:';

function writeResult(payload) {
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(payload)}\n`);
}

async function readInput() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
      throw new Error('Plugin input exceeds 1 MB');
    }
  }
  return JSON.parse(input || '{}');
}

async function main() {
  const entry = process.argv[2];
  const exportName = process.argv[3] || 'execute';
  if (!entry) throw new Error('Plugin entry path is required');

  const payload = await readInput();
  const imported = await import(pathToFileURL(entry).href);
  const execute = imported[exportName];
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
  const details = [error?.message || String(error)];
  if (error?.permission) details.push(`permission=${error.permission}`);
  if (error?.resource) details.push(`resource=${error.resource}`);
  writeResult({ success: false, error: details.join(' ') });
  process.exitCode = 1;
});
