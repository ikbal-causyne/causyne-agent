import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fsSearch } from '../src/tools/fsSearch.js';
import { fsFind } from '../src/tools/fsFind.js';
import { fsList } from '../src/tools/fsList.js';
import { codeSearcher } from '../src/tools/codeSearcher.js';
import { codebaseSearch } from '../src/tools/codebaseSearch.js';
import {
  TraversalGuard,
  buildTopLevelHomeExcludes,
  compileSafeSearchRegex,
  shouldExcludeChild,
  validateRegexSafety
} from '../src/tools/walkerSafety.js';
import { Sandbox } from '../src/sandbox.js';

function createTempFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-search-safety-'));
  const ws = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');

  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.git', 'refs'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  fs.writeFileSync(
    path.join(ws, 'src', 'app.ts'),
    'export const NEEDLE_TOKEN = "inside-workspace";\n'
  );
  fs.writeFileSync(
    path.join(ws, 'node_modules', 'pkg', 'index.js'),
    'exports.NEEDLE_TOKEN = "inside-node-modules";\n'
  );
  fs.writeFileSync(
    path.join(ws, '.git', 'config'),
    '# NEEDLE_TOKEN inside git metadata\n'
  );
  fs.writeFileSync(
    path.join(outside, 'secret.txt'),
    'NEEDLE_TOKEN = "outside-workspace";\n'
  );

  // Cyclic and escaping symlinks inside the workspace (handle Windows EPERM cleanly)
  let hasDirSymlink = true;
  let hasFileSymlink = true;
  try {
    fs.symlinkSync(ws, path.join(ws, 'loop_dir'), 'dir');
    fs.symlinkSync(outside, path.join(ws, 'escape_dir'), 'dir');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'EPERM' && code !== 'EACCES') throw err;
    hasDirSymlink = false;
  }
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(ws, 'escape_file.txt'), 'file');
    fs.symlinkSync(path.join(ws, 'missing_target.txt'), path.join(ws, 'broken_link.txt'), 'file');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'EPERM' && code !== 'EACCES') throw err;
    hasFileSymlink = false;
  }

  return {
    root,
    ws,
    outside,
    hasDirSymlink,
    hasFileSymlink,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

describe('Search and directory walker safety', () => {
  test('all 5 search/listing tools skip symlink cycles, outside symlinks, node_modules, and .git', async () => {
    const fx = createTempFixture();
    const ctx = { workspacePaths: [fx.ws] };
    try {
      const searchRes = await fsSearch.execute({ path: fx.ws, query: 'NEEDLE_TOKEN' }, ctx);
      assert.equal(searchRes.success, true);
      assert.match(searchRes.output || '', /app\.ts/);
      assert.doesNotMatch(searchRes.output || '', /secret\.txt/);
      assert.doesNotMatch(searchRes.output || '', /escape_file\.txt/);
      assert.doesNotMatch(searchRes.output || '', /node_modules/);
      assert.doesNotMatch(searchRes.output || '', /\.git/);

      const findRes = await fsFind.execute(
        { path: fx.ws, keywords: ['app', 'secret', 'index', 'config'] },
        ctx
      );
      assert.equal(findRes.success, true);
      const findJson = JSON.parse(findRes.output || '{}');
      const foundList = Array.isArray(findJson.matches) ? findJson.matches.join('\n') : '';
      assert.match(foundList, /app\.ts/);
      assert.doesNotMatch(foundList, /secret\.txt/);
      assert.doesNotMatch(foundList, /node_modules/);
      assert.doesNotMatch(foundList, /\.git/);

      const listRes = await fsList.execute({ path: fx.ws, depth: 3 }, ctx);
      assert.equal(listRes.success, true);
      assert.match(listRes.output || '', /app\.ts/);
      if (fx.hasDirSymlink || fx.hasFileSymlink) {
        assert.match(listRes.output || '', /symlink outside scope skipped|Symlink Cycle Skipped/);
      }
      assert.doesNotMatch(listRes.output || '', /secret\.txt/);
      assert.doesNotMatch(listRes.output || '', /node_modules/);

      const rgRes = await codeSearcher.execute({ searchPath: fx.ws, query: 'NEEDLE_TOKEN' }, ctx);
      assert.equal(rgRes.success, true);
      assert.match(rgRes.output || '', /app\.ts/);
      assert.doesNotMatch(rgRes.output || '', /secret\.txt/);
      assert.doesNotMatch(rgRes.output || '', /node_modules/);
      assert.doesNotMatch(rgRes.output || '', /\.git/);

      const cbRes = await codebaseSearch.execute(
        { target_directories: [fx.ws], query: 'NEEDLE_TOKEN' },
        ctx
      );
      assert.equal(cbRes.success, true);
      assert.match(cbRes.output || '', /app\.ts/);
      assert.doesNotMatch(cbRes.output || '', /secret\.txt/);
      assert.doesNotMatch(cbRes.output || '', /node_modules/);
      assert.doesNotMatch(cbRes.output || '', /\.git/);
    } finally {
      fx.cleanup();
    }
  });

  test('all search/listing tools reject protected system roots and outside-workspace paths', async () => {
    const fx = createTempFixture();
    const ctx = { workspacePaths: [fx.ws] };
    try {
      const badPaths = [
        '/etc',
        fx.outside,
        ...(fx.hasFileSymlink ? [path.join(fx.ws, 'broken_link.txt')] : [])
      ];
      for (const badPath of badPaths) {
        const s = await fsSearch.execute({ path: badPath, query: 'NEEDLE' }, ctx);
        assert.equal(s.success, false, `fsSearch must reject ${badPath}`);

        const f = await fsFind.execute({ path: badPath, keywords: ['passwd'] }, ctx);
        assert.equal(f.success, false, `fsFind must reject ${badPath}`);

        const l = await fsList.execute({ path: badPath }, ctx);
        assert.equal(l.success, false, `fsList must reject ${badPath}`);

        const c = await codeSearcher.execute({ searchPath: badPath, query: 'NEEDLE' }, ctx);
        assert.equal(c.success, false, `codeSearcher must reject ${badPath}`);

        const cb = await codebaseSearch.execute({ target_directories: [badPath], query: 'NEEDLE' }, ctx);
        assert.equal(cb.success, false, `codebaseSearch must reject ${badPath}`);
      }

      const missing = await fsList.execute({ path: path.join(fx.ws, 'missing-dir') }, ctx);
      assert.equal(missing.success, false);
      assert.match(missing.error || '', /does not exist/i);
    } finally {
      fx.cleanup();
    }
  });

  test('explicit search into node_modules inside workspace still works when directly targeted', async () => {
    const fx = createTempFixture();
    const ctx = { workspacePaths: [fx.ws] };
    try {
      const res = await fsSearch.execute(
        { path: path.join(fx.ws, 'node_modules'), query: 'inside-node-modules' },
        ctx
      );
      assert.equal(res.success, true);
      assert.match(res.output || '', /index\.js/);
    } finally {
      fx.cleanup();
    }
  });

  test('ReDoS regex patterns are rejected immediately when isRegex is true and literal when false', async () => {
    const fx = createTempFixture();
    const ctx = { workspacePaths: [fx.ws] };
    try {
      for (const dangerous of ['(a+)+$', '(a|aa)+$', '([a-z]+)*$', '(a)\\1', 'a{9999}', 'x'.repeat(501)]) {
        assert.ok(validateRegexSafety(dangerous), `Expected rejection for ${dangerous}`);
        const compiled = compileSafeSearchRegex(dangerous, { isRegex: true });
        assert.equal(compiled.regex, undefined);
        assert.ok(compiled.error);
      }

      for (const safe of ['android/.*gradle', 'foo\\.(ts|js)$', '[a-z0-9_]+', 'a{1,5}']) {
        assert.equal(validateRegexSafety(safe), null, `Unexpected rejection for ${safe}`);
      }

      const t0 = Date.now();
      const sErr = await fsSearch.execute({ path: fx.ws, query: '(a+)+$', isRegex: true }, ctx);
      assert.equal(sErr.success, false);
      assert.match(sErr.error || '', /Nested quantifiers|ReDoS/i);

      const rgErr = await codeSearcher.execute(
        { searchPath: fx.ws, query: '(a|aa)+$', isRegex: true },
        ctx
      );
      assert.equal(rgErr.success, false);
      assert.match(rgErr.error || '', /Nested quantifiers|ReDoS/i);

      const cbErr = await codebaseSearch.execute(
        { target_directories: [fx.ws], query: '(a+)+$', isRegex: true },
        ctx
      );
      assert.equal(cbErr.success, false);

      // Literal default treats '(a+)+$' safely without backtracking
      const litRes = await fsSearch.execute({ path: fx.ws, query: '(a+)+$' }, ctx);
      assert.equal(litRes.success, true);
      assert.ok(Date.now() - t0 < 2000, 'ReDoS guard must return immediately');
    } finally {
      fx.cleanup();
    }
  });

  test('TraversalGuard enforces maxDirs, maxFiles, maxDepth, timeoutMs, and AbortSignal', async () => {
    const fx = createTempFixture();
    const ctxBase = { workspacePaths: [fx.ws] };
    try {
      const dirGuard = new TraversalGuard({ maxDirs: 1 });
      assert.equal(dirGuard.enterDir(0), true);
      assert.equal(dirGuard.enterDir(1), false);
      assert.equal(dirGuard.stopReason, 'max_dirs');

      const depthGuard = new TraversalGuard({ maxDepth: 2 });
      assert.equal(depthGuard.enterDir(2), true);
      assert.equal(depthGuard.enterDir(3), false);

      const fileGuard = new TraversalGuard({ maxFiles: 1 });
      assert.equal(fileGuard.countFile(), true);
      assert.equal(fileGuard.countFile(), false);
      assert.equal(fileGuard.stopReason, 'max_files');

      const timeoutGuard = new TraversalGuard({ timeoutMs: 0 });
      assert.equal(timeoutGuard.checkStopped(), 'timeout');

      const ac = new AbortController();
      ac.abort();
      const abortedCtx = { ...ctxBase, signal: ac.signal };

      const s = await fsSearch.execute({ path: fx.ws, query: 'NEEDLE_TOKEN' }, abortedCtx);
      assert.equal(s.success, false);
      assert.equal(s.aborted, true);

      const f = await fsFind.execute({ path: fx.ws, keywords: ['app'] }, abortedCtx);
      assert.equal(f.success, false);
      assert.equal(f.aborted, true);

      const l = await fsList.execute({ path: fx.ws }, abortedCtx);
      assert.equal(l.success, false);
      assert.equal(l.aborted, true);

      const c = await codeSearcher.execute({ searchPath: fx.ws, query: 'NEEDLE_TOKEN' }, abortedCtx);
      assert.equal(c.success, false);
      assert.equal(c.aborted, true);

      const cb = await codebaseSearch.execute(
        { target_directories: [fx.ws], query: 'NEEDLE_TOKEN' },
        abortedCtx
      );
      assert.equal(cb.success, false);
      assert.equal(cb.aborted, true);
    } finally {
      fx.cleanup();
    }
  });

  test('Sandbox.validate covers searchPath, filePath, target_directories, tilde paths, and keeps non-fs targets', () => {
    const fx = createTempFixture();
    try {
      const sb = new Sandbox({ workspaceRoot: fx.ws });

      assert.equal(sb.validate('code_search_ripgrep', { searchPath: fx.outside, query: 'x' }).allowed, false);
      assert.equal(sb.validate('code_search_ripgrep', { searchPath: 'src', query: 'x' }).allowed, true);
      assert.equal(sb.validate('fs_read', { filePath: fx.outside }).allowed, false);
      assert.equal(sb.validate('fs_read', { filePath: 'src/app.ts' }).allowed, true);
      assert.equal(
        sb.validate('codebase_search', { query: 'x', target_directories: [fx.ws, fx.outside] }).allowed,
        false
      );
      assert.equal(
        sb.validate('codebase_search', { query: 'x', target_directories: ['src'] }).allowed,
        true
      );
      assert.equal(sb.validate('fs_search', { path: '~/some-outside-dir', query: 'x' }).allowed, false);

      // Non-filesystem `target` arguments must never be rejected as missing workspace paths
      assert.equal(sb.validate('vision_inspect_ui', { target: 'desktop' }).allowed, true);
      assert.equal(sb.validate('astryx_oracle', { target: 'https://example.com' }).allowed, true);
      assert.equal(sb.validate('desktop_act', { target: 'Submit' }).allowed, true);
    } finally {
      fx.cleanup();
    }
  });

  test('HOME_NOISE_EXCLUDES apply only directly inside the home root, not inside project subdirectories', () => {
    const projectDir = path.join(os.tmpdir(), 'sample-project');
    assert.equal(shouldExcludeChild(projectDir, 'Library'), false);
    assert.equal(shouldExcludeChild(projectDir, '.causyne'), false);
    assert.equal(shouldExcludeChild(projectDir, 'node_modules'), true);
    assert.deepEqual(buildTopLevelHomeExcludes(projectDir), []);
  });
});
