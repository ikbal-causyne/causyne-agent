import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installShPath = path.join(repoRoot, 'install', 'install.sh');
const installPs1Path = path.join(repoRoot, 'install', 'install.ps1');

describe('Automated cross-platform installers (macOS, Linux, Windows)', () => {
  it('install.sh passes bash syntax validation and executes cleanly in an isolated HOME without corrupting symlinks', { skip: process.platform === 'win32' }, () => {
    execFileSync('bash', ['-n', installShPath], { stdio: 'pipe' });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-installer-test-'));
    try {
      const fakeHome = path.join(tmpDir, 'home');
      const mockBin = path.join(tmpDir, 'mock-bin');
      const localBin = path.join(fakeHome, '.local', 'bin');
      fs.mkdirSync(fakeHome, { recursive: true });
      fs.mkdirSync(mockBin, { recursive: true });
      fs.mkdirSync(localBin, { recursive: true });

      // Simulate an existing symlink at ~/.local/bin/causyne pointing to an external file
      // to verify install.sh removes the symlink before writing the wrapper.
      const externalTarget = path.join(tmpDir, 'external-causyne.js');
      fs.writeFileSync(externalTarget, 'ORIGINAL_UNTOUCHED_CONTENT\n', 'utf8');
      fs.symlinkSync(externalTarget, path.join(localBin, 'causyne'));

      // Create a mock npm in mockBin that creates a fake installed @causyne/agent package
      const mockNpmPath = path.join(mockBin, 'npm');
      fs.writeFileSync(
        mockNpmPath,
        [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          'PREFIX=""',
          'while [ $# -gt 0 ]; do',
          '  if [ "$1" = "--prefix" ]; then',
          '    PREFIX="$2"',
          '    shift 2',
          '  else',
          '    shift',
          '  fi',
          'done',
          'mkdir -p "$PREFIX/lib/node_modules/@causyne/agent/bin"',
          'cat > "$PREFIX/lib/node_modules/@causyne/agent/bin/causyne.js" <<\'EOF\'',
          'if (process.argv.includes("--version")) {',
          '  console.log("1.20.12");',
          '} else if (process.argv.includes("--env-check")) {',
          '  console.log(JSON.stringify({ root: process.env.CAUSYNE_INSTALL_ROOT, npm: process.env.CAUSYNE_NPM_COMMAND }));',
          '}',
          'EOF',
        ].join('\n'),
        { mode: 0o755 }
      );

      // Symlink current node (which is >= 24) into mockBin
      fs.symlinkSync(process.execPath, path.join(mockBin, 'node'));

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: fakeHome,
        SHELL: '/bin/zsh',
        PATH: `${mockBin}:/usr/bin:/bin`,
      };

      const output = execFileSync('bash', [installShPath], {
        env,
        encoding: 'utf8',
      });

      assert.match(output, /Causyne Agent 1\.20\.12/);

      // Verify the pre-existing symlink target was NEVER overwritten
      assert.equal(
        fs.readFileSync(externalTarget, 'utf8'),
        'ORIGINAL_UNTOUCHED_CONTENT\n',
        'Existing symlink target must not be overwritten by wrapper generation'
      );

      // Verify both `causyne` and `causyne-agent` binaries work
      const ver1 = execFileSync(path.join(localBin, 'causyne'), ['--version'], {
        env,
        encoding: 'utf8',
      }).trim();
      const ver2 = execFileSync(path.join(localBin, 'causyne-agent'), ['--version'], {
        env,
        encoding: 'utf8',
      }).trim();
      assert.equal(ver1, '1.20.12');
      assert.equal(ver2, '1.20.12');

      const envCheckRaw = execFileSync(path.join(localBin, 'causyne'), ['--env-check'], {
        env,
        encoding: 'utf8',
      }).trim();
      const envCheck = JSON.parse(envCheckRaw) as { root: string; npm: string };
      assert.equal(envCheck.root, path.join(fakeHome, '.causyne', 'installation'));
      assert.equal(envCheck.npm, 'npm');

      // Verify shell profiles were updated idempotently
      const zshrc = fs.readFileSync(path.join(fakeHome, '.zshrc'), 'utf8');
      const zprofile = fs.readFileSync(path.join(fakeHome, '.zprofile'), 'utf8');
      assert.match(zshrc, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
      assert.match(zprofile, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);

      // Re-running installer must not duplicate PATH lines in .zshrc
      execFileSync('bash', [installShPath], { env, encoding: 'utf8' });
      const zshrcAfterSecondRun = fs.readFileSync(path.join(fakeHome, '.zshrc'), 'utf8');
      const matches = zshrcAfterSecondRun.match(/export PATH="\$HOME\/\.local\/bin:\$PATH"/g) ?? [];
      assert.equal(matches.length, 1, 'PATH export should only appear once after repeated installs');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('install.ps1 includes self-contained Node.js 24+ portable runtime bootstrap and safe wrapper generation', () => {
    const ps1 = fs.readFileSync(installPs1Path, 'utf8').replace(/\r\n?/g, '\n');
    assert.match(ps1, /Install-PrivateNode/);
    assert.match(ps1, /SHASUMS256\.txt/);
    assert.match(ps1, /Get-FileHash\s+-Path\s+\$zipPath\s+-Algorithm\s+SHA256/);
    assert.match(ps1, /Expand-Archive/);
    assert.match(ps1, /\$ProgressPreference\s*=\s*'SilentlyContinue'/);
    assert.match(ps1, /\$ErrorActionPreference\s*=\s*'Continue'/);
    assert.match(ps1, /causyne\.cmd/);
    assert.match(ps1, /causyne-agent\.cmd/);
  });

  it('website public/install.sh and public/install.ps1 stay synchronized when parent public directory is present', () => {
    const publicDir = path.resolve(repoRoot, '..', 'public');
    const pubSh = path.join(publicDir, 'install.sh');
    const pubPs1 = path.join(publicDir, 'install.ps1');
    if (fs.existsSync(pubSh) && fs.existsSync(pubPs1)) {
      assert.equal(
        fs.readFileSync(pubSh, 'utf8').replace(/\r\n?/g, '\n'),
        fs.readFileSync(installShPath, 'utf8').replace(/\r\n?/g, '\n'),
        'public/install.sh must match causyne-agent/install/install.sh'
      );
      assert.equal(
        fs.readFileSync(pubPs1, 'utf8').replace(/\r\n?/g, '\n'),
        fs.readFileSync(installPs1Path, 'utf8').replace(/\r\n?/g, '\n'),
        'public/install.ps1 must match causyne-agent/install/install.ps1'
      );
    }
  });
});

