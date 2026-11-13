import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  PluginsFactory,
  assessRoute,
  estimateServiceCosts,
  estimateToolSchemaTokens,
  formatMcpDisclosure,
  findExistingCapability,
  type ServiceDescriptor
} from '../src/pluginsFactory/index.js';
import { pluginsFactoryTool } from '../src/tools/pluginsFactory.js';

test('PluginsFactory: estimateToolSchemaTokens correctly measures schema footprint', () => {
  const emptyTokens = estimateToolSchemaTokens({ type: 'object' });
  assert.ok(emptyTokens >= 15, 'empty schema has baseline token count');

  const detailedSchema = {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'Remote resource target address' },
      retries: { type: 'number', description: 'Maximum retry count' },
      payload: {
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'string' } }
        }
      }
    },
    required: ['url']
  };

  const detailedTokens = estimateToolSchemaTokens(detailedSchema);
  assert.ok(detailedTokens > emptyTokens, 'detailed schema consumes more tokens than empty schema');
});

test('PluginsFactory: estimateServiceCosts calculates lean native footprint vs heavy MCP', () => {
  const service: ServiceDescriptor = {
    name: 'test-api',
    description: 'Test API service',
    serviceKind: 'http_api',
    tools: [
      {
        name: 'query',
        description: 'Run query',
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string' }
          }
        }
      }
    ]
  };

  const comparison = estimateServiceCosts(service);
  assert.ok(comparison.nativePlugin.estimatedSchemaTokens > 0);
  assert.ok(comparison.mcpServer.estimatedSchemaTokens > comparison.nativePlugin.estimatedSchemaTokens);
  assert.ok(comparison.mcpServer.relativeCostMultiplier >= 3.0, 'MCP has at least 3x relative overhead');
  assert.equal(comparison.mcpServer.isLongRunningProcess, true);
  assert.equal(comparison.nativePlugin.isLongRunningProcess, false);

  const disclosure = formatMcpDisclosure('test-api', comparison);
  assert.ok(disclosure.includes('Token Economy Disclosure: test-api'));
  assert.ok(disclosure.includes('Model Context Protocol (MCP) servers incur higher token consumption'));
  assert.ok(disclosure.includes('Causyne will faithfully implement and configure the MCP server'));
});

test('PluginsFactory: route strategy selects lean native plugin for HTTP and CLI services', () => {
  const httpService: ServiceDescriptor = {
    name: 'github-rest',
    description: 'GitHub REST API',
    serviceKind: 'http_api',
    endpoint: 'https://api.github.com',
    tools: [
      {
        name: 'get_repo',
        description: 'Get repository info',
        parameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } } }
      }
    ]
  };

  const httpProposal = assessRoute(httpService);
  assert.equal(httpProposal.recommendedRoute, 'native_plugin');
  assert.equal(httpProposal.userConsentRequired, false);

  const cliService: ServiceDescriptor = {
    name: 'ffmpeg-wrapper',
    description: 'FFmpeg command line wrapper',
    serviceKind: 'cli',
    cliBinary: 'ffmpeg',
    tools: [
      {
        name: 'transcode',
        description: 'Transcode media file',
        parameters: { type: 'object', properties: { input: { type: 'string' }, output: { type: 'string' } } }
      }
    ]
  };

  const cliProposal = assessRoute(cliService);
  assert.equal(cliProposal.recommendedRoute, 'native_plugin');
});

test('PluginsFactory: route strategy selects python_bridge for Python SDK services', () => {
  const pythonService: ServiceDescriptor = {
    name: 'blender-cycles-worker',
    description: 'Blender 3D scene automation',
    serviceKind: 'python_sdk',
    pythonModule: 'bpy',
    tools: [
      {
        name: 'render_scene',
        description: 'Render blender scene',
        parameters: { type: 'object', properties: { blendFile: { type: 'string' } } }
      }
    ]
  };

  const proposal = assessRoute(pythonService);
  assert.equal(proposal.recommendedRoute, 'python_bridge');
  assert.ok(proposal.reason.includes('Python bridge'));
});

test('PluginsFactory: route strategy honors explicit user preference override', () => {
  const service: ServiceDescriptor = {
    name: 'custom-service',
    description: 'Custom service with multiple possibilities',
    serviceKind: 'http_api',
    tools: [
      {
        name: 'fetch_data',
        description: 'Fetch data',
        parameters: { type: 'object', properties: {} }
      }
    ]
  };

  // User explicitly asks for MCP
  const mcpOverrideProposal = assessRoute(service, 'mcp_server');
  assert.equal(mcpOverrideProposal.recommendedRoute, 'mcp_server');
  assert.ok(mcpOverrideProposal.mcpDisclosure, 'includes disclosure when MCP is requested');
  assert.equal(mcpOverrideProposal.userConsentRequired, false, 'no extra consent needed when user explicitly requested it');
  assert.ok(mcpOverrideProposal.reason.includes('Honoring user explicit preference'));
});

