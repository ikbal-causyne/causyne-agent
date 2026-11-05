import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { causyneHome } from '../utils/paths.js';

const CORTEX_DIR = path.join(causyneHome(), 'cortex');

// Read-only check. The legacy implementation silently ran npm during memory
// initialization. Optional native packages now require explicit manual setup.
export async function provisionCortexDependencies(): Promise<void> {
  const allowed = ['better-sqlite3'];
  for (const name of allowed) {
    if (!fs.existsSync(path.join(CORTEX_DIR, 'node_modules', name))) {
      throw new Error('Optional Cortex dependencies are not installed. Automatic installation is disabled; see docs/OPTIONAL_CAPABILITIES.md. Standard local session memory remains available.');
    }
  }
}

export async function requireCortexModule(moduleName: string): Promise<any> {
  if (moduleName !== 'better-sqlite3') {
    throw new Error(`Unsupported Cortex module: ${moduleName}`);
  }
  const req = createRequire(path.join(CORTEX_DIR, 'package.json'));
  const resolved = req.resolve(moduleName);
  const mod = await import(pathToFileURL(resolved).href);
  return mod.default || mod;
}

