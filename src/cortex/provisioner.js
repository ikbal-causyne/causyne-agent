import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { causyneHome } from '../utils/paths.js';

const CORTEX_DIR = path.join(causyneHome(), 'cortex');

// Read-only check. The legacy implementation silently ran npm during memory
// initialization. Optional native packages now require explicit manual setup.
export async function provisionCortexDependencies() {
  for (const name of ['better-sqlite3', '@xenova/transformers']) {
    if (!fs.existsSync(path.join(CORTEX_DIR, 'node_modules', name))) {
      throw new Error('Optional Cortex dependencies are not installed. Automatic installation is disabled; see docs/OPTIONAL_CAPABILITIES.md. Standard local session memory remains available.');
    }
  }
}

export async function requireCortexModule(moduleName) {
  if (!['better-sqlite3', '@xenova/transformers'].includes(moduleName)) {
    throw new Error(`Unsupported Cortex module: ${moduleName}`);
  }
  const require = createRequire(path.join(CORTEX_DIR, 'package.json'));
  const resolved = require.resolve(moduleName);
  const mod = await import(pathToFileURL(resolved).href);
  return mod.default || mod;
}
