import { ChatPrompt } from '../../src/tui/prompt.js';
import { StageSurface } from '../../src/tui/stageSurface.js';

if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(71);
const surface = new StageSurface({ out: process.stdout, env: process.env });
if (!surface.open()) process.exit(72);
const prompt = new ChatPrompt({
  out: process.stdout, input: process.stdin, root: process.cwd(), surface,
  isCommand: text => text.startsWith('/'),
  onExit: () => { prompt.stop(); process.exit(0); }
});
prompt.attachSurface(surface);
prompt.start();
prompt.commit('assistant', () => ['CAUSYNE_VERIFY_READY']);
prompt.draw();

while (true) {
  const input = await prompt.read();
  if (input === 'verification-message') {
    if (!prompt.usageCard) process.exit(73);
    prompt.commit('assistant', () => ['CAUSYNE_VERIFY_MESSAGE_OK']);
    surface.stage.invalidate();
    prompt.draw();
  } else if (input === 'verify-exit') {
    if (prompt.statusCard === null || prompt.usageCard !== null) process.exit(74);
    prompt.commit('assistant', () => ['CAUSYNE_VERIFY_EXIT_OK']);
    surface.stage.invalidate();
    prompt.draw();
    prompt.stop();
    process.exit(0);
  } else if (typeof input === 'string' && !input.startsWith('/')) {
    process.exit(75);
  }
}
