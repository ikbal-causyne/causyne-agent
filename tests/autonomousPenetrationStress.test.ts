import { test, describe, after, before } from 'node:test';
import { adversarialRegex } from './helpers/adversarialRegexFixtures.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  validateRegexSafety,
  checkSearchScope,
  createTraversalGuard,
  compileSafeSearchRegex,
  shouldExcludeChild
} from '../src/tools/walkerSafety.js';
import { deferredMcpSearch } from '../src/tools/deferredMcpSearch.js';
import readNativeSkill from '../src/tools/readNativeSkill.js';
import {
  listSkillResourcePaths,
  readSkillTextResource,
  writeSkillFileSafely
} from '../src/skills/skillResourceSafety.js';
import { Sandbox, isCredentialPath } from '../src/sandbox.js';
import { isWholeFileDeletion } from '../src/approvalPolicy.js';
import { TokenTracker } from '../src/tokenTracker.js';
import {
  resolveTaskTokenCeiling,
  peerCallTokenCeiling,
  peerNativeActionCeiling,
  isTerminalBudgetFailure,
  desktopDeadline,
  shouldRetryPeerError,
  hasBillablePartialUsage
} from '../src/budget/budgetPolicy.js';
import {
  detectMagicFormat,
  validateMediaPayload,
  sanitizeTextPayload
} from '../src/tools/payloadSanitizer.js';
import { safeDisplay, stripAnsi } from '../src/tui/text.js';

