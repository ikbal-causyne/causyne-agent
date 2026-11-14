import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CodeStreamRenderer } from '../src/tui/codeStreamRenderer.js';

describe('CodeStreamRenderer finite clock bounds', () => {
  it('onStatusTick ignores non-finite nowMs and tick without corrupting streaming shimmer or duration', () => {
    const writes: string[] = [];
    const frame = {
      id: 1,
      meta: { reasoning: true, streaming: true, durationText: '1s' },
      rows: ['cached'] as string[] | null,
      renderedWidth: 80
    };
    const renderer = new CodeStreamRenderer({
      measure: () => 80,
      write: (line = '') => writes.push(line)
    });
    (renderer as unknown as { transcript: unknown }).transcript = {
      frames: [frame],
      cache: null,
      revision: 0,
      flatten: () => ({ markers: [] }),
      append(line = '') { writes.push(line); },
      changed() {}
    };

    renderer.onStatusTick(2500, 3);
    assert.equal(frame.meta.durationText, '2.5s');

    renderer.onStatusTick(Number.NaN, Number.NaN);
    renderer.onStatusTick(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    assert.equal(frame.meta.durationText, '2.5s');

    writes.length = 0;
    renderer.renderReasoning('analyzing', { streaming: true });
    assert.ok(writes.length > 0);
    // Subsequent valid renderReasoning must still receive the last finite tick/nowMs instead of NaN.
    const streamed = renderer as unknown as { streamingNowMs: number; streamingTick: number | undefined };
    assert.equal(streamed.streamingNowMs, 2500);
    assert.equal(streamed.streamingTick, 3);
  });
});
