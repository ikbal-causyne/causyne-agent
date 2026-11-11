// Deliberately pathological regex inputs belong in non-executable test data.
// Read them at runtime so CodeQL can evaluate executable regexes rather than
// mistaking a rejected attack fixture for an application RegExp.
import fs from 'node:fs';

export const adversarialRegex = Object.freeze(JSON.parse(
  fs.readFileSync(new URL('../fixtures/adversarialRegex.json', import.meta.url), 'utf8')
));
