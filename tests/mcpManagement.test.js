// P5 — MCP server management.
//
// The MCP client was already real and wired: configuredServers() READ
// config.mcpServers, grantServer/revokeServer managed consent, resolveMcpTool
// dispatched calls. But nothing in the codebase ever WROTE config.mcpServers, so
// there was no way to add a server at all. These cover the missing half — and,
// more importantly, the consent boundary around it: a stdio MCP server is a
// program Causyne spawns on the user's machine.

import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const SANDBOX_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-mcpmgmt-')));
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;
// CAUSYNE_HOME is what every store reads now; hijacking HOME redirected
// os.homedir() for the whole process and still missed the state root.
process.env.CAUSYNE_HOME = path.join(SANDBOX_HOME, '.causyne');

const {
  addServer,
  removeServer,
  grantServer,
  revokeServer,
  isServerGranted,
  configuredServers,
  serverStatus
} = await import('../src/mcp/mcpRegistry.js');
const { runCommand } = await import('../src/commands.js');
const { loadConfig, saveConfig } = await import('../src/config.js');

beforeEach(() => {
  const config = loadConfig();
  config.mcpServers = [];
  config.mcpConsent = {};
  saveConfig(config);
});

after(() => {
  process.env.HOME = REAL_HOME;
  process.env.USERPROFILE = REAL_USERPROFILE;
  try { fs.rmSync(SANDBOX_HOME, { recursive: true, force: true }); } catch (e) {}
});

describe('registering a server', () => {
  test('a stdio server round-trips through config', () => {
    const result = addServer({ name: 'fsvr', command: 'npx', args: ['-y', '@scope/server-fs', '/tmp'] });
    assert.equal(result.ok, true);

    const stored = configuredServers().find(s => s.name === 'fsvr');
    assert.ok(stored, 'the server must survive into config');
    assert.equal(stored.command, 'npx');
    assert.deepEqual(stored.args, ['-y', '@scope/server-fs', '/tmp']);
  });

  test('an http server round-trips', () => {
    assert.equal(addServer({ name: 'remote', url: 'https://example.test/mcp' }).ok, true);
    const stored = configuredServers().find(s => s.name === 'remote');
    assert.equal(stored.url, 'https://example.test/mcp');
  });

  test('a new server is NOT granted', () => {
    // The whole point of the boundary: registering is not consenting. A stdio
    // server is arbitrary local code execution.
    addServer({ name: 'pending', command: 'node', args: ['server.js'] });
    assert.equal(isServerGranted('pending'), false);
  });

  test('an invalid definition is refused with a reason', () => {
    assert.equal(addServer({ name: 'bad name!', command: 'x' }).ok, false);
    assert.equal(addServer({ name: 'both', command: 'x', url: 'https://y.test' }).ok, false);
    assert.equal(addServer({ name: 'neither' }).ok, false);
    assert.equal(addServer(null).ok, false);
  });

  test('a duplicate name is refused rather than silently overwriting', () => {
    addServer({ name: 'dup', command: 'a' });
    const second = addServer({ name: 'dup', command: 'b' });
    assert.equal(second.ok, false);
    assert.match(second.error, /already configured/);
    assert.equal(configuredServers().filter(s => s.name === 'dup').length, 1);
  });

  test('only fields the client reads are persisted', () => {
    addServer({
      name: 'trim', command: 'node', args: ['x.js'],
      // A caller — including the phone — must not be able to smuggle arbitrary
      // keys into the user's config file.
      somethingElse: 'dropped', __proto__hack: 'dropped'
    });
    const stored = configuredServers().find(s => s.name === 'trim');
    assert.deepEqual(Object.keys(stored).sort(), ['args', 'command', 'name']);
  });
});