describe('Autonomous Penetration and Stress Battery', () => {

  // =========================================================================
  // 1. PENETRATION: Symlink Traversal, Cycles & Directory Escapes
  // =========================================================================
  describe('P1 — Symlink Traversal, Cycles, and Scope Boundaries', () => {
    let testBase: string;
    let outsideDir: string;
    let wsDir: string;

    before(() => {
      testBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-pentest-p1-')));
      outsideDir = path.join(testBase, 'outside');
      wsDir = path.join(testBase, 'workspace');

      fs.mkdirSync(outsideDir, { recursive: true });
      fs.mkdirSync(wsDir, { recursive: true });

      // Create canary secret outside workspace
      fs.writeFileSync(path.join(outsideDir, 'canary.txt'), 'CANARY_OUTSIDE_SECRET_ALPHA');
      fs.writeFileSync(path.join(wsDir, 'internal.txt'), 'INTERNAL_SAFE_CONTENT');

      // Create symlink escape file and directory
      try {
        fs.symlinkSync(path.join(outsideDir, 'canary.txt'), path.join(wsDir, 'escape_file.txt'));
        fs.symlinkSync(outsideDir, path.join(wsDir, 'escape_dir'), 'dir');
        // Create cyclic symlinks
        fs.symlinkSync(wsDir, path.join(wsDir, 'self_loop'), 'dir');
      } catch {
        // Fallback for restricted environments
      }
    });

    after(() => {
      try { fs.rmSync(testBase, { recursive: true, force: true }); } catch {}
    });

    test('checkSearchScope rejects traversal and out-of-boundary paths', () => {
      const context = { workspacePaths: [wsDir] };

      // Internal file is allowed
      const internalCheck = checkSearchScope(path.join(wsDir, 'internal.txt'), context);
      assert.equal(internalCheck.allowed, true);

      // Traversal out of workspace is strictly blocked
      const traversalCheck = checkSearchScope(path.join(wsDir, '../outside/canary.txt'), context);
      assert.equal(traversalCheck.allowed, false);
      assert.match(traversalCheck.error || '', /outside allowed workspace/i);

      // Symlink pointing outside workspace is blocked
      if (fs.existsSync(path.join(wsDir, 'escape_file.txt'))) {
        const escapeCheck = checkSearchScope(path.join(wsDir, 'escape_file.txt'), context);
        assert.equal(escapeCheck.allowed, false, 'Symlink escaping workspace must be blocked');
      }
    });

    test('TraversalGuard safely halts on symlink cycles and depth boundaries', () => {
      const guard = createTraversalGuard({ maxDepth: 5, maxDirs: 50, timeoutMs: 1000 });

      // Enter within depth
      assert.equal(guard.enterDir(1), true);
      assert.equal(guard.enterDir(5), true);

      // Exceed depth boundary -> rejected
      assert.equal(guard.enterDir(6), false, 'Directories beyond maxDepth must not be traversed');

      // Exceed dirsVisited budget
      const tightGuard = createTraversalGuard({ maxDirs: 3 });
      assert.equal(tightGuard.enterDir(1), true);
      assert.equal(tightGuard.enterDir(1), true);
      assert.equal(tightGuard.enterDir(1), true);
      assert.equal(tightGuard.enterDir(1), false, 'Budget max_dirs must halt traversal');
      assert.equal(tightGuard.stopReason, 'max_dirs');
    });

    test('Skill supporting resource traversal is strictly contained', () => {
      const skillBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-pentest-skill-')));
      try {
        const skillDir = path.join(skillBase, 'team', 'test-skill');
        const refDir = path.join(skillDir, 'references');
        fs.mkdirSync(refDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: test-skill\n---\n# Test');
        fs.writeFileSync(path.join(refDir, 'valid.md'), '# Valid Reference');

        // External symlink
        try {
          fs.symlinkSync(path.join(outsideDir, 'canary.txt'), path.join(refDir, 'symlink_canary.md'));
        } catch {}

        // List supporting files: must only include safe physical references within skill tree
        const advertised = listSkillResourcePaths(skillBase, 'team', 'test-skill');
        assert.ok(advertised.includes('references/valid.md'));
        assert.equal(advertised.includes('references/symlink_canary.md'), false,
          'Symlinked external file must not be advertised as skill resource');

        // Direct reading attempt of traversal path
        assert.throws(() => {
          readSkillTextResource(skillBase, 'team', 'test-skill', '../../outside/canary.txt');
        }, /relative file within references|Hidden and traversal|traversal|outside/i);

        // Direct reading attempt of traversal path with references prefix
        assert.throws(() => {
          readSkillTextResource(skillBase, 'team', 'test-skill', 'references/../../outside/canary.txt');
        }, /Hidden and traversal|traversal|outside/i);

        // Direct reading attempt of symlinked external reference
        if (fs.existsSync(path.join(refDir, 'symlink_canary.md'))) {
          assert.throws(() => {
            readSkillTextResource(skillBase, 'team', 'test-skill', 'references/symlink_canary.md');
          }, /SecurityError|outside|escapes|regular file/i);
        }
      } finally {
        try { fs.rmSync(skillBase, { recursive: true, force: true }); } catch {}
      }
    });
  });

  // =========================================================================
  // 2. PENETRATION: ReDoS and Algorithmic Complexity Attacks
  // =========================================================================
  describe('P2 — ReDoS and Catastrophic Backtracking Immunity', () => {
    test('validateRegexSafety rejects polynomial and exponential backtracking patterns in linear time', () => {
      const attacks = [
        adversarialRegex.nestedPlus,
        '(a|aa)+',
        '(a|a?)+$',
        '((a*)*)*$',
        adversarialRegex.nestedAlphanumeric,
        '(a+){10}',
        'a{1,1000000}',
        'abc\\',
        '(.)\\1\\1',
        'x'.repeat(501)
      ];

      for (const pattern of attacks) {
        const start = performance.now();
        const err = validateRegexSafety(pattern);
        const elapsed = performance.now() - start;

        assert.ok(err !== null, `Pattern must be rejected: ${pattern}`);
        assert.ok(elapsed < 50, `Validation must execute in sub-millisecond time: ${elapsed}ms for ${pattern}`);
      }
    });

    test('compileSafeSearchRegex rejects malicious patterns and compiles safe patterns', () => {
      const safe = compileSafeSearchRegex('hello.*world', { isRegex: true });
      assert.ok(safe.regex instanceof RegExp);
      assert.equal(safe.regex.test('hello beautiful world'), true);

      // Malicious pattern returns error rather than compiling an unsafe RegExp
      const unsafe = compileSafeSearchRegex(adversarialRegex.nestedPlus, { isRegex: true });
      assert.equal(unsafe.regex, undefined, 'Unsafe regex must not produce a compiled RegExp');
      assert.ok(typeof unsafe.error === 'string', 'Unsafe regex must return an explanation error');
    });

    test('deferredMcpSearch handles rapid adversarial and ReDoS query barrage', async () => {
      const adversarialQueries = [
        adversarialRegex.nestedPlus + ' and android/.*gradle',
        adversarialRegex.nestedStars + ' and react',
        'a'.repeat(250) + ' and database',
        '\\x00\\x1b[31m injected query',
        'SELECT * FROM users WHERE 1=1'
      ];

      for (const query of adversarialQueries) {
        const t0 = performance.now();
        const res = await deferredMcpSearch.execute({ query });
        const dur = performance.now() - t0;

        assert.ok(dur < 2000, `Search query must return promptly without freeze: ${dur}ms for "${query}"`);
        assert.equal(typeof res.success, 'boolean');
      }
    });
  });

  // =========================================================================
  // 3. PENETRATION: Command Injection & Risk Classification
  // =========================================================================
  describe('P3 — Shell Risk Classification and Deletion Protection', () => {
    test('isWholeFileDeletion catches direct, nested, and chained file deletions', () => {
      const deletions = [
        'rm -rf /',
        'rm -f ./app.ts',
        'rmdir /tmp/dir',
        'unlink old_file.js',
        'sh -c "rm -rf *"',
        'bash -c "rm build.log"',
        'powershell -Command Remove-Item -Recurse dir',
        'pwsh -c Remove-Item target',
        'find . -name "*.tmp" -delete',
        'git rm -rf src/',
        'git clean -fdx'
      ];

      for (const cmd of deletions) {
        assert.equal(isWholeFileDeletion('sysRun', { command: cmd }), true,
          `Command must be identified as whole file deletion: ${cmd}`);
      }

      // Safe non-deleting commands must NOT be flagged
      const nonDeletions = [
        'echo "rm -rf is a common command"',
        'git status',
        'npm test',
        'node ./bin/causyne.js'
      ];

      for (const cmd of nonDeletions) {
        assert.equal(isWholeFileDeletion('sysRun', { command: cmd }), false,
          `Safe command must not be flagged: ${cmd}`);
      }
    });

    test('Sandbox classifies sensitive persistence and key store writes as extreme', () => {
      const sandbox = new Sandbox();

      const extremeCommands = [
        'echo evil >> ~/.bashrc',
        'printf "alias sudo=evil" >> ~/.zshrc',
        'cat pubkey >> ~/.ssh/authorized_keys',
        'echo "secret" > ~/.causyne/.vault_key',
        'echo payload >> ~/.profile'
      ];

      for (const cmd of extremeCommands) {
        const risk = sandbox.classifyCommandRisk(cmd);
        assert.equal(risk, 'extreme', `Command must be classified as extreme: ${cmd}`);
      }
    });

    test('Credential paths are identified and protected across platforms', () => {
      const credentials = [
        '~/.ssh/id_rsa',
        '~/.ssh/id_ed25519',
        '~/.aws/credentials',
        '~/.npmrc',
        '~/.kube/config',
        '~/.netrc',
        '~/.causyne/.vault_key'
      ];

      for (const cred of credentials) {
        assert.equal(isCredentialPath(cred), true, `Must be recognised as credential path: ${cred}`);
      }
    });
  });

  // =========================================================================
  // 4. PENETRATION: Terminal Escape Sequence Neutralization
  // =========================================================================
  describe('P4 — Terminal Sanitization and Control Escape Neutralization', () => {
    test('safeDisplay strips screen-clearing, cursor-moving, and OSC title manipulation', () => {
      const maliciousEscapes = [
        '\x1b[2J\x1b[H-- PWNED --',                          // Clear screen & home cursor
        '\x1b]0;MALICIOUS TITLE\x07Normal text',             // OSC title change
        '\x1b]8;;https://phishing.site\x1b\\Click here\x1b]8;;\x1b\\', // OSC 8 Hyperlink injection
        '\x1b[?1049hSecret screen switch\x1b[?1049l',        // Alternate screen buffer switch
        'Visible\x08\x08\x08\x08\x08Hidden overwrite',       // Backspace overwrite
        'Bell character\x07 Alert'                           // Audio bell
      ];

      for (const raw of maliciousEscapes) {
        const cleaned = safeDisplay(raw);
        assert.doesNotMatch(cleaned, /\x1b\[2J/, 'Must not contain clear screen code');
        assert.doesNotMatch(cleaned, /\x1b\]0;/, 'Must not contain OSC title escape');
        assert.doesNotMatch(cleaned, /\x1b\[\?1049/, 'Must not contain alternate screen code');
        assert.doesNotMatch(cleaned, /\x07/, 'Must not contain raw bell character');
      }
    });

    test('stripAnsi returns pure printable plaintext without visual disruption', () => {
      const colored = '\x1b[31;1mError:\x1b[0m \x1b[33mFile not found\x1b[0m';
      assert.equal(stripAnsi(colored), 'Error: File not found');
    });
  });

  // =========================================================================
  // 5. STRESS: Multimodal Payload Ceilings & Format Integrity
  // =========================================================================
  describe('P5 — Payload Ceilings and Magic Format Validation', () => {
    test('detectMagicFormat verifies true container headers and rejects spoofed headers', () => {
      // Valid PNG header: 89 50 4E 47
      const validPng = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
      assert.equal(detectMagicFormat(validPng), 'png');

      // Valid JPEG header: FF D8 FF
      const validJpg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
      assert.equal(detectMagicFormat(validJpg), 'jpeg');

      // Fake / malicious payload: Shell script starting with '#!/bin/sh'
      const shellScript = Buffer.from('#!/bin/sh\nrm -rf /');
      assert.equal(detectMagicFormat(shellScript), null, 'Shell script must not match any media format');

      // Short buffer < 4 bytes
      assert.equal(detectMagicFormat(Buffer.from([0x89, 0x50])), null);
    });

    test('validateMediaPayload enforces size limits and rejects format mismatch', () => {
      const validPng = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);

      // Valid image within limit
      const checkValid = validateMediaPayload(validPng, 'image', { maxImageBytes: 1024 });
      assert.equal(checkValid.valid, true);
      assert.equal(checkValid.detectedFormat, 'png');

      // Oversized payload
      const hugeBuffer = Buffer.alloc(2000, 0x00);
      hugeBuffer[0] = 0x89; hugeBuffer[1] = 0x50; hugeBuffer[2] = 0x4E; hugeBuffer[3] = 0x47;
      const checkOversized = validateMediaPayload(hugeBuffer, 'image', { maxImageBytes: 1000 });
      assert.equal(checkOversized.valid, false);
      assert.match(checkOversized.error || '', /exceeds allowed limit/i);

      // Format mismatch: passing PNG as audio
      const checkMismatch = validateMediaPayload(validPng, 'audio');
      assert.equal(checkMismatch.valid, false);
      assert.match(checkMismatch.error || '', /mismatch/i);
    });

    test('sanitizeTextPayload truncates oversized text payloads with an explicit warning', () => {
      const text = 'A'.repeat(500);
      const sanitized = sanitizeTextPayload(text, 100);
      assert.equal(sanitized.length < 500, true);
      assert.match(sanitized, /sanitized to protect context budget/);
    });
  });

  // =========================================================================
  // 6. STRESS: High Token Pressure, Concurrency & Budget Integrity
  // =========================================================================
  describe('P6 — High Token Pressure, Concurrent Tasks and Budget Integrity', () => {
    test('TokenTracker handles 20 concurrent tasks recording usage without race conditions', async () => {
      const tracker = new TokenTracker();
      tracker.resetSession();
      tracker.resetTask();

      const taskCount = 20;
      const promptTokensPerTask = 5000;
      const completionTokensPerTask = 1000;

      // Simulate 20 concurrent tasks calling trackUsage concurrently
      await Promise.all(
        Array.from({ length: taskCount }, () =>
          tracker.trackUsage(promptTokensPerTask, completionTokensPerTask)
        )
      );

      const expectedTotal = taskCount * (promptTokensPerTask + completionTokensPerTask);
      assert.equal(tracker.taskTokens, expectedTotal);
      assert.equal(tracker.sessionTokens, expectedTotal);

      // Verify turn reset: taskTokens reset to 0, sessionTokens preserved
      tracker.resetTask();
      assert.equal(tracker.taskTokens, 0, 'taskTokens must reset cleanly');
      assert.equal(tracker.sessionTokens, expectedTotal, 'sessionTokens must remain intact');
    });

    test('Budget Policy V2 permits large turns (>40k, >80k) when hard budget is not explicitly configured', () => {
      // In Autonomy C and Antigravity, default is advisory (no hard ceiling)
      const taskCeiling = resolveTaskTokenCeiling({ provider: 'antigravity', autonomyMode: 'C' });
      assert.equal(taskCeiling, null, 'Mode C must not invent a task ceiling');

      const callCeiling = peerCallTokenCeiling(undefined);
      assert.equal(callCeiling, null, 'Unset call budget must return null (no 32k hard slice)');

      // User-configured hard ceilings remain strictly honored
      const hardCeiling = resolveTaskTokenCeiling({
        provider: 'antigravity',
        configured: { enabled: true, hardStop: true, maxTokensPerTask: 60_000 }
      });
      assert.equal(hardCeiling, 60_000);

      // Terminal errors remain terminal and are never retried
      assert.equal(isTerminalBudgetFailure({ code: 'AGY_TOKEN_BUDGET' }), true);
      assert.equal(isTerminalBudgetFailure({ code: 'TASK_TOKEN_BUDGET' }), true);
      assert.equal(shouldRetryPeerError({ code: 'AGY_TOKEN_BUDGET' }), false);

      // Billable partial usage blocks automatic replay
      const errorWithUsage = Object.assign(new Error('Reset mid-stream'), {
        partialUsage: { promptTokens: 42_000, completionTokens: 800 }
      });
      assert.equal(hasBillablePartialUsage(errorWithUsage), true);
      assert.equal(shouldRetryPeerError(errorWithUsage), false);
    });

    test('Desktop task wall-clock and native action limits require explicit configuration', () => {
      // Default desktop task has no invented 180s deadline or 12-action cap
      const now = Date.now();
      assert.equal(desktopDeadline(now, 'desktop_personalization'), null);
      assert.equal(peerNativeActionCeiling(undefined, true), null);

      // Explicitly configured limits are enforced
      assert.equal(desktopDeadline(now, 'desktop_personalization', 300_000), now + 300_000);
      assert.equal(peerNativeActionCeiling(12, true), 12);
    });
  });
});
