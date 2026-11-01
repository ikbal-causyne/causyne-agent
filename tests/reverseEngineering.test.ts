import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { reverseEngineering } from '../src/tools/reverseEngineering.js';
import { routePacks, PACKS } from '../src/toolPacks.js';
import { toolRegistry, canonicalToolName } from '../src/tools/registry.js';
import { ToolOutputStore } from '../src/tools/toolOutputStore.js';

test('reverseEngineering: schema has valid structure and supported actions', () => {
  assert.equal(reverseEngineering.schema.name, 'reverse_engineering');
  assert.ok(reverseEngineering.schema.description.length > 20);
  assert.ok(typeof reverseEngineering.execute === 'function');

  const actionProp = reverseEngineering.schema.parameters.properties.action;
  assert.ok(actionProp.enum.includes('inspect'));
  assert.ok(actionProp.enum.includes('decompile'));
  assert.ok(actionProp.enum.includes('unpack'));
  assert.ok(actionProp.enum.includes('deobfuscate'));
  assert.ok(actionProp.enum.includes('trace'));
  assert.ok(actionProp.enum.includes('status'));
});

test('reverseEngineering: status action returns local engine inventory', async () => {
  const result = await reverseEngineering.execute({ action: 'status' });
  assert.equal(result.success, true);
  assert.equal(result.action, 'status');
  assert.ok(typeof result.platform === 'string');
  assert.ok(typeof result.architecture === 'string');
  assert.ok(Array.isArray(result.capabilities));
  assert.ok(result.installedEngines && typeof result.installedEngines === 'object');
});

test('reverseEngineering: rejects missing filePath on inspect', async () => {
  const result = await reverseEngineering.execute({ action: 'inspect' });
  assert.equal(result.success, false);
  assert.ok(String(result.error).includes('requires a valid "filePath" parameter'));
});

test('reverseEngineering: rejects non-existent filePath', async () => {
  const result = await reverseEngineering.execute({
    action: 'inspect',
    filePath: '/tmp/non_existent_binary_for_test_123456.bin'
  });
  assert.equal(result.success, false);
  assert.ok(String(result.error).includes('File not found'));
});

