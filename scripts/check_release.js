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
for (const dep of ['bytenode', 'werift', 'ws']) assert.equal(pkg.dependencies?.[dep], undefined);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const pack = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', path.join(root, 'node_modules/.cache/npm')], {
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
console.log(`Source distribution policy passed: ${paths.length} files, ${pack.unpackedSize} unpacked bytes. This is not a vulnerability or secret-clearance certificate.`);
