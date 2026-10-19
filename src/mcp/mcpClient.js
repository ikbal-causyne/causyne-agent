// Model Context Protocol client.
//
// WHY THIS EXISTS
//
// `src/tools/deferredMcpSearch.js` carries "mcp" in its name and is not an MCP
// client — it searches Causyne's own tool registry. The only code in the tree
// that spoke JSON-RPC was `palmierAutomator.js`, against one hardcoded server.
// So the single largest extensibility lever every competing agent has was
// missing, while the name suggested it was present.
//
// SECURITY POSTURE — read before changing anything here
//
// A client that launches third-party servers is the highest-risk pattern in
// this codebase, so the boundary is drawn in exactly one place and stated
// plainly:
//
//   * A server command NEVER comes from model output. Servers are read from
//     `config.mcpServers`, which only the user writes. The model can ask for a
//     configured server to be enabled; it cannot name a new one, cannot alter a
//     command, and cannot pass arguments to a process launch.
//   * Enabling a server requires the same human approval as any other
//     consent-gated action (`sandbox.js` classifies `grant_mcp_server` with the
//     download actions).
//   * What the model DOES control is tool arguments, which is the entire point
//     of the protocol — the same trust boundary as any other tool call.
//
// If a future change lets a server command originate anywhere other than user
// config, that is a remote-code-execution hole, not a feature.

import { StdioChannel, HttpChannel } from './jsonRpc.js';
import { getPackageVersion } from '../version.js';

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'causyne-agent', version: getPackageVersion() };

export class McpClient {
  /**
   * @param {object} definition a user-configured server entry:
   *   stdio: { name, command, args?, env?, cwd? }
   *   http:  { name, url, headers? }
   */
  constructor(definition) {
    this.name = definition.name;
    this.definition = definition;
    this.channel = null;
    this.tools = [];
    this.serverInfo = null;
  }

  static validateDefinition(definition) {
    if (!definition || typeof definition !== 'object') return 'not an object';
    if (typeof definition.name !== 'string' || !/^[a-z0-9_-]{1,48}$/i.test(definition.name)) {
      return 'name must be 1-48 characters of [A-Za-z0-9_-]';
    }
    const hasStdio = typeof definition.command === 'string' && definition.command.length > 0;
    const hasHttp = typeof definition.url === 'string' && definition.url.length > 0;
    if (hasStdio === hasHttp) return 'exactly one of `command` (stdio) or `url` (http) is required';
    if (hasStdio && !Array.isArray(definition.args || [])) return '`args` must be an array';
    return null;
  }

  async connect() {
    const problem = McpClient.validateDefinition(this.definition);
    if (problem) throw new Error(`invalid server definition: ${problem}`);

    this.channel = this.definition.url
      ? new HttpChannel({ url: this.definition.url, headers: this.definition.headers })
      : new StdioChannel({
          command: this.definition.command,
          args: this.definition.args || [],
          env: this.definition.env || {},
          cwd: this.definition.cwd
        });

    await this.channel.open();

    const result = await this.channel.send('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: CLIENT_INFO
    });
    this.serverInfo = result?.serverInfo || null;

    // Required by the protocol: the server may not serve requests until it has
    // seen this.
    this.channel.notify('notifications/initialized');

    await this.listTools();
    return this;
  }

  async listTools() {
    const result = await this.channel.send('tools/list', {});
    const raw = Array.isArray(result?.tools) ? result.tools : [];

    // Only keep entries that are actually callable. A malformed advertisement
    // reaching the model produces a tool it can call and we cannot dispatch —
    // the exact failure mode D-6 was about, arriving from someone else's code.
    this.tools = raw
      .filter(t => t && typeof t.name === 'string' && t.name.length > 0)
      .map(t => ({
        name: t.name,
        description: typeof t.description === 'string' ? t.description : '',
        inputSchema: (t.inputSchema && typeof t.inputSchema === 'object')
          ? t.inputSchema
          : { type: 'object', properties: {} }
      }));
    return this.tools;
  }

  async callTool(toolName, args) {
    const result = await this.channel.send('tools/call', { name: toolName, arguments: args ?? {} });

    // MCP returns content blocks. Flatten text for the agent loop, and report an
    // error result as an error rather than as successful output.
    const blocks = Array.isArray(result?.content) ? result.content : [];
    const text = blocks
      .map(b => (b?.type === 'text' && typeof b.text === 'string') ? b.text : '')
      .filter(Boolean)
      .join('\n');

    if (result?.isError) {
      return { success: false, error: text || 'the MCP server reported an error' };
    }
    return {
      success: true,
      output: text || JSON.stringify(result ?? {}, null, 2)
    };
  }

  close() {
    try { if (this.channel) this.channel.close(); } catch (e) {}
    this.channel = null;
    this.tools = [];
  }
}