test('PluginsFactory: discovery identifies built-in native tools', () => {
  const match = findExistingCapability('web_search');
  assert.equal(match.covered, true);
  assert.equal(match.source, 'native_tool');
  assert.equal(match.matchName, 'web_search');
});

test('PluginsFactory: scaffolds native HTTP plugin into isolated directory with digest and disabled state', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-factory-test-'));

  try {
    const factory = new PluginsFactory({
      pluginsDir: path.join(tmpDir, 'plugins'),
      mcpServersDir: path.join(tmpDir, 'mcp-servers')
    });

    const service: ServiceDescriptor = {
      name: 'weather-feed',
      description: 'Global live weather forecasts',
      serviceKind: 'http_api',
      endpoint: 'https://api.weather.com',
      authType: 'apiKey',
      authEnvVar: 'WEATHER_API_KEY',
      tools: [
        {
          name: 'get_forecast',
          description: 'Get weather forecast for a city',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string', description: 'City name' }
            },
            required: ['city']
          },
          httpMethod: 'GET',
          httpPath: '/v1/forecast'
        }
      ]
    };

    const proposal = factory.assess(service);
    assert.equal(proposal.recommendedRoute, 'native_plugin');

    const result = await factory.scaffold(proposal);
    assert.equal(result.success, true);
    assert.equal(result.route, 'native_plugin');
    assert.ok(result.createdFiles.includes('plugin.json'));
    assert.ok(result.createdFiles.includes('index.js'));
    assert.ok(result.createdFiles.includes('README.md'));
    assert.ok(typeof result.digest === 'string' && result.digest.length === 64, 'SHA-256 hex digest generated');

    const pluginJsonPath = path.join(result.targetDirectory, 'plugin.json');
    assert.ok(fs.existsSync(pluginJsonPath));
    const manifest = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
    assert.equal(manifest.name, 'weather-feed');
    assert.equal(manifest.schemaVersion, 1);
    assert.ok(manifest.capabilities.includes('network'));

    // Verify state.json was created with disabled state
    const statePath = path.join(tmpDir, 'plugins', 'state.json');
    assert.ok(fs.existsSync(statePath));
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.plugins['weather-feed'].enabled, false, 'plugin is created disabled for user security');
    assert.equal(state.plugins['weather-feed'].digest, result.digest);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('PluginsFactory: empty tool lists still produce a loadable plugin', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-factory-empty-'));
  try {
    const factory = new PluginsFactory({
      pluginsDir: path.join(tmpDir, 'plugins'),
      mcpServersDir: path.join(tmpDir, 'mcp-servers')
    });
    const service: ServiceDescriptor = {
      name: 'empty-tools',
      description: 'Service without explicit tools',
      serviceKind: 'http_api',
      tools: []
    };

    const result = await factory.scaffold(factory.assess(service));
    assert.equal(result.success, true);

    const manifest = JSON.parse(fs.readFileSync(path.join(result.targetDirectory, 'plugin.json'), 'utf8'));
    assert.equal(manifest.tools.length, 1);
    assert.equal(manifest.tools[0].export, 'execute');

    const module = await import(`file://${path.join(result.targetDirectory, 'index.js')}`);
    assert.equal(typeof module.execute, 'function');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('PluginsFactory: normalizes service names so manifest, folder, and state agree', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-factory-name-'));
  try {
    const factory = new PluginsFactory({
      pluginsDir: path.join(tmpDir, 'plugins'),
      mcpServersDir: path.join(tmpDir, 'mcp-servers')
    });
    const service: ServiceDescriptor = {
      name: 'Weather-Feed',
      description: 'Weather service',
      serviceKind: 'http_api',
      tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: {} } }]
    };

    const result = await factory.scaffold(factory.assess(service));
    assert.equal(result.success, true);
    assert.equal(path.basename(result.targetDirectory), 'weather-feed');

    const manifest = JSON.parse(fs.readFileSync(path.join(result.targetDirectory, 'plugin.json'), 'utf8'));
    assert.equal(manifest.name, 'weather-feed');

    const state = JSON.parse(fs.readFileSync(path.join(tmpDir, 'plugins', 'state.json'), 'utf8'));
    assert.equal(state.plugins['weather-feed'].enabled, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('PluginsFactory: scaffolds Python bridge with bridge.py and Node subprocess wrapper', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-factory-py-'));

  try {
    const factory = new PluginsFactory({
      pluginsDir: path.join(tmpDir, 'plugins'),
      mcpServersDir: path.join(tmpDir, 'mcp-servers')
    });

    const service: ServiceDescriptor = {
      name: 'resolve-color',
      description: 'DaVinci Resolve color grading bridge',
      serviceKind: 'python_sdk',
      pythonModule: 'DaVinciResolveScript',
      tools: [
        {
          name: 'apply_lut',
          description: 'Apply LUT to current timeline clip',
          parameters: {
            type: 'object',
            properties: {
              lutPath: { type: 'string', description: 'Path to .cube LUT' }
            },
            required: ['lutPath']
          },
          pythonMethod: 'apply_lut'
        }
      ]
    };

    const proposal = factory.assess(service);
    assert.equal(proposal.recommendedRoute, 'python_bridge');

    const result = await factory.scaffold(proposal);
    assert.equal(result.success, true);
    assert.equal(result.route, 'python_bridge');
    assert.ok(result.createdFiles.includes('bridge.py'));
    assert.ok(result.createdFiles.includes('index.js'));
    assert.ok(result.createdFiles.includes('plugin.json'));

    const bridgePyContent = fs.readFileSync(path.join(result.targetDirectory, 'bridge.py'), 'utf8');
    assert.ok(bridgePyContent.includes('#!/usr/bin/env python3'));
    assert.ok(bridgePyContent.includes('DaVinciResolveScript'));
    assert.ok(bridgePyContent.includes('sys.stdin.read()'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('PluginsFactory: scaffolds standalone MCP stdio server when selected', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-factory-mcp-'));

  try {
    const factory = new PluginsFactory({
      pluginsDir: path.join(tmpDir, 'plugins'),
      mcpServersDir: path.join(tmpDir, 'mcp-servers')
    });

    const service: ServiceDescriptor = {
      name: 'sqlite-mcp',
      description: 'SQLite database server via MCP',
      serviceKind: 'mcp_only',
      tools: [
        {
          name: 'read_query',
          description: 'Execute read-only SQL',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } }
          }
        }
      ]
    };

    const proposal = factory.assess(service);
    assert.equal(proposal.recommendedRoute, 'mcp_server');
    assert.equal(proposal.userConsentRequired, true);

    const result = await factory.scaffold(proposal);
    assert.equal(result.success, true);
    assert.equal(result.route, 'mcp_server');
    assert.ok(result.createdFiles.includes('server.js'));
    assert.ok(result.createdFiles.includes('package.json'));

    const serverContent = fs.readFileSync(path.join(result.targetDirectory, 'server.js'), 'utf8');
    assert.ok(serverContent.includes('jsonrpc'));
    assert.ok(serverContent.includes('tools/list'));
    assert.ok(serverContent.includes('tools/call'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('PluginsFactory: path containment prevents writing outside target directory', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-containment-'));

  try {
    const factory = new PluginsFactory({
      pluginsDir: path.join(tmpDir, 'plugins'),
      mcpServersDir: path.join(tmpDir, 'mcp-servers')
    });

    const evilService: ServiceDescriptor = {
      name: '../../etc-passwd',
      description: 'Attempt directory traversal',
      serviceKind: 'http_api',
      tools: []
    };

    const proposal = factory.assess(evilService);
    const result = await factory.scaffold(proposal);
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Invalid service name'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('plugins_factory tool execution: assess and scaffold actions work via tool interface', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-tool-test-'));

  try {
    // 1. Assess action
    const assessResult = await pluginsFactoryTool.execute({
      action: 'assess',
      serviceName: 'mock-weather',
      serviceDescription: 'Mock weather API',
      serviceKind: 'http_api',
      endpoint: 'https://weather.mock.io',
      tools: [
        {
          name: 'get_temp',
          description: 'Get current temperature',
          parameters: { type: 'object', properties: { location: { type: 'string' } } }
        }
      ]
    });

    assert.equal(assessResult.success, true);
    assert.equal(assessResult.action, 'assess');
    assert.ok(assessResult.proposal);
    assert.equal(assessResult.proposal.recommendedRoute, 'native_plugin');

    // 2. Estimate cost action
    const costResult = await pluginsFactoryTool.execute({
      action: 'estimate_cost',
      serviceName: 'mock-weather',
      serviceKind: 'http_api',
      tools: [{ name: 'get_temp', description: 'Get temp' }]
    });

    assert.equal(costResult.success, true);
    assert.ok(costResult.proposal?.costComparison);

    // 3. Dry run scaffold
    const dryRunResult = await pluginsFactoryTool.execute({
      action: 'scaffold',
      serviceName: 'mock-weather',
      serviceKind: 'http_api',
      dryRun: true,
      tools: [{ name: 'get_temp', description: 'Get temp' }]
    });

    assert.equal(dryRunResult.success, true);
    assert.ok(dryRunResult.scaffoldResult?.instructions.includes('[Dry Run]'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

