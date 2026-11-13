import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

import {
  PluginsFactory,
  type ServiceDescriptor
} from '../src/pluginsFactory/index.js';

test('E2E: generated Python bridge actually executes python3 and communicates via JSON stdio', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-pybridge-e2e-'));

  try {
    const factory = new PluginsFactory({
      pluginsDir: path.join(tmpDir, 'plugins'),
      mcpServersDir: path.join(tmpDir, 'mcp-servers')
    });

    const service: ServiceDescriptor = {
      name: 'py-calc-bridge',
      description: 'Python scientific calculation bridge',
      serviceKind: 'python_sdk',
      pythonModule: 'math',
      tools: [
        {
          name: 'compute',
          description: 'Perform calculation',
          parameters: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y']
          },
          pythonMethod: 'compute'
        }
      ]
    };

    const proposal = factory.assess(service);
    assert.equal(proposal.recommendedRoute, 'python_bridge');

    const scaffold = await factory.scaffold(proposal);
    assert.equal(scaffold.success, true);

    const targetDir = scaffold.targetDirectory;
    const bridgePy = path.join(targetDir, 'bridge.py');
    const indexJs = path.join(targetDir, 'index.js');
    assert.ok(fs.existsSync(bridgePy));
    assert.ok(fs.existsSync(indexJs));

    // Test Python script directly via stdin/stdout
    const pyResult = await new Promise<{ success: boolean; result?: unknown }>((resolve, reject) => {
      const child = spawn('python3', [bridgePy], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', chunk => { out += chunk; });
      child.stderr.on('data', chunk => { err += chunk; });
      child.on('close', code => {
        if (code !== 0) reject(new Error(`Python process exited with ${code}: ${err}`));
        else {
          try {
            resolve(JSON.parse(out.trim()));
          } catch (e) {
            reject(e);
          }
        }
      });
      child.stdin.write(JSON.stringify({
        action: 'compute',
        args: { x: 42, y: 100 },
        context: { workspaceRoot: tmpDir }
      }));
      child.stdin.end();
    });

    assert.equal(pyResult.success, true);
    assert.ok(pyResult.result);
    assert.equal((pyResult.result as any).action, 'compute');
    assert.equal((pyResult.result as any).args_echo.x, 42);

    // Test Node wrapper index.js importing and running execute
    const imported = await import(`file://${indexJs}`);
    assert.equal(typeof imported.execute, 'function');
    const wrapperResult = await imported.execute({ x: 10, y: 20 }, { workspaceRoot: tmpDir });
    assert.equal(wrapperResult.success, true);
    assert.equal(wrapperResult.result.action, 'compute');
    assert.equal(wrapperResult.result.args_echo.y, 20);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('E2E: generated MCP stdio server handles JSON-RPC 2.0 handshake, tools/list, and tools/call', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-mcp-e2e-'));

  try {
    const factory = new PluginsFactory({
      pluginsDir: path.join(tmpDir, 'plugins'),
      mcpServersDir: path.join(tmpDir, 'mcp-servers')
    });

    const service: ServiceDescriptor = {
      name: 'metrics-daemon',
      description: 'Metrics daemon via MCP',
      serviceKind: 'mcp_only',
      tools: [
        {
          name: 'get_cpu_load',
          description: 'Get current CPU load',
          parameters: {
            type: 'object',
            properties: { intervalMs: { type: 'number' } }
          }
        }
      ]
    };

    const proposal = factory.assess(service);
    assert.equal(proposal.recommendedRoute, 'mcp_server');

    const scaffold = await factory.scaffold(proposal);
    assert.equal(scaffold.success, true);

    const serverJs = path.join(scaffold.targetDirectory, 'server.js');
    assert.ok(fs.existsSync(serverJs));

    // Spawn server.js and interact via JSON-RPC 2.0
    const child = spawn(process.execPath, [serverJs], { stdio: ['pipe', 'pipe', 'pipe'] });
    const responses: any[] = [];

    child.stdout.on('data', chunk => {
      const lines = chunk.toString().trim().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          try {
            responses.push(JSON.parse(line.trim()));
          } catch {
            // ignore partial
          }
        }
      }
    });

    const waitForResponse = async (id: number, timeoutMs = 3000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const found = responses.find(r => r.id === id);
        if (found) return found;
        await new Promise(r => setTimeout(r, 20));
      }
      return responses.find(r => r.id === id);
    };

    // 1. Initialize
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' }
    }) + '\n');

    // Wait for response 1
    const initRes = await waitForResponse(1);
    assert.ok(initRes, 'received initialize response');
    assert.equal(initRes.result.protocolVersion, '2024-11-05');
    assert.ok(initRes.result.capabilities.tools);

    // 2. tools/list
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    }) + '\n');

    const listRes = await waitForResponse(2);
    assert.ok(listRes, 'received tools/list response');
    assert.equal(listRes.result.tools.length, 1);
    assert.equal(listRes.result.tools[0].name, 'get_cpu_load');

    // 3. tools/call
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_cpu_load', arguments: { intervalMs: 500 } }
    }) + '\n');

    const callRes = await waitForResponse(3);
    assert.ok(callRes, 'received tools/call response');
    assert.ok(callRes.result.content);
    assert.equal(callRes.result.content[0].type, 'text');
    const parsedData = JSON.parse(callRes.result.content[0].text);
    assert.equal(parsedData.tool, 'get_cpu_load');
    assert.equal(parsedData.echo.intervalMs, 500);

    child.kill('SIGTERM');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('E2E: generated Native CLI plugin runs system binary and captures stdout/stderr', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-cli-e2e-'));

  try {
    const factory = new PluginsFactory({
      pluginsDir: path.join(tmpDir, 'plugins'),
      mcpServersDir: path.join(tmpDir, 'mcp-servers')
    });

    const service: ServiceDescriptor = {
      name: 'echo-wrapper',
      description: 'System echo command wrapper',
      serviceKind: 'cli',
      cliBinary: 'node',
      tools: [
        {
          name: 'print_version',
          description: 'Print Node version',
          parameters: { type: 'object', properties: {} },
          cliSubcommand: '-v'
        }
      ]
    };

    const proposal = factory.assess(service);
    assert.equal(proposal.recommendedRoute, 'native_plugin');

    const scaffold = await factory.scaffold(proposal);
    assert.equal(scaffold.success, true);

    const indexJs = path.join(scaffold.targetDirectory, 'index.js');
    const imported = await import(`file://${indexJs}`);
    assert.equal(typeof imported.execute, 'function');

    const runResult = await imported.execute({}, { workspaceRoot: tmpDir });
    assert.equal(runResult.success, true);
    assert.ok(runResult.stdout.startsWith('v'), 'node -v returned version string');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('E2E: colliding sanitized tool names receive unique exports', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-collision-e2e-'));
  try {
    const factory = new PluginsFactory({
      pluginsDir: path.join(tmpDir, 'plugins'),
      mcpServersDir: path.join(tmpDir, 'mcp-servers')
    });
    const service: ServiceDescriptor = {
      name: 'collision-safe',
      description: 'Collision probe',
      serviceKind: 'http_api',
      tools: [
        { name: 'get_item', description: 'Primary tool', parameters: { type: 'object', properties: {} } },
        { name: 'get-user', description: 'Hyphen tool', parameters: { type: 'object', properties: {} } },
        { name: 'get_user', description: 'Underscore tool', parameters: { type: 'object', properties: {} } }
      ]
    };

    const scaffold = await factory.scaffold(factory.assess(service));
    assert.equal(scaffold.success, true);

    const manifest = JSON.parse(fs.readFileSync(path.join(scaffold.targetDirectory, 'plugin.json'), 'utf8'));
    assert.equal(manifest.tools[1].export, 'get_user');
    assert.equal(manifest.tools[2].export, 'get_user_2');

    const module = await import(`file://${path.join(scaffold.targetDirectory, 'index.js')}`);
    assert.equal(typeof module.get_user, 'function');
    assert.equal(typeof module.get_user_2, 'function');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('E2E: reserved-word tool names produce a loadable module', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-reserved-e2e-'));
  try {
    const factory = new PluginsFactory({
      pluginsDir: path.join(tmpDir, 'plugins'),
      mcpServersDir: path.join(tmpDir, 'mcp-servers')
    });
    const service: ServiceDescriptor = {
      name: 'reserved-words',
      description: 'Reserved word export probe',
      serviceKind: 'http_api',
      tools: [
        { name: 'list_items', description: 'Primary tool', parameters: { type: 'object', properties: {} } },
        { name: 'delete', description: 'Delete an item', parameters: { type: 'object', properties: {} } },
        { name: 'default', description: 'Default item', parameters: { type: 'object', properties: {} } }
      ]
    };

    const scaffold = await factory.scaffold(factory.assess(service));
    assert.equal(scaffold.success, true);

    const manifest = JSON.parse(fs.readFileSync(path.join(scaffold.targetDirectory, 'plugin.json'), 'utf8'));
    assert.equal(manifest.tools[1].export, 'delete_');
    assert.equal(manifest.tools[2].export, 'default_');

    const module = await import(`file://${path.join(scaffold.targetDirectory, 'index.js')}`);
    assert.equal(typeof module.delete_, 'function');
    assert.equal(typeof module.default_, 'function');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('E2E: multi-tool plugin with hyphenated tool names exports clean identifiers without syntax error', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-multitool-e2e-'));

  try {
    const factory = new PluginsFactory({
      pluginsDir: path.join(tmpDir, 'plugins'),
      mcpServersDir: path.join(tmpDir, 'mcp-servers')
    });

    const service: ServiceDescriptor = {
      name: 'cloud-monitor',
      description: 'Multi-tool cloud monitoring integration',
      serviceKind: 'http_api',
      tools: [
        {
          name: 'get-cluster-health',
          description: 'Primary tool for checking cluster status',
          parameters: { type: 'object', properties: {} },
          httpMethod: 'GET',
          httpPath: '/health'
        },
        {
          name: 'query-node-metrics',
          description: 'Secondary tool for node performance metrics',
          parameters: { type: 'object', properties: { nodeId: { type: 'string' } } },
          httpMethod: 'POST',
          httpPath: '/metrics'
        }
      ]
    };

    const proposal = factory.assess(service);
    const scaffold = await factory.scaffold(proposal);
    assert.equal(scaffold.success, true);

    const manifestFile = path.join(scaffold.targetDirectory, 'plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

    // Primary tool exported as 'execute', secondary exported as sanitized identifier
    assert.equal(manifest.tools[0].export, 'execute');
    assert.equal(manifest.tools[1].export, 'query_node_metrics');

    // Dynamically import index.js to verify valid JavaScript syntax
    const indexJs = path.join(scaffold.targetDirectory, 'index.js');
    const module = await import(`file://${indexJs}`);
    assert.equal(typeof module.execute, 'function', 'primary execute export exists');
    assert.equal(typeof module.query_node_metrics, 'function', 'sanitized secondary export exists');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
