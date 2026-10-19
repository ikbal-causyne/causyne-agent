import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = process.platform === 'win32' ? 'git.exe' : 'git';

const output = execFileSync(
  git,
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
);
// `git ls-files --cached` still reports a tracked path after it has been
// deleted from the worktree. A release scan must inspect the tree that will be
// committed, not crash while trying to stat a file whose deletion is pending.
const files = output.split('\0').filter(Boolean)
  .filter(file => fs.existsSync(path.join(root, file)))
  .sort();

const forbiddenDocuments = new Set([
  'AGENTS.md',
  '.agents/AGENTS.md',
  '.agents/rules.json',
  'docs/HANDOFF.md',
  'docs/LICENSING_AND_BUSINESS.md',
  'docs/LOCAL_GUI_DESIGN.md',
  'docs/REPUTATION_REMEDIATION.md',
  'docs/RELEASING.md',
  'docs/VALIDATION.md'
]);

const forbiddenPath = /(^|\/)(HOLD|private|\.wrangler|\.causyne|\.vanexa)(\/|$)|(^|\/)(create\.md|key\.properties|google-services\.json|credentials(?:\.[^/]*)?\.json|\.npmrc)$|\.(?:pem|key|p12|jks|keystore|tgz|jsc)$/i;
const privateDocName = /^docs\/[^/]*(?:handoff|mastery|vision|prompt|private|releas(?:e|ing)|ai[-_ ]?workflow|you make a mistake)[^/]*\.md$/i;

for (const file of files) {
  assert.ok(!forbiddenDocuments.has(file), `Private AI/owner document is a public Git candidate: ${file}`);
  assert.ok(!privateDocName.test(file), `Private operational document is a public Git candidate: ${file}`);
  assert.ok(!forbiddenPath.test(file), `Sensitive or private path is a public Git candidate: ${file}`);
}

const secretPatterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{20,}\b/],
  ['Cloudflare token', /\bcfat_[A-Za-z0-9_-]{20,}\b/],
  ['live Stripe secret', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/],
  ['credential in URL', /https?:\/\/[^\s/:]+:[^\s/@]+@/]
];

const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
const licensor = license.match(/^Licensor:\s+(.+)$/m)?.[1]?.trim();
assert.ok(licensor, 'LICENSE must identify the licensor');
const escapedLicensor = licensor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapedHome = os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const privacyPatterns = [
  ['local home path', new RegExp(escapedHome, 'i')],
  ['personal email address', /\b[A-Z0-9._%+-]+@gmail\.com\b/i],
  ['licensor name outside legal attribution', new RegExp(`\\b${escapedLicensor}\\b`, 'i')]
];

for (const file of files) {
  const absolute = path.join(root, file);
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024) continue;
  const buffer = fs.readFileSync(absolute);
  if (buffer.includes(0)) continue;
  const text = buffer.toString('utf8');
  for (const [label, pattern] of secretPatterns) {
    assert.ok(!pattern.test(text), `${label} candidate found in ${file}`);
  }
  if (file !== 'LICENSE') {
    for (const [label, pattern] of privacyPatterns) {
      assert.ok(!pattern.test(text), `${label} found in public candidate ${file}`);
    }
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(pkg.name, '@causyne/agent', 'Unexpected public npm package identity');
assert.equal(pkg.private, false, 'The approved public package must not be npm-private');
assert.equal(pkg.repository?.url, 'git+https://github.com/ikbal-causyne/causyne-agent.git', 'Unexpected source repository metadata');
assert.equal(pkg.author, undefined, 'Do not publish personal author promotion in package metadata');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
assert.match(readme, /under active development/i);
assert.match(readme, /https:\/\/causyne\.com\//i);
assert.doesNotMatch(readme, /\b(?:Claude Code|OpenClaw|Hermes Agent|OpenHands|Codex)\b/i, 'README must position Causyne in its own voice');

for (const workflowName of ['ci.yml', 'release.yml']) {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows', workflowName), 'utf8');
  const actionRefs = [...workflow.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)$/gm)].map(match => match[1]);
  assert.ok(actionRefs.length > 0, `${workflowName} must use at least one pinned action`);
  assert.ok(actionRefs.every(ref => /^[a-f0-9]{40}$/.test(ref)), `${workflowName} contains an action that is not pinned to a commit SHA`);
  assert.doesNotMatch(workflow, /secrets\.NPM_TOKEN|NODE_AUTH_TOKEN\s*:/, `${workflowName} must not use a long-lived npm publish token`);
}

const releaseWorkflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
assert.match(releaseWorkflow, /^\s{2}workflow_dispatch:\s*$/m);
assert.doesNotMatch(releaseWorkflow, /^\s{2}(?:push|pull_request):\s*$/m, 'Release workflow must not publish from push or pull_request events');
assert.match(releaseWorkflow, /^\s{2}contents:\s*read\s*$/m);
assert.match(releaseWorkflow, /^\s{6}id-token:\s*write\s*$/m);
assert.match(releaseWorkflow, /^\s{4}environment:\s*npm-release\s*$/m);
assert.match(releaseWorkflow, /^\s{4}needs:\s*validate\s*$/m, 'Publishing must wait for the release validation matrix');
for (const osName of ['ubuntu-latest', 'macos-latest', 'windows-latest']) {
  assert.match(releaseWorkflow, new RegExp(`\\b${osName}\\b`), `Release validation must include ${osName}`);
}
assert.match(releaseWorkflow, /npm publish[^\n]+--provenance/, 'npm publication must emit GitHub Actions provenance');

console.log(`Public-source policy passed for ${files.length} Git candidates. High-confidence scanning found no credential or private-data candidate.`);
