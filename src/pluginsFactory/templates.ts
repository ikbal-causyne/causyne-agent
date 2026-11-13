/**
 * Code and Manifest Templates for PluginsFactory.
 *
 * Scaffolds production-grade, secure implementations for:
 * 1. Native HTTP Plugin (Leanest, zero daemon overhead, full query param support)
 * 2. Native CLI Plugin (Subprocess wrapper with robust stderr reporting)
 * 3. Python Bridge Plugin (Lightweight JSON stdio bridge for Python libraries)
 * 4. Stdio MCP Server (Zero-dependency JSON-RPC 2.0 stdio daemon compliant with MCP spec)
 */

import type { ServiceDescriptor, ServiceToolDescriptor } from './types.js';

export interface ScaffoldingPayload {
  files: Array<{ relativePath: string; content: string }>;
  entryPoint: string;
}

/**
 * Words that cannot be used as a generated export binding. Modules are always
 * strict, so `delete`, `default`, `eval`, `arguments`, and friends would make
 * the generated module fail to parse.
 */
const RESERVED_IDENTIFIERS = new Set([
  'arguments', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'debugger', 'default', 'delete', 'do', 'else', 'enum', 'eval', 'export',
  'extends', 'false', 'finally', 'for', 'function', 'if', 'implements',
  'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package',
  'private', 'protected', 'public', 'return', 'static', 'super', 'switch',
  'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
  'yield'
]);

/**
 * Quotes a value for safe display inside a POSIX shell command line.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Sanitizes an arbitrary tool or parameter name into a valid JavaScript identifier.
 * Prevents syntax errors when tools contain hyphens (e.g. "get-weather" -> "get_weather").
 */
export function sanitizeIdentifier(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, '_');
  const identifier = /^[0-9]/.test(cleaned) ? `_${cleaned}` : (cleaned || 'fn');
  return RESERVED_IDENTIFIERS.has(identifier) ? `${identifier}_` : identifier;
}

/**
 * Keeps user-supplied text inside a generated comment. A description that
 * contains a comment terminator would otherwise escape the docblock and run
 * as generated JavaScript.
 */
