import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Phase 2 AGI Upgrade: Tree-Map Algorithm with Depth Limiting
async function generateTree(dirPath, currentDepth, maxDepth, prefix = '') {
  if (currentDepth > maxDepth) return '';

  let treeStr = '';
  try {
    const items = await fs.readdir(dirPath, { withFileTypes: true });
    
    // Sort directories first
    items.sort((a, b) => {
      if (a.isDirectory() === b.isDirectory()) return a.name.localeCompare(b.name);
      return a.isDirectory() ? -1 : 1;
    });

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      // AGI Optimization: Aggressively ignore massive hidden folders
      if (item.name === 'node_modules' || item.name === '.git' || item.name === '.gradle') {
        continue; 
      }

      const isLast = i === items.length - 1;
      const marker = isLast ? '└── ' : '├── ';
      const newPrefix = prefix + (isLast ? '    ' : '│   ');
      
      let metadata = '';
      if (!item.isDirectory()) {
        try {
          const stats = await fs.stat(path.join(dirPath, item.name));
          const sizeKb = Math.round(stats.size / 1024);
          metadata = ` (${sizeKb}KB)`;
        } catch (e) {}
      }

      treeStr += `${prefix}${marker}${item.name}${item.isDirectory() ? '/' : ''}${metadata}\n`;

      if (item.isDirectory()) {
        treeStr += await generateTree(path.join(dirPath, item.name), currentDepth + 1, maxDepth, newPrefix);
      }
    }
  } catch (e) {
    treeStr += `${prefix}└── [Access Denied]\n`;
  }
  return treeStr;
}

export const fsList = {
  schema: {
    name: 'fs.list',
    description: 'List directory contents as an interactive Tree-Map. Gives spatial awareness of a project layout.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list' },
        depth: { type: 'number', description: 'Recursion depth (default 2)' }
      },
      required: ['path']
    }
  },
  async execute(args) {
    try {
      const target = args.path.replace(/^~\//, os.homedir() + '/');
      const maxDepth = args.depth || 2;
      
      const tree = await generateTree(target, 1, maxDepth);
      const header = `📁 ${target}\n`;
      
      return { success: true, output: header + (tree || '  (Empty or access denied)') };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
