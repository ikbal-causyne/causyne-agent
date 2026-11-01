import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sysRun, getEnhancedEnv, SEARCH_COMMAND_PATTERN } from '../src/tools/sysRun.js';
import { detectWorkspaceDomains, readCompiledSkill } from '../src/skillsManager.js';
import { COMPILED_SKILLS } from '../src/compiledSkills.js';

test('getEnhancedEnv discovers Android SDK and injects platform-tools and local binaries into PATH', () => {
  const env = getEnhancedEnv({ PATH: '/usr/bin:/bin' });

  assert.ok(env.PATH, 'PATH must be defined');
  // Local binaries (where Google Android CLI lives)
  assert.ok(env.PATH.includes(path.join(os.homedir(), '.local', 'bin')), 'PATH must include ~/.local/bin');

  // Verify explicit ANDROID_HOME environment injection
  const mockSdk = path.join('/opt', 'mock-android-sdk');
  const envWithSdk = getEnhancedEnv({ PATH: '/usr/bin:/bin', ANDROID_HOME: mockSdk });
  assert.equal(envWithSdk.ANDROID_SDK_ROOT, mockSdk, 'ANDROID_SDK_ROOT must mirror ANDROID_HOME');
  assert.ok(envWithSdk.PATH?.includes(path.join(mockSdk, 'platform-tools')), 'PATH must include platform-tools');
  assert.ok(envWithSdk.PATH?.includes(path.join(mockSdk, 'emulator')), 'PATH must include emulator');

  // If local machine has Android SDK installed, verify automatic environment exposure
  const sdkCandidate = path.join(os.homedir(), 'Library', 'Android', 'sdk');
  if (fs.existsSync(sdkCandidate)) {
    assert.equal(env.ANDROID_HOME, sdkCandidate, 'ANDROID_HOME must be discovered');
    assert.equal(env.ANDROID_SDK_ROOT, sdkCandidate, 'ANDROID_SDK_ROOT must be discovered');
    assert.ok(env.PATH.includes(path.join(sdkCandidate, 'platform-tools')), 'PATH must include platform-tools');
  }
});

test('SEARCH_COMMAND_PATTERN matches process inspection tools pidof and pgrep', () => {
  assert.ok(SEARCH_COMMAND_PATTERN.test('pidof com.wintik.office'), 'must match pidof');
  assert.ok(SEARCH_COMMAND_PATTERN.test('pgrep -f com.wintik.office'), 'must match pgrep');
  assert.ok(SEARCH_COMMAND_PATTERN.test('adb shell pidof com.example'), 'must match adb shell pidof');
});

test('sysRun normalizes process query exit code 1 as zero matches rather than crashing', async () => {
  const cmd = os.platform() === 'win32' ? 'where non_existent_process_12345' : 'pgrep non_existent_process_12345';
  const result = await sysRun.execute({
    command: cmd
  });

  assert.equal(result.success, true, 'zero-match search query must succeed');
  assert.equal(result.exitCode, 1, 'exit code 1 must be preserved');
  assert.ok(result.note?.includes('0 search matches'), 'must carry search note');
});

test('sysRun provides actionable guidance when multiple adb devices are detected', async () => {
  // Simulate adb failing with multiple devices
  const result = await sysRun.execute({
    command: 'echo "adb: more than one device/emulator" >&2 && exit 1'
  });

  assert.equal(result.success, false);
  assert.ok(result.error?.includes('multiple devices/emulators connected'), 'must provide clear guidance for multiple devices');
  assert.ok(result.error?.includes('Pass `-s <serial>`'), 'must explain -s <serial> flag');
});

test('detectWorkspaceDomains discovers Android projects in subdirectories', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-subproject-'));
  try {
    const subApp = path.join(tempDir, 'wintik');
    fs.mkdirSync(subApp, { recursive: true });
    fs.writeFileSync(path.join(subApp, 'build.gradle.kts'), '// android');

    const domains = detectWorkspaceDomains(tempDir);
    assert.ok(domains.includes('android'), 'android domain must be detected in subfolder');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('official Android skills are compiled and readable', () => {
  const androidSkills = COMPILED_SKILLS['android'];
  assert.ok(androidSkills, 'android domain must exist in compiled skills');

  const requiredSkills = [
    'android-cli',
    'android-debugging-and-testing',
    'android-profiler',
    'anr-audit-and-fix',
    'testing-setup',
    'r8-analyzer',
    'agp-9-upgrade'
  ];

  for (const skillName of requiredSkills) {
    assert.ok(androidSkills[skillName], `Skill ${skillName} must be registered`);
    const content = readCompiledSkill('android', skillName);
    assert.ok(content && typeof content === 'string', `Skill ${skillName} must be readable`);
    assert.ok(content.includes('Done when:'), `Skill ${skillName} must include Done when criteria`);
    assert.ok(content.includes('## Verification'), `Skill ${skillName} must include Verification section`);
  }
});
