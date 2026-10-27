import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
  assert.equal(pkg.scripts?.[hook], undefined, `Unexpected lifecycle hook: ${hook}`);
}
assert.equal(pkg.author, undefined, 'Personal author metadata must not be published');
for (const dep of ['bytenode', 'werift', 'ws', 'googlethis', 'duck-duck-scrape', 'inquirer']) {
  assert.equal(pkg.dependencies?.[dep], undefined, `Retired runtime dependency returned: ${dep}`);
}
// npm.cmd is a Windows command shim, and Node 24+ refuses to execute it through
// execFileSync without a shell (EINVAL). npm exposes the JavaScript CLI path to
// lifecycle scripts; invoking that with the current Node binary stays shell-free
// and behaves identically across Windows, macOS, and Linux.
const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : 'npm';
const npmArgs = npmCli
  ? [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts', '--cache', path.join(root, 'node_modules/.cache/npm')]
  : ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', path.join(root, 'node_modules/.cache/npm')];
const pack = JSON.parse(execFileSync(npmCommand, npmArgs, {
  cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  env: {...process.env, npm_config_cache: process.env.npm_config_cache || path.join(root, 'node_modules/.cache/npm')}
}))[0];
const paths = pack.files.map(file => file.path);
const required = ['bin/causyne.js', 'src/entrypoint.js', 'src/tool-scripts/resolve_automator.py', 'SECURITY.md', 'docs/PROVENANCE.md', 'docs/SECURITY_REVIEW.md', 'docs/THIRD_PARTY_NOTICES.md', 'LICENSE'];
for (const file of required) assert.ok(paths.includes(file), `Missing readable release artifact: ${file}`);
const forbidden = /(^|\/)(HOLD|node_modules|\.git|\.env(?:\..*)?|\.wrangler|private|app|build_stage)(\/|$)|\.(jsc|tgz|pem|key|jks|p12)$|(^|\/)(create\.md|install\.(sh|ps1|cmd))$/i;
for (const file of paths) assert.ok(!forbidden.test(file), `Private/retired artifact in package: ${file}`);
assert.ok(paths.every(file => ['bin/', 'src/', 'native-skills/'].some(dir => file.startsWith(dir)) ||
  ['package.json','README.md','SECURITY.md','LICENSE','docs/ARCHITECTURE.md','docs/PROVENANCE.md','docs/SECURITY_REVIEW.md','docs/THIRD_PARTY_NOTICES.md'].includes(file)), 'Unexpected package content');

// Supply-chain scanner anti-obfuscation and false-positive guards:
// 1. No line in distributed code may exceed 1000 characters (anti-obfuscation detector safety).
// 2. No comments or strings may contain naive credential scanner triggers (such as attack examples).
for (const relPath of paths) {
  if (!relPath.endsWith('.js') && !relPath.endsWith('.ts') && !relPath.endsWith('.py')) continue;
  const absPath = path.join(root, relPath);
  if (!fs.existsSync(absPath)) continue;
  const content = fs.readFileSync(absPath, 'utf8');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    assert.ok(lines[i].length < 1000, `Line too long in release artifact ${relPath}:${i + 1} (${lines[i].length} chars). Must remain under 1000 chars to satisfy static analysis readability rules.`);
  }
  assert.ok(!/cat\s+.*>>?\s*.*\.ssh/i.test(content), `Dangerous shell exfiltration trigger pattern in ${relPath}`);
  assert.ok(!/authorized_keys/i.test(content), `Sensitive credential path reference in ${relPath} trips naive static detectors`);
}

console.log(`Source distribution policy passed: ${paths.length} files, ${pack.unpackedSize} unpacked bytes. This is not a vulnerability or secret-clearance certificate.`);