describe('removing a server', () => {
  test('removal drops the definition and its consent', () => {
    addServer({ name: 'temp', command: 'node' });
    grantServer('temp');
    assert.equal(isServerGranted('temp'), true);

    assert.equal(removeServer('temp').ok, true);
    assert.equal(configuredServers().some(s => s.name === 'temp'), false);
    assert.equal(isServerGranted('temp'), false, 'stale consent must not outlive the server');
  });

  test('removing something that is not there reports instead of throwing', () => {
    const result = removeServer('ghost');
    assert.equal(result.ok, false);
    assert.match(result.error, /no server named/);
  });

  test('a re-added name does not inherit the old consent', () => {
    addServer({ name: 'recycled', command: 'node' });
    grantServer('recycled');
    removeServer('recycled');
    addServer({ name: 'recycled', command: 'node' });
    assert.equal(isServerGranted('recycled'), false, 'consent must be re-earned');
  });
});

describe('the listing tells you what you are consenting to', () => {
  test('a stdio target shows the full invocation, not just the binary', () => {
    // "npx" alone tells a user nothing about what they are about to run.
    addServer({ name: 'full', command: 'npx', args: ['-y', '@scope/server-fs', '/tmp'] });
    const entry = serverStatus().find(s => s.name === 'full');
    assert.equal(entry.target, 'npx -y @scope/server-fs /tmp');
    assert.equal(entry.transport, 'stdio');
    assert.equal(entry.granted, false);
  });
});

describe('/mcp drives the whole lifecycle', () => {
  const mcp = (...argv) => runCommand('mcp', argv, { surface: 'terminal' });

  test('add, list, grant, revoke, remove', async () => {
    const added = await mcp('add', 'demo', 'npx', '-y', '@scope/x');
    assert.equal(added.ok, true);
    assert.match(added.output, /NOT enabled yet/, 'the user must be told it is inert');

    const listed = await mcp();
    assert.match(listed.output, /demo/);
    assert.match(listed.output, /NOT granted/);

    assert.equal((await mcp('grant', 'demo')).ok, true);
    assert.match((await mcp()).output, /granted/);

    assert.equal((await mcp('revoke', 'demo')).ok, true);
    assert.equal(isServerGranted('demo'), false);

    assert.equal((await mcp('remove', 'demo')).ok, true);
    assert.match((await mcp()).output, /No MCP servers are configured/);
  });

  test('--url adds an http server', async () => {
    assert.equal((await mcp('add', 'http1', '--url', 'https://example.test/mcp')).ok, true);
    assert.equal(configuredServers().find(s => s.name === 'http1').url, 'https://example.test/mcp');
  });

  test('foreign flags survive into args', async () => {
    // `npx -y …` is an ordinary MCP invocation; -y belongs to npx, not to us.
    await mcp('add', 'flags', 'npx', '-y', '--silent', '@scope/x');
    assert.deepEqual(configuredServers().find(s => s.name === 'flags').args, ['-y', '--silent', '@scope/x']);
  });

  test('incomplete input is explained, not guessed at', async () => {
    assert.equal((await mcp('add')).ok, false);
    assert.equal((await mcp('add', 'lonely')).ok, false);
    assert.equal((await mcp('add', 'nourl', '--url')).ok, false);
    assert.equal((await mcp('remove')).ok, false);
    assert.equal((await mcp('wat')).ok, false);
  });

  test('granting a server that was never added is refused', async () => {
    const result = await mcp('grant', 'never-added');
    assert.equal(result.ok, false);
    assert.match(result.output, /No MCP server named/);
  });
});

describe('the consent boundary is audited', () => {
  test('add, grant, revoke and remove all reach the audit log', () => {
    const source = fs.readFileSync(
      new URL('../src/mcp/mcpRegistry.js', import.meta.url), 'utf8'
    );
    for (const event of ['mcp_server_added', 'mcp_server_granted', 'mcp_server_revoked', 'mcp_server_removed']) {
      assert.ok(source.includes(event), `${event} must be recorded for post-hoc review`);
    }
  });
});
