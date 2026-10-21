import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import os from 'os';

const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.gradle',
  '.idea', '.cache', 'coverage', 'vendor', 'Pods', '.causyne'
]);

export class WorkspacePerception {
  async buildContext(workspacePath) {
    const context = {};
    const resolvedPath = workspacePath.replace(/^~\//, os.homedir() + '/');

    context.cwd = resolvedPath;
    context.projectName = path.basename(resolvedPath);

    // 1. Directory structure (tree, max depth 2 to keep context size manageable)
    context.structure = await this.getDirectoryTree(resolvedPath, 2);

    // 2. Framework detection
    const fw = await this.detectFramework(resolvedPath);
    if (fw && fw.type !== 'unknown') {
      const fwStr = `${fw.type} (${fw.language})`;
      context.framework = Object.assign(new String(fwStr), {
        type: fw.type,
        language: fw.language,
        toString: () => fwStr
      });
    } else {
      context.framework = null;
    }

    // 2b. Design system detection (Anti-Slop: tells the brain what's already installed)
    context.designSystem = await this.detectDesignContext(resolvedPath);

    // 2c. Subprojects detection (find subfolders like 'pixel2d games', 'causyne-agent', etc.)
    context.subprojects = await this.detectSubprojects(resolvedPath);

    // 2d. Key files discovery
    context.keyFiles = await this.detectKeyFiles(resolvedPath);

    // 2e. Package manager detection
    context.packageManager = await this.detectPackageManager(resolvedPath);

    // 2f. Git branch and status
    const gitInfo = await this.detectGitInfo(resolvedPath);
    if (gitInfo.branch) context.gitBranch = gitInfo.branch;
    if (gitInfo.status) context.gitStatus = gitInfo.status;

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

    // 3b. Project type classification
    context.projectType = await this.detectProjectType(resolvedPath, context);

    // 4. README (first 1000 chars)
    try {
      const readmePath = path.join(resolvedPath, 'README.md');
      const readmeContent = await fs.readFile(readmePath, 'utf8');
      context.readme = readmeContent.slice(0, 1000) + (readmeContent.length > 1000 ? '...' : '');
    } catch(e) {}

    // 5. OS & environment
    const osStr = `${os.platform()} (${os.arch()})`;
    context.os = Object.assign(new String(osStr), {
      platform: os.platform(),
      arch: os.arch(),
      toString: () => osStr
    });

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
      { file: 'next.config.mjs', type: 'nextjs', lang: 'javascript' },
      { file: 'vite.config.ts', type: 'vite', lang: 'typescript' },
      { file: 'vite.config.js', type: 'vite', lang: 'javascript' },
      { file: 'nuxt.config.ts', type: 'nuxt', lang: 'typescript' },
      { file: 'astro.config.mjs', type: 'astro', lang: 'javascript' },
      { file: 'svelte.config.js', type: 'svelte', lang: 'javascript' },
      { file: 'tsconfig.json', type: 'node', lang: 'typescript' },
      { file: 'package.json', type: 'node', lang: 'javascript' },
      { file: 'manage.py', type: 'django', lang: 'python' },
      { file: 'pyproject.toml', type: 'python', lang: 'python' },
      { file: 'requirements.txt', type: 'python', lang: 'python' },
      { file: 'Cargo.toml', type: 'rust', lang: 'rust' },
      { file: 'go.mod', type: 'go', lang: 'go' },
      { file: 'project.godot', type: 'godot', lang: 'gdscript' },
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

  async detectSubprojects(dir) {
    const subprojects = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue;

        const subDir = path.join(dir, entry.name);
        const markers = [
          'package.json', 'index.html', 'project.godot', 'main.py',
          'Cargo.toml', 'requirements.txt', 'go.mod', 'Makefile', 'CMakeLists.txt'
        ];

        for (const marker of markers) {
          try {
            await fs.access(path.join(subDir, marker));
            subprojects.push(entry.name);
            break;
          } catch (e) {}
        }
      }
    } catch (e) {}
    return subprojects;
  }

  async detectKeyFiles(dir) {
    const candidateFiles = [
      'package.json', 'tsconfig.json', 'index.html', 'main.js',
      'src/index.js', 'src/index.ts', 'src/main.js', 'src/main.ts',
      'src/App.tsx', 'src/App.jsx', 'README.md', 'project.godot',
      'Makefile', 'docker-compose.yml', 'Dockerfile'
    ];
    const found = [];
    for (const rel of candidateFiles) {
      try {
        await fs.access(path.join(dir, rel));
        found.push(rel);
      } catch (e) {}
    }
    return found;
  }

  async detectPackageManager(dir) {
    const managers = [
      { file: 'pnpm-lock.yaml', name: 'pnpm' },
      { file: 'bun.lockb', name: 'bun' },
      { file: 'bun.lock', name: 'bun' },
      { file: 'yarn.lock', name: 'yarn' },
      { file: 'package-lock.json', name: 'npm' },
      { file: 'Cargo.lock', name: 'cargo' },
      { file: 'Pipfile.lock', name: 'pipenv' },
      { file: 'poetry.lock', name: 'poetry' }
    ];

    for (const m of managers) {
      try {
        await fs.access(path.join(dir, m.file));
        return m.name;
      } catch (e) {}
    }

    try {
      await fs.access(path.join(dir, 'package.json'));
      return 'npm';
    } catch (e) {}

    return null;
  }

  async detectGitInfo(dir) {
    // Pure Node.js detection of git branch without external shell or git binary
    let current = dir;
    for (let depth = 0; depth < 5; depth++) {
      const gitDir = path.join(current, '.git');
      try {
        const stat = await fs.stat(gitDir);
        if (stat.isDirectory()) {
          const headFile = path.join(gitDir, 'HEAD');
          const headContent = await fs.readFile(headFile, 'utf8');
          const match = headContent.trim().match(/^ref:\s+refs\/heads\/(.+)$/);
          const branch = match ? match[1] : headContent.trim().slice(0, 8);
          return { branch, gitDir };
        }
      } catch (e) {}
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return { branch: null, gitDir: null };
  }

  async detectProjectType(dir, context) {
    const deps = context.packageJson ? {
      ...context.packageJson.dependencies,
      ...context.packageJson.devDependencies
    } : {};

    // 1. Game Development (2D Canvas, WebGL, Pixi, Phaser, Godot, Kaplay)
    const gameLibs = ['phaser', 'pixi.js', 'kaboom', 'kaplay', 'three', 'howler', 'matter-js', 'planck'];
    if (gameLibs.some(lib => deps[lib])) {
      return '2D / Canvas Game Project';
    }

    try {
      await fs.access(path.join(dir, 'project.godot'));
      return 'Godot Game Project';
    } catch (e) {}

    // Check directory name or key files for game patterns
    const baseName = path.basename(dir).toLowerCase();
    if (baseName.includes('game') || baseName.includes('pixel') || baseName.includes('arcade')) {
      return '2D Game Project';
    }

    // 2. Web Application
    if (deps['next'] || deps['react'] || deps['vue'] || deps['svelte'] || deps['vite']) {
      return 'Frontend Web Application';
    }

    // 3. Backend / Server / Service
    if (deps['express'] || deps['fastify'] || deps['koa'] || deps['@nestjs/core']) {
      return 'Backend Web Service';
    }

    if (context.framework && context.framework.type === 'android') {
      return 'Android Application';
    }

    if (context.framework && context.framework.type === 'rust') {
      return 'Rust Application / Library';
    }

    return 'Software Application';
  }
}
