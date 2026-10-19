// Phase 13 — the MCP client, driven against a real server over real stdio.
//
// The security boundary is the point of these tests. A client that launches
// third-party processes is the highest-risk pattern in this codebase, and the
// rule that keeps it safe is narrow enough to state in one line: a server
// command comes from user config and from nowhere else. The model may ask for a
// configured server to be enabled; it may never name one.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = path.join(__dirname, 'helpers', 'mockMcpServer.js');

// Redirect HOME before importing anything under src/: config.js resolves its
// paths at import time.
const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-mcp-')));
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
// CAUSYNE_HOME is what every store reads now; hijacking HOME redirected
// os.homedir() for the whole process and still missed the state root.
process.env.CAUSYNE_HOME = path.join(SANDBOX, '.causyne');
fs.mkdirSync(path.join(SANDBOX, '.causyne'), { recursive: true, mode: 0o700 });

function writeConfig(extra = {}) {
  fs.writeFileSync(path.join(SANDBOX, '.causyne', 'config.json'), JSON.stringify({
    provider: 'openai', model: 'x', autonomyMode: 'C', tier: 'max', ...extra
  }, null, 2));
}

writeConfig({
  mcpServers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }]
});

const mcp = await import('../src/mcp/mcpRegistry.js');
const { McpClient } = await import('../src/mcp/mcpClient.js');
const registry = await import('../src/tools/registry.js');

after(() => {
  mcp.closeAll();
  process.env.HOME = REAL_HOME;
  if (REAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = REAL_USERPROFILE;
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
});

describe('MCP: the server list is user config, never model output', () => {
  test('a definition must name exactly one transport', () => {
    assert.strictEqual(McpClient.validateDefinition({ name: 'a', command: 'node' }), null);
    assert.strictEqual(McpClient.validateDefinition({ name: 'a', url: 'http://x' }), null);
    assert.match(McpClient.validateDefinition({ name: 'a' }), /exactly one/);
    assert.match(McpClient.validateDefinition({ name: 'a', command: 'node', url: 'http://x' }), /exactly one/);
  });

  test('a malformed server name is rejected outright', () => {
    for (const name of ['', 'has space', 'semi;colon', '../escape', 'x'.repeat(49)]) {
      assert.ok(McpClient.validateDefinition({ name, command: 'node' }),
        `"${name}" must not be accepted as a server name`);
    }
  });

  test('an unconfigured server cannot be resolved, granted or launched', () => {
    // This is the whole boundary: the model may emit any tool name it likes.
    assert.strictEqual(mcp.resolveMcpTool('mcp__attacker__anything'), null);
    assert.strictEqual(registry.resolveTool('mcp__attacker__anything'), null);
  });

  test('an invalid entry in config is dropped rather than trusted', () => {
    writeConfig({ mcpServers: [
      { name: 'mock', command: process.execPath, args: [MOCK_SERVER] },
      { name: 'broken' },
      { name: 'bad name!', command: 'node' }
    ] });
    const names = mcp.configuredServers().map(s => s.name);
    assert.deepStrictEqual(names, ['mock']);
    writeConfig({ mcpServers: [{ name: 'mock', command: process.execPath, args: [MOCK_SERVER] }] });
  });
});

describe('MCP: consent gates the connection', () => {
  test('a configured but un-granted server exposes no tools and refuses to run', async () => {
    assert.strictEqual(mcp.isServerGranted('mock'), false);
    assert.deepStrictEqual(await mcp.discoverTools(), [],
      'an un-granted server must not put schemas in front of the model');

    const tool = mcp.resolveMcpTool('mcp__mock__echo');
    assert.ok(tool, 'the tool resolves, so the model gets a real answer');
    const result = await tool.execute({ text: 'hi' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.requiresConsent, true);
    assert.match(result.error, /not enabled/);
  });

  test('granting connects, lists real tools, and drops malformed advertisements', async () => {
    mcp.grantServer('mock');
    const client = await mcp.connectServer('mock');
    assert.strictEqual(client.serverInfo.name, 'mock-mcp');
    assert.deepStrictEqual(client.tools.map(t => t.name), ['echo'],
      'the nameless tool the server advertised must not reach the catalogue');
  });

  test('discovered tools are namespaced so they cannot shadow a native tool', async () => {
    const discovered = await mcp.discoverTools();
    assert.deepStrictEqual(discovered.map(t => t.name), ['mcp__mock__echo']);
    assert.match(discovered[0].description, /^\[MCP: mock\]/);

    const catalogue = await registry.getDynamicTools('C', true, { grantAllTools: true });
    const names = catalogue.map(t => t.name);
    assert.ok(names.includes('mcp__mock__echo'), 'the MCP tool joins the catalogue');
    assert.ok(names.includes('fs_read'), 'and native tools are untouched');
    // Every MCP name is prefixed, so a collision is structurally impossible.
    assert.strictEqual(names.filter(n => n.startsWith('mcp__')).length, 1);
  });

  test('a granted tool executes for real through the registry', async () => {
    const tool = registry.resolveTool('mcp__mock__echo');
    assert.ok(tool, 'the registry must dispatch namespaced MCP names');
    const result = await tool.execute({ text: 'hello over stdio' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output, 'echo: hello over stdio');
  });

  test('a server-side error is reported as an error, not as output', async () => {
    const client = await mcp.connectServer('mock');
    const result = await client.callTool('does_not_exist', {});
    assert.strictEqual(result.success, false);
    assert.match(result.error, /no such tool/);
  });

  test('revoking closes the connection and withdraws the tools', async () => {
    mcp.revokeServer('mock');
    assert.strictEqual(mcp.isServerGranted('mock'), false);
    assert.deepStrictEqual(await mcp.discoverTools(), []);
  });
});

describe('MCP: a broken server degrades, it does not break the agent', () => {
  test('an unlaunchable server is skipped and the catalogue still builds', async () => {
    writeConfig({ mcpServers: [
      { name: 'mock', command: process.execPath, args: [MOCK_SERVER] },
      { name: 'ghost', command: path.join(SANDBOX, 'no-such-binary-anywhere') }
    ] });
    mcp.grantServer('mock');
    mcp.grantServer('ghost');

    const discovered = await mcp.discoverTools();
    assert.deepStrictEqual(discovered.map(t => t.name), ['mcp__mock__echo'],
      'the working server still contributes its tools');

    const catalogue = await registry.getDynamicTools('C', true, { grantAllTools: true });
    assert.ok(catalogue.length > 60, 'the native catalogue is unaffected');
  });
});