test('reverseEngineering: inspects real Mach-O binary on macOS or synthetic ELF', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'causyne_re_test_'));

  try {
    // 1. Synthesize ELF64 Little-Endian binary header
    const elfPath = path.join(tmpDir, 'test_sample.elf');
    const elfBuf = Buffer.alloc(128);
    // Magic \x7fELF
    elfBuf[0] = 0x7f; elfBuf[1] = 0x45; elfBuf[2] = 0x4c; elfBuf[3] = 0x46;
    // 64-bit (2), Little-Endian (1)
    elfBuf[4] = 2; elfBuf[5] = 1;
    // e_type = ET_DYN (3: shared object / PIE)
    elfBuf.writeUInt16LE(3, 16);
    // e_machine = x86_64 (0x3e)
    elfBuf.writeUInt16LE(0x3e, 18);
    await fsp.writeFile(elfPath, elfBuf);

    const elfResult = await reverseEngineering.execute({ action: 'inspect', filePath: elfPath });
    assert.equal(elfResult.success, true);
    assert.equal(elfResult.format, 'ELF');
    assert.equal(elfResult.architecture, 'x86_64');
    assert.equal((elfResult.mitigations as any)?.pie, true);

    // 2. Synthesize PE/COFF Windows header
    const pePath = path.join(tmpDir, 'test_sample.exe');
    const peBuf = Buffer.alloc(512);
    // DOS header MZ
    peBuf[0] = 0x4d; peBuf[1] = 0x5a;
    // PE header offset at 0x3c -> 0x80
    peBuf.writeUInt32LE(0x80, 0x3c);
    // PE\0\0 signature
    peBuf.write('PE\0\0', 0x80, 4, 'utf8');
    // Machine = x86_64 (0x8664)
    peBuf.writeUInt16LE(0x8664, 0x84);
    // Optional header magic PE32+ (0x20b)
    peBuf.writeUInt16LE(0x20b, 0x80 + 24);
    // DllCharacteristics: DYNAMIC_BASE (0x40) | NX_COMPAT (0x100)
    peBuf.writeUInt16LE(0x0140, 0x80 + 24 + 70);
    await fsp.writeFile(pePath, peBuf);

    const peResult = await reverseEngineering.execute({ action: 'inspect', filePath: pePath });
    assert.equal(peResult.success, true);
    assert.equal(peResult.format, 'PE/COFF');
    assert.ok(String(peResult.architecture).includes('x86_64'));
    assert.equal((peResult.mitigations as any)?.pie, true);
    assert.equal((peResult.mitigations as any)?.nx, true);

    // 3. Inspect real system Mach-O binary if on macOS
    if (process.platform === 'darwin' && fs.existsSync('/bin/ls')) {
      const machoResult = await reverseEngineering.execute({ action: 'inspect', filePath: '/bin/ls' });
      assert.equal(machoResult.success, true);
      assert.equal(machoResult.format, 'Mach-O');
      assert.ok(machoResult.mitigations);
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test('reverseEngineering: deobfuscates script and extracts endpoints', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'causyne_re_script_'));

  try {
    const scriptPath = path.join(tmpDir, 'bundle.min.js');
    const scriptContent = `
      function login(){return fetch("https://api.example.com/v1/auth/login")}
      const adminRoute = "/admin/dashboard/users";
      const configUrl = "https://cdn.example.org/assets";
      //# sourceMappingURL=bundle.min.js.map
    `;
    await fsp.writeFile(scriptPath, scriptContent, 'utf8');

    const result = await reverseEngineering.execute({ action: 'deobfuscate', filePath: scriptPath });
    assert.equal(result.success, true);
    assert.equal(result.sourcemapDetected, true);
    assert.ok(Array.isArray(result.extractedRoutes));
    assert.ok(result.extractedRoutes.includes('https://api.example.com/v1/auth/login'));
    assert.ok(result.extractedRoutes.includes('/admin/dashboard/users'));
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test('reverseEngineering: generates runtime hook script template', async () => {
  const result = await reverseEngineering.execute({
    action: 'trace',
    target: 'SampleApp'
  });
  assert.equal(result.success, true);
  assert.equal(result.action, 'trace');
  assert.ok(String(result.hookScript).includes('SampleApp'));
  assert.ok(String(result.hookScript).includes('Interceptor.attach'));
});

test('toolPacks: reverse_engineering is registered in PACKS and routes on intent', () => {
  assert.ok(PACKS.reverse_engineering.includes('reverse_engineering'));

  // Should trigger on explicit reverse engineering intent
  const unlocked = routePacks('Can you decompile this Mach-O binary and analyze its security mitigations?');
  assert.ok(unlocked.includes('reverse_engineering'));

  // Should NOT trigger on ordinary coding or web tasks
  const webUnlocked = routePacks('Create a modern React landing page with smooth animations');
  assert.ok(!webUnlocked.includes('reverse_engineering'));
});

test('registry: canonical aliases map cleanly to reverse_engineering', () => {
  assert.equal(canonicalToolName('re_inspect_binary'), 'reverse_engineering');
  assert.equal(canonicalToolName('re_decompile'), 'reverse_engineering');
  assert.equal(canonicalToolName('re_unpack_bundle'), 'reverse_engineering');
  assert.equal(canonicalToolName('re_deobfuscate_script'), 'reverse_engineering');
  assert.equal(canonicalToolName('re_trace_runtime'), 'reverse_engineering');

  assert.ok(toolRegistry['reverse_engineering']);
  assert.ok(typeof toolRegistry['reverse_engineering'].execute === 'function');
});

test('toolOutputStore: DTOC offloading protects context on large outputs', () => {
  const store = new ToolOutputStore({ maxChars: 50 });
  const largeOutput = 'A'.repeat(500);
  const result = store.processToolOutput('test_sess', 're_call', largeOutput);

  assert.equal(result.isTruncated, true);
  assert.ok(result.diskPath);
  assert.ok(fs.existsSync(result.diskPath));

  // Clean up
  try { fs.unlinkSync(result.diskPath); } catch {}
});
