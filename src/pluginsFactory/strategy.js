/**
 * Route Selection Strategy for PluginsFactory.
 *
 * Implements deterministic route assessment prioritizing token efficiency and cost:
 * 1. Check existing coverage: Built-in tools, installed plugins, configured MCP servers.
 * 2. Honor explicit user preference immediately without unnecessary friction.
 * 3. Route 1: Native Plugin (HTTP/CLI) - Leanest token footprint, lowest cost.
 * 4. Route 2: Python Bridge - Lightweight on-demand buffer for Python-only libraries.
 * 5. Route 3: MCP Server - Used when service is MCP-only or user explicitly requests it.
 */
import { estimateServiceCosts, formatMcpDisclosure } from './costEstimate.js';
import { findExistingCapability } from './discovery.js';
const PYTHON_KEYWORDS = [
    'python',
    'scipy',
    'numpy',
    'pandas',
    'torch',
    'pytorch',
    'tensorflow',
    'keras',
    'blender',
    'resolve',
    'bpy',
    'da_vinci',
    'sympy',
    'nltk',
    'spacy',
    'huggingface'
];
function isPythonSpecific(service) {
    if (service.serviceKind === 'python_sdk')
        return true;
    if (service.pythonModule && service.pythonModule.trim())
        return true;
    const nameLower = service.name.toLowerCase();
    const descLower = (service.description || '').toLowerCase();
    return PYTHON_KEYWORDS.some(kw => nameLower.includes(kw) || descLower.includes(kw));
}
export function assessRoute(service, userPreference) {
    const costComparison = estimateServiceCosts(service);
    const capabilityQuery = [service.name, ...service.tools.map(tool => tool.name)].join(' ');
    const existingCapability = findExistingCapability(capabilityQuery);
    // 1. User Preference Override
    const chosenRoute = userPreference ?? service.userPreferredRoute;
    if (chosenRoute) {
        const isMcp = chosenRoute === 'mcp_server';
        const proposal = {
            service,
            recommendedRoute: chosenRoute,
            reason: `Honoring user explicit preference for route '${chosenRoute}'.`,
            costComparison,
            userConsentRequired: false,
            userConfirmedRoute: chosenRoute,
            existingCapability: existingCapability.covered ? existingCapability : undefined
        };
        if (isMcp) {
            proposal.mcpDisclosure = formatMcpDisclosure(service.name, costComparison);
        }
        return proposal;
    }
    // 2. MCP-Only Service Route (explicit kind wins over keyword heuristics)
    if (service.serviceKind === 'mcp_only') {
        return {
            service,
            recommendedRoute: 'mcp_server',
            reason: 'Service exclusively exposes an MCP endpoint or protocol. Recommending MCP server scaffold with token overhead disclosure.',
            costComparison,
            mcpDisclosure: formatMcpDisclosure(service.name, costComparison),
            userConsentRequired: true,
            existingCapability: existingCapability.covered ? existingCapability : undefined
        };
    }
    // 3. Python SDK Route (Bridge Buffer). HTTP and CLI services keep their
    // declared transport even if their description mentions Python.
    if (service.serviceKind === 'python_sdk' ||
        (service.serviceKind === 'custom' && isPythonSpecific(service))) {
        return {
            service,
            recommendedRoute: 'python_bridge',
            reason: 'Service depends on Python SDK or specialized scientific/creative modules. A Python bridge provides an on-demand subprocess buffer without full MCP overhead.',
            costComparison,
            userConsentRequired: false,
            existingCapability: existingCapability.covered ? existingCapability : undefined
        };
    }
    // 4. Default / Native Plugin Route (HTTP API or CLI)
    return {
        service,
        recommendedRoute: 'native_plugin',
        reason: 'Service supports HTTP/REST API or CLI interface. Native plugin is selected as the most token-lean and cost-effective route.',
        costComparison,
        userConsentRequired: false,
        existingCapability: existingCapability.covered ? existingCapability : undefined
    };
}
