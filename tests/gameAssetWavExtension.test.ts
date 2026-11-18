import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gameAssetFetcher } from '../src/tools/gameAssetFetcher.js';

test('WAV synthesis refuses misleading audio file extensions', async () => {
  for (const filename of ['audio.mp3', 'audio.ogg', 'audio.txt']) {
    const result = await gameAssetFetcher.execute({
      action:'synth_wav',preset:'coin',outputFilename:filename
    });
    assert.equal(result.success,false,filename);
    assert.match(result.error ?? '',/must use a .wav/);
  }
});
