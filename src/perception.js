import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export class WorkspacePerception {
  async buildContext(workspacePath) {
    const context = {};
    const resolvedPath = workspacePath.replace(/^~\//, os.homedir() + '/');
    
    // 1. Directory structure (tree, max depth 2 to keep context size manageable)
    context.structure = await this.getDirectoryTree(resolvedPath, 2);
    
    // 2. Framework detection
    context.framework = await this.detectFramework(resolvedPath);
    
    // 2b. Design system detection (Anti-Slop: tells the brain what's already installed)
    context.designSystem = await this.detectDesignContext(resolvedPath);
    
    // 3. Package/dependency context
    try {
      const pkgPath = path.join(resolvedPath, 'package.json');
      const pkgStats = await fs.stat(pkgPath);
      if (pkgStats.isFile()) {
        const pkgData = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
        context.packageJson = {
          name: pkgData.name,
          dependencies: pkgData.dependencies || {},
          devDependencies: pkgData.devDependencies || {},
          scripts: pkgData.scripts || {}
        };
      }
    } catch(e) {}
    
    // 4. README (first 1000 chars)
    try {
      const readmePath = path.join(resolvedPath, 'README.md');
      const readmeContent = await fs.readFile(readmePath, 'utf8');
      context.readme = readmeContent.slice(0, 1000) + (readmeContent.length > 1000 ? '...' : '');
    } catch(e) {}
    
    // 5. OS & environment
    context.os = { platform: os.platform(), arch: os.arch() };
    
    return context;
  }
  
  async getDirectoryTree(dir, maxDepth, currentDepth = 0) {
    if (currentDepth > maxDepth) return '... (max depth reached)';
    
    try {
      const items = await fs.readdir(dir, { withFileTypes: true });
      const tree = {};
      
      let count = 0;
      for (const item of items) {
        if (item.name.startsWith('.') || item.name === 'node_modules') continue;
        
        if (count >= 30) {
          tree['...'] = `(${items.length - count} more items hidden)`;
          break;
        }
        
        count++;
        if (item.isDirectory()) {
          tree[item.name] = await this.getDirectoryTree(path.join(dir, item.name), maxDepth, currentDepth + 1);
        } else {
          tree[item.name] = 'file';
        }
      }
      return tree;
    } catch (e) {
      return `Error: ${e.message}`;
    }
  }

  async detectFramework(dir) {
    const detectors = [
      { file: 'next.config.js', type: 'nextjs', lang: 'javascript' },
      { file: 'next.config.ts', type: 'nextjs', lang: 'typescript' },
      { file: 'vite.config.ts', type: 'vite', lang: 'typescript' },
      { file: 'tsconfig.json', type: 'node', lang: 'typescript' },
      { file: 'package.json', type: 'node', lang: 'javascript' },
      { file: 'manage.py', type: 'django', lang: 'python' },
      { file: 'requirements.txt', type: 'python', lang: 'python' },
      { file: 'build.gradle.kts', type: 'android', lang: 'kotlin' },
      { file: 'docker-compose.yml', type: 'docker', lang: 'various' },
    ];
    
    for (const d of detectors) {
      try {
        await fs.access(path.join(dir, d.file));
        return { type: d.type, language: d.lang };
      } catch (e) {}
    }
    
    return { type: 'unknown', language: 'unknown' };
  }

  async detectDesignContext(dir) {
    const designDetectors = [
      { dep: 'tailwindcss', system: 'Tailwind CSS' },
      { dep: '@astryxdesign/core', system: 'Astryx Design System' },
      { dep: '@mui/material', system: 'Material-UI (MUI)' },
      { dep: '@chakra-ui/react', system: 'Chakra UI' },
      { dep: 'bootstrap', system: 'Bootstrap' },
      { dep: 'styled-components', system: 'Styled Components' },
      { dep: '@emotion/react', system: 'Emotion CSS-in-JS' },
    ];

    try {
      const pkgPath = path.join(dir, 'package.json');
      const pkgData = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
      const allDeps = { ...pkgData.dependencies, ...pkgData.devDependencies };

      const detected = designDetectors
        .filter(d => allDeps[d.dep])
        .map(d => d.system);

      return detected.length > 0 ? detected : null;
    } catch (e) {
      return null;
    }
  }
}
