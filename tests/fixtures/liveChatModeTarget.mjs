import { chatMode } from '../../src/cliMode.js';

const isolatedHome = process.env.CAUSYNE_HOME;
if (!isolatedHome) process.exit(81);
process.chdir(isolatedHome);
await chatMode({ home: false });
