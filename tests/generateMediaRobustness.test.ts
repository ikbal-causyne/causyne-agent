import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { generateMediaViaApi } from '../src/tools/generateMediaViaApi.js';
import { saveConfig } from '../src/config.js';
import { selfRepairToolCall } from '../src/tools/toolSelfRepair.js';

describe('generateMediaViaApi robustness', () => {
  it('heals missing mediaType and maps type to mediaType', () => {
    const healed = selfRepairToolCall({
      name: 'generate_media_via_api',
      arguments: { prompt: 'a beautiful sunset', type: 'image' }
    });

    assert.equal(healed.repaired, true);
    assert.equal(healed.args.mediaType, 'image');
    assert.equal(healed.args.prompt, 'a beautiful sunset');
  });

  it('uses a default workspace filename when an authenticated provider returns valid media', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-media-test-'));
    saveConfig({ provider: 'antigravity', autonomyMode: 'C', pollinationsApiKey: 'fixture-only-key' });
    const original = globalThis.fetch;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKp8AAAAASUVORK5CYII=', 'base64');
    globalThis.fetch = async () => new Response(png, { headers: { 'content-type': 'image/png' } });
    try {
      const result = await generateMediaViaApi.execute({ mediaType: 'image', prompt: 'a radiant solar system with planets', width: 256, height: 256 }, { workspaceRoot: tmpDir });
      assert.equal(result.success, true);
      const files = fs.readdirSync(tmpDir);
      assert.equal(files.length, 1);
      assert.deepEqual(fs.readFileSync(path.join(tmpDir, files[0]!)), png);
      assert.equal(result.sizeBytes, png.length);
    } finally { globalThis.fetch = original; fs.rmSync(tmpDir, { recursive: true, force: true }); }
  });
});
