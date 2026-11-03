/**
 * Cost and Token Footprint Estimation for PluginsFactory.
 *
 * Provides transparent, measurable token footprint estimates across integration routes:
 * - Native Plugin (HTTP/CLI): Leanest token footprint, lowest cost.
 * - Python Bridge: Lightweight buffer process for Python-only libraries.
 * - MCP Server: Rich protocol but significantly higher token and process overhead.
 */
/**
 * Estimate the token footprint of a single tool schema in agent context.
 * Standard token-to-character ratio is approximately 1 token per 4 characters of JSON.
 */
export function estimateToolSchemaTokens(parameters) {
    try {
        const jsonStr = JSON.stringify(parameters ?? {});
        return Math.max(15, Math.ceil(jsonStr.length / 4));
    }
    catch {
        return 30;
    }
}
/**
 * Compute comparative token footprint and runtime cost across all three routes.
 */
export function estimateServiceCosts(service) {
    const toolCount = Math.max(1, service.tools.length);
    const rawSchemaTokens = service.tools.reduce((total, tool) => total + estimateToolSchemaTokens(tool.parameters), 0);
    // 1. Native Plugin (HTTP / CLI)
    // Minimal envelope overhead: name, description, parameters schema (~35 tokens per tool)
    const nativeSchemaTokens = rawSchemaTokens + toolCount * 35;
    const nativePerCallTokens = 120; // Compact direct return payload
    const nativePlugin = {
        route: 'native_plugin',
        estimatedSchemaTokens: nativeSchemaTokens,
        estimatedPerCallTokens: nativePerCallTokens,
        isLongRunningProcess: false,
        relativeCostMultiplier: 1.0,
        explanation: 'Minimal context overhead. Schema is loaded on demand, output is compact, and process terminates immediately.'
    };
    // 2. Python Bridge Plugin
    // Slightly higher envelope overhead for bridge parameter marshalling (~45 tokens per tool)
    const bridgeSchemaTokens = rawSchemaTokens + toolCount * 45;
    const bridgePerCallTokens = 150; // JSON stdin/stdout pipe payload
    const pythonBridge = {
        route: 'python_bridge',
        estimatedSchemaTokens: bridgeSchemaTokens,
        estimatedPerCallTokens: bridgePerCallTokens,
        isLongRunningProcess: false,
        relativeCostMultiplier: 1.25,
        explanation: 'Executes specialized Python SDKs (Blender, DaVinci Resolve, PyTorch) via a lightweight on-demand subprocess.'
    };
    // 3. MCP Server
    // MCP requires full JSON-RPC schema envelope, inputSchema wrapping, and server capabilities (~160 tokens per tool)
    const mcpSchemaTokens = rawSchemaTokens + toolCount * 160 + 120;
    const mcpPerCallTokens = 420; // Full JSON-RPC 2.0 result envelope with text/content arrays
    const mcpMultiplier = Number((mcpSchemaTokens / Math.max(1, nativeSchemaTokens)).toFixed(1));
    const mcpServer = {
        route: 'mcp_server',
        estimatedSchemaTokens: mcpSchemaTokens,
        estimatedPerCallTokens: mcpPerCallTokens,
        isLongRunningProcess: true,
        relativeCostMultiplier: Math.max(3.0, mcpMultiplier),
        explanation: 'Persistent JSON-RPC stdio daemon. Injects full tool schema manifests and verbose protocol framing across conversation turns.'
    };
    return {
        nativePlugin,
        pythonBridge,
        mcpServer
    };
}
/**
 * Format a transparent token disclosure when an MCP server route is considered or requested.
 */
export function formatMcpDisclosure(serviceName, comparison) {
    const native = comparison.nativePlugin;
    const mcp = comparison.mcpServer;
    const ratio = (mcp.estimatedSchemaTokens / Math.max(1, native.estimatedSchemaTokens)).toFixed(1);
    return [
        `### Token Economy Disclosure: ${serviceName}`,
        '',
        `Model Context Protocol (MCP) servers incur higher token consumption compared to native plugins:`,
        `- **Schema Ingestion Overhead**: ~${mcp.estimatedSchemaTokens} tokens vs ~${native.estimatedSchemaTokens} tokens for a native plugin (~${ratio}x larger schema footprint per turn).`,
        `- **Protocol Envelope**: MCP wraps all outputs in full JSON-RPC 2.0 structures (~${mcp.estimatedPerCallTokens} tokens per call vs ~${native.estimatedPerCallTokens} tokens natively).`,
        `- **Process Lifecycle**: MCP runs as an ongoing background daemon, whereas native plugins execute on demand with zero idling resources.`,
        '',
        `**Recommendation**: If an HTTP API, CLI binary, or Python SDK is accessible, a native plugin or Python bridge is vastly more token-efficient and economical.`,
        `However, if this service strictly requires MCP or you prefer standard MCP tooling, Causyne will faithfully implement and configure the MCP server according to your direction.`
    ].join('\n');
}
