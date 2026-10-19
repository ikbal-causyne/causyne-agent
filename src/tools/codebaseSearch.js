import fs from 'fs/promises';
import path from 'path';

// Phase 1 AGI Upgrade: Native File Walk (No Bash/Grep)
async function walkDir(dir, excludes, fileList = []) {
  const files = await fs.readdir(dir, { withFileTypes: true });
  for (const file of files) {
    if (excludes.includes(file.name)) continue;
    const filePath = path.join(dir, file.name);
    if (file.isDirectory()) {
      await walkDir(filePath, excludes, fileList);
    } else {
      fileList.push(filePath);
    }
  }
  return fileList;
}

export const codebaseSearch = {
  schema: {
    name: 'codebase_search',
    description: 'Find snippets of code natively. Understands architecture without shell commands.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query to find relevant code.' },
        target_directories: { type: 'array', items: { type: 'string' }, description: 'Directories to search' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  async execute(args) {
    try {
      const dirs = args.target_directories && args.target_directories.length > 0 
        ? args.target_directories 
        : ['.'];
        
      const excludes = ['node_modules', '.git', 'build', 'dist', '.gradle'];
      let allFiles = [];
      
      for (const dir of dirs) {
        const fullPath = path.resolve(process.cwd(), dir);
        try {
          const files = await walkDir(fullPath, excludes);
          allFiles = allFiles.concat(files);
        } catch(e) {} // Ignore unreadable dirs
      }
      
      let results = [];
      const regex = new RegExp(args.query, 'i'); 
      
      for (const file of allFiles) {
        // Skip binary extensions natively
        if (/\.(png|jpe?g|gif|svg|pdf|exe|dll|zip|tar|gz)$/i.test(file)) continue;
        
        try {
          const content = await fs.readFile(file, 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              results.push(`${file}:${i+1}:${lines[i].trim()}`);
              if (results.length >= 50) break; // Token Budget Protection
            }
          }
        } catch(e) {} // Ignore unreadable files
        if (results.length >= 50) break;
      }
      
      return { success: true, output: results.length > 0 ? results.join('\n') : 'No results found.' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