export function sanitizeComment(text: string): string {
  return String(text ?? '')
    .replace(/\*\//g, '*\\/')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
}

/**
 * Keeps user-supplied text inert inside generated Python comments and
 * docstrings. Newlines would start a new statement, a triple quote would end
 * the docstring early, and a trailing backslash would escape its delimiter.
 */
export function sanitizePythonText(text: string): string {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"""/g, "'''")
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
}

/**
 * Computes canonical export names for every tool in a module.
 * The primary tool is always exported as "execute" (the default runner
 * contract). Additional tools receive sanitized identifiers, disambiguated
 * when two tool names collapse to the same binding (e.g. "get-user" and
 * "get_user").
 */
function buildExportNames(tools: ServiceToolDescriptor[]): string[] {
  const used = new Set<string>(['execute']);
  return tools.map((tool, index) => {
    if (index === 0) return 'execute';
    const base = sanitizeIdentifier(tool.name);
    let name = base;
    let suffix = 2;
    while (used.has(name)) name = `${base}_${suffix++}`;
    used.add(name);
    return name;
  });
}

/**
 * Generates scaffold files for a Native HTTP Plugin.
 */
export function generateHttpPluginScaffold(service: ServiceDescriptor): ScaffoldingPayload {
  const capabilities = Array.from(new Set(['network', ...(service.capabilities || [])]));
  const effectiveTools: ServiceToolDescriptor[] = service.tools.length > 0 ? service.tools : [{
    name: 'query',
    description: `Execute request against ${service.name}`,
    parameters: { type: 'object', properties: {} }
  }];
  const exportNames = buildExportNames(effectiveTools);

  const manifest = {
    schemaVersion: 1,
    name: service.name,
    version: '1.0.0',
    description: service.description || `Native HTTP plugin for ${service.name}`,
    capabilities,
    tools: effectiveTools.map((tool, idx) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      entry: 'index.js',
      export: exportNames[idx],
      timeoutMs: 30000
    }))
  };

  const toolExecutors = effectiveTools.map((tool, idx) => {
    const fnName = exportNames[idx];
    const httpMethod = tool.httpMethod || 'POST';
    const httpPath = tool.httpPath || '/';
    return `
/**
 * ${sanitizeComment(tool.description)}
 */
export async function ${fnName}(args = {}, context = {}) {
  const endpoint = ${JSON.stringify(service.endpoint || 'https://api.example.com')};
  const base = endpoint.endsWith('/') ? endpoint : endpoint + '/';
  const rel = ${JSON.stringify(httpPath)}.startsWith('/') ? ${JSON.stringify(httpPath)}.slice(1) : ${JSON.stringify(httpPath)};
  const url = new URL(rel, base);

  if (${JSON.stringify(httpMethod)} === 'GET' && args && typeof args === 'object') {
    for (const [k, v] of Object.entries(args)) {
      if (v !== undefined && v !== null) url.searchParams.append(k, String(v));
    }
  }

  const authHeader = ${
    service.authEnvVar
      ? `process.env[${JSON.stringify(service.authEnvVar)}] ? \`Bearer \${process.env[${JSON.stringify(service.authEnvVar)}]}\` : undefined`
      : 'undefined'
  };

  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
  if (authHeader) headers['Authorization'] = authHeader;

  try {
    const response = await fetch(url.toString(), {
      method: ${JSON.stringify(httpMethod)},
      headers,
      body: ${httpMethod !== 'GET' ? 'JSON.stringify(args)' : 'undefined'}
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        status: response.status,
        error: \`HTTP \${response.status}: \${errorText.slice(0, 500)}\`
      };
    }

    const data = await response.json().catch(() => ({}));
    return {
      success: true,
      data
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
`;
  }).join('\n');

  const indexJs = `// Native HTTP plugin for ${service.name}
// Auto-generated by Causyne PluginsFactory

${toolExecutors}
`;

  const readmeMd = `# ${service.name} Plugin

${service.description}

## Route Information
- **Kind**: Native HTTP Plugin (Token-lean, on-demand execution)
- **Capabilities Required**: \`${capabilities.join(', ')}\`
${service.authEnvVar ? `- **Environment Variable**: Set \`${service.authEnvVar}\` for authentication.` : ''}

## Security & Activation
By default, this plugin is created in a **disabled** state to allow code review.
To activate after reviewing the code:
\`\`\`bash
/plugins enable ${service.name}
\`\`\`
`;

  return {
    entryPoint: 'index.js',
    files: [
      { relativePath: 'plugin.json', content: JSON.stringify(manifest, null, 2) + '\n' },
      { relativePath: 'index.js', content: indexJs },
      { relativePath: 'README.md', content: readmeMd }
    ]
  };
}

/**
 * Generates scaffold files for a Native CLI Wrapper Plugin.
 */
export function generateCliPluginScaffold(service: ServiceDescriptor): ScaffoldingPayload {
  const capabilities = Array.from(new Set(['subprocess', ...(service.capabilities || [])]));
  const effectiveTools: ServiceToolDescriptor[] = service.tools.length > 0 ? service.tools : [{
    name: 'run',
    description: `Execute command for ${service.name}`,
    parameters: { type: 'object', properties: {} }
  }];
  const exportNames = buildExportNames(effectiveTools);

  const manifest = {
    schemaVersion: 1,
    name: service.name,
    version: '1.0.0',
    description: service.description || `Native CLI plugin for ${service.name}`,
    capabilities,
    tools: effectiveTools.map((tool, idx) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      entry: 'index.js',
      export: exportNames[idx],
      timeoutMs: 45000
    }))
  };

  const toolExecutors = effectiveTools.map((tool, idx) => {
    const fnName = exportNames[idx];
    const binary = service.cliBinary || service.name;
    return `
/**
 * ${sanitizeComment(tool.description)}
 */
export async function ${fnName}(args = {}, context = {}) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  const bin = ${JSON.stringify(binary)};
  const cliArgs = [];
  ${tool.cliSubcommand ? `cliArgs.push(${JSON.stringify(tool.cliSubcommand)});` : ''}

  for (const [key, val] of Object.entries(args || {})) {
    if (val === true) cliArgs.push(\`--\${key}\`);
    else if (val !== false && val !== null && val !== undefined) {
      cliArgs.push(\`--\${key}\`, String(val));
    }
  }

  try {
    const { stdout, stderr } = await execFileAsync(bin, cliArgs, {
      timeout: 40000,
      maxBuffer: 1024 * 1024,
      cwd: context.workspaceRoot || process.cwd()
    });

    return {
      success: true,
      stdout: stdout.trim(),
      stderr: stderr.trim()
    };
  } catch (err) {
    const errObj = err && typeof err === 'object' ? err : {};
    const stderrMsg = typeof errObj.stderr === 'string' ? errObj.stderr.trim() : '';
    const mainMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: [mainMsg, stderrMsg].filter(Boolean).join(': ')
    };
  }
}
`;
  }).join('\n');

  const indexJs = `// Native CLI wrapper plugin for ${service.name}
// Auto-generated by Causyne PluginsFactory

${toolExecutors}
`;

  const readmeMd = `# ${service.name} CLI Plugin

${service.description}

## Route Information
- **Kind**: Native CLI Plugin (Subprocess wrapper)
- **Binary**: \`${service.cliBinary || service.name}\`
- **Capabilities Required**: \`${capabilities.join(', ')}\`

## Security & Activation
This plugin is created disabled. After verifying the source code:
\`\`\`bash
/plugins enable ${service.name}
\`\`\`
`;

  return {
    entryPoint: 'index.js',
    files: [
      { relativePath: 'plugin.json', content: JSON.stringify(manifest, null, 2) + '\n' },
      { relativePath: 'index.js', content: indexJs },
      { relativePath: 'README.md', content: readmeMd }
    ]
  };
}

/**
 * Generates scaffold files for a Python Bridge Plugin.
 * Uses a Node runner with subprocess capability piping JSON stdin/stdout to bridge.py.
 */
export function generatePythonBridgeScaffold(service: ServiceDescriptor): ScaffoldingPayload {
  const capabilities = Array.from(new Set(['subprocess', ...(service.capabilities || [])]));
  const effectiveTools: ServiceToolDescriptor[] = service.tools.length > 0 ? service.tools : [{
    name: 'run_python',
    description: `Execute Python workflow for ${service.name}`,
    parameters: { type: 'object', properties: {} }
  }];
  const exportNames = buildExportNames(effectiveTools);

  const manifest = {
    schemaVersion: 1,
    name: service.name,
    version: '1.0.0',
    description: service.description || `Python bridge plugin for ${service.name}`,
    capabilities,
    tools: effectiveTools.map((tool, idx) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      entry: 'index.js',
      export: exportNames[idx],
      timeoutMs: 60000
    }))
  };

  const toolExecutors = effectiveTools.map((tool, idx) => {
    const fnName = exportNames[idx];
    const pythonMethod = tool.pythonMethod || tool.name;
    return `
/**
 * ${sanitizeComment(tool.description)}
 */
export async function ${fnName}(args = {}, context = {}) {
  return invokePythonBridge(${JSON.stringify(pythonMethod)}, args, context);
}
`;
  }).join('\n');

  const indexJs = `// Python bridge wrapper for ${service.name}
// Auto-generated by Causyne PluginsFactory

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = path.join(__dirname, 'bridge.py');

async function invokePythonBridge(action, args, context) {
  const payload = JSON.stringify({
    action,
    args: args || {},
    context: {
      workspaceRoot: context.workspaceRoot || process.cwd()
    }
  });

  return new Promise((resolve) => {
    const child = spawn('python3', [BRIDGE_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ success: false, error: 'Python bridge timed out after 55 seconds' });
    }, 55000);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => {
      finish({
        success: false,
        error: \`Failed to spawn python3: \${err.message}. Ensure python3 is installed and in PATH.\`
      });
    });

    child.on('close', (code) => {
      if (code !== 0 && !stdout.trim()) {
        finish({
          success: false,
          exitCode: code,
          error: stderr.trim() || \`Python bridge exited with code \${code}\`
        });
        return;
      }

      try {
        const parsed = JSON.parse(stdout.trim());
        finish(parsed);
      } catch (parseErr) {
        finish({
          success: code === 0,
          rawOutput: stdout.trim(),
          stderr: stderr.trim(),
          parseError: parseErr.message
        });
      }
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}

${toolExecutors}
`;

  const pythonModule = service.pythonModule || service.name;
  const safeServiceName = sanitizePythonText(service.name);
  const safePythonModule = sanitizePythonText(pythonModule);
  const bridgePy = `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Python Bridge for ${safeServiceName}
Auto-generated by Causyne PluginsFactory

Communicates with Causyne Agent via JSON on stdin/stdout.
Provides on-demand buffer for ${safePythonModule}.
"""

import sys
import json
import traceback

def handle_request(payload):
    action = payload.get("action", "")
    args = payload.get("args", {})
    context = payload.get("context", {})

    try:
        # Dynamically reference target python module
        # import ${safePythonModule}
        
        result = {
            "action": action,
            "processed": True,
            "args_echo": args,
            "message": f"Successfully executed action '{action}' via Python bridge."
        }
        return {"success": True, "result": result}
    except Exception as exc:
        return {
            "success": False,
            "error": str(exc),
            "traceback": traceback.format_exc()
        }

def main():
    try:
        raw_input = sys.stdin.read()
        if not raw_input.strip():
            payload = {}
        else:
            payload = json.loads(raw_input)
            
        response = handle_request(payload)
        print(json.dumps(response))
        sys.stdout.flush()
    except Exception as exc:
        print(json.dumps({
            "success": False,
            "error": f"Fatal bridge exception: {str(exc)}",
            "traceback": traceback.format_exc()
        }))
        sys.stdout.flush()
        sys.exit(1)

if __name__ == "__main__":
    main()
`;

  const readmeMd = `# ${service.name} Python Bridge Plugin

${service.description}

## Route Information
- **Kind**: Python Bridge (Subprocess JSON buffer)
- **Python Module**: \`${pythonModule}\`
- **Capabilities Required**: \`${capabilities.join(', ')}\`

## Prerequisites
Ensure Python 3 is installed:
\`\`\`bash
python3 --version
\`\`\`

## Security & Activation
This plugin is created disabled. Review the code in \`bridge.py\` and \`index.js\`, then enable:
\`\`\`bash
/plugins enable ${service.name}
\`\`\`
`;

  return {
    entryPoint: 'index.js',
    files: [
      { relativePath: 'plugin.json', content: JSON.stringify(manifest, null, 2) + '\n' },
      { relativePath: 'index.js', content: indexJs },
      { relativePath: 'bridge.py', content: bridgePy },
      { relativePath: 'README.md', content: readmeMd }
    ]
  };
}

/**
 * Generates scaffold files for a standalone Stdio MCP Server.
 * Lightweight, zero-external-dependency JSON-RPC 2.0 stdio server.
 */
export function generateMcpServerScaffold(service: ServiceDescriptor): ScaffoldingPayload {
  const serverName = `mcp-server-${service.name}`;
  const packageJson = {
    name: serverName,
    version: '1.0.0',
    type: 'module',
    description: service.description || `MCP Server for ${service.name}`,
    main: 'server.js',
    scripts: {
      start: 'node server.js'
    }
  };

  const toolsListJson = JSON.stringify(
    service.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters
    })),
    null,
    2
  );

  const serverJs = `#!/usr/bin/env node
// MCP Server for ${service.name}
// Protocol: Model Context Protocol (JSON-RPC 2.0 stdio)
// Auto-generated by Causyne PluginsFactory

import readline from 'node:readline';

const TOOLS = ${toolsListJson};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function handleRequest(request) {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize':
      return {
        id,
        jsonrpc: '2.0',
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: ${JSON.stringify(serverName)},
            version: '1.0.0'
          }
        }
      };

    case 'notifications/initialized':
    case 'initialized':
      return null;

    case 'ping':
      return { id, jsonrpc: '2.0', result: {} };

    case 'tools/list':
      return {
        id,
        jsonrpc: '2.0',
        result: { tools: TOOLS }
      };

    case 'resources/list':
      return { id, jsonrpc: '2.0', result: { resources: [] } };

    case 'prompts/list':
      return { id, jsonrpc: '2.0', result: { prompts: [] } };

    case 'tools/call': {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const found = TOOLS.find(t => t.name === toolName);

      if (!found) {
        return {
          id,
          jsonrpc: '2.0',
          error: { code: -32601, message: \`Tool '\${toolName}' not found\` }
        };
      }

      // Execute tool logic
      const resultData = {
        tool: toolName,
        success: true,
        echo: toolArgs,
        timestamp: new Date().toISOString()
      };

      return {
        id,
        jsonrpc: '2.0',
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(resultData, null, 2)
            }
          ]
        }
      };
    }

    default:
      if (id !== undefined) {
        return {
          id,
          jsonrpc: '2.0',
          error: { code: -32601, message: \`Method '\${method}' not supported\` }
        };
      }
      return null;
  }
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const request = JSON.parse(trimmed);
    const response = handleRequest(request);
    if (response) send(response);
  } catch (err) {
    send({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error: ' + String(err) }
    });
  }
});
`;

  const readmeMd = `# ${serverName}

${service.description}

## Route Information
- **Kind**: Model Context Protocol (MCP) stdio Server
- **Protocol**: JSON-RPC 2.0 over standard I/O
- **Tools Supported**: ${service.tools.map(t => t.name).join(', ')}

## Token Footprint Note
MCP servers consume additional tokens per turn due to persistent JSON-RPC schema envelopes.
Where feasible, prefer native plugins or Python bridges for higher token efficiency.

## Registration & Grant
In Causyne Agent, register and review this server:
\`\`\`bash
causyne mcp add ${service.name} node "$HOME/.causyne/mcp-servers/${service.name}/server.js"
causyne mcp grant ${service.name}
\`\`\`
`;

  return {
    entryPoint: 'server.js',
    files: [
      { relativePath: 'package.json', content: JSON.stringify(packageJson, null, 2) + '\n' },
      { relativePath: 'server.js', content: serverJs },
      { relativePath: 'README.md', content: readmeMd }
    ]
  };
}
