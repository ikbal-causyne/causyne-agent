import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatPrompt } from '../src/tui/prompt.js';
import { StageSurface } from '../src/tui/stageSurface.js';

test('typing / opens and renders the command picker without crashing', () => {
  for (const useStage of [false, true]) {
    const out = {
      columns: 100, rows: 40, isTTY: true,
      write(_text: string) { return true; },
      on(_event: string, _listener: () => void) {},
      removeListener(_event: string, _listener: () => void) {}
    };
    const surface = useStage ? new StageSurface({ out }) : null;
    if (surface) surface.open();
    const prompt = new ChatPrompt({ out, surface });
    if (surface) prompt.attachSurface(surface);
    prompt.active = true;
    try {
      assert.doesNotThrow(() => prompt.handleData(Buffer.from('/')));
      assert.ok(prompt.completion?.items.length > 0);
      assert.ok(prompt.pickerLayout?.pickerCount > 0);
    } finally {
      prompt.active = false;
      if (surface) surface.close();
    }
  }
});
