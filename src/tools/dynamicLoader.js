import fs from 'fs';
import path from 'path';
import os from 'os';
import { causyneHome } from '../utils/paths.js';

const CUSTOM_TOOLS_DIR = path.join(causyneHome(), 'custom_tools');

/**
 * Ensures the custom_tools directory exists and loads any JavaScript
 * files inside it as dynamic tools. This enables the Self-Evolving Engine.
 */
export async function loadDynamicTools() {
  if (!fs.existsSync(CUSTOM_TOOLS_DIR)) {
    fs.mkdirSync(CUSTOM_TOOLS_DIR, { recursive: true, mode: 0o700 });
  }

  const files = fs.readdirSync(CUSTOM_TOOLS_DIR).filter(file => file.endsWith('.js'));
  const loadedTools = {};

  for (const file of files) {
    try {
      const filePath = path.join(CUSTOM_TOOLS_DIR, file);
      // Use dynamic import. On Windows we need a file:// URL.
      const fileUrl = os.platform() === 'win32' ? `file://${filePath.replace(/\\/g, '/')}` : filePath;
      
      const module = await import(fileUrl);
      
      if (module.TOOL_DEFINITION && typeof module.execute === 'function') {
        const name = module.TOOL_DEFINITION.name;
        loadedTools[name] = {
          definition: module.TOOL_DEFINITION,
          execute: module.execute
        };
        console.log(`[FORGE] Loaded evolved tool: ${name}`);
      } else {
        console.warn(`[FORGE] Ignored ${file}: Missing TOOL_DEFINITION or execute() function.`);
      }
    } catch (e) {
      console.error(`[FORGE] Failed to load custom tool ${file}:`, e.message);
    }
  }

  return loadedTools;
}
