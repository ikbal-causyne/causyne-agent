import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { causyneHome } from '../utils/paths.js';
import { getErrorMessage } from './toolPathSafety.js';

export interface DynamicLoadedTool {
  definition: Record<string, unknown>;
  execute: (...args: unknown[]) => unknown;
}

const CUSTOM_TOOLS_DIR = path.join(causyneHome(), 'custom_tools');

export async function loadDynamicTools(): Promise<Record<string, DynamicLoadedTool>> {
  if (!fs.existsSync(CUSTOM_TOOLS_DIR)) {
    fs.mkdirSync(CUSTOM_TOOLS_DIR, { recursive: true, mode: 0o700 });
  }

  const files = fs.readdirSync(CUSTOM_TOOLS_DIR).filter((file) => file.endsWith('.js'));
  const loadedTools: Record<string, DynamicLoadedTool> = Object.create(null) as Record<string, DynamicLoadedTool>;

  for (const file of files) {
    try {
      const filePath = path.join(CUSTOM_TOOLS_DIR, file);
      const fileUrl = pathToFileURL(filePath).href;
      const mod = await import(fileUrl) as {
        TOOL_DEFINITION?: Record<string, unknown> & { name?: string };
        execute?: (...args: unknown[]) => unknown;
      };

      if (mod.TOOL_DEFINITION && typeof mod.TOOL_DEFINITION.name === 'string' && typeof mod.execute === 'function') {
        const name = mod.TOOL_DEFINITION.name;
        loadedTools[name] = {
          definition: mod.TOOL_DEFINITION,
          execute: mod.execute
        };
        console.log(`[FORGE] Loaded evolved tool: ${name}`);
      } else {
        console.warn(`[FORGE] Ignored ${file}: Missing TOOL_DEFINITION or execute() function.`);
      }
    } catch (e: unknown) {
      console.error(`[FORGE] Failed to load custom tool ${file}:`, getErrorMessage(e));
    }
  }

  return loadedTools;
}
