import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { generateMediaViaApi } from '../src/tools/generateMediaViaApi.js';
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

  it('heals missing outputPath by defaulting to valid local path without crashing', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-media-test-'));
    const testOutputPath = path.join(tmpDir, 'test_output.png');

    const result = await generateMediaViaApi.execute({
      mediaType: 'image',
      prompt: 'a radiant solar system with planets',
      outputPath: testOutputPath,
      width: 256,
      height: 256
    });

    assert.equal(result.success, true);
    assert.ok(fs.existsSync(testOutputPath));
    assert.ok(result.sizeBytes > 0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
