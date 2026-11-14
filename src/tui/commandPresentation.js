import { safeDisplay } from './text.js';
/** Local session and MCP feedback belongs in a dialog, never a chat turn. */
export function commandDialog(input, result) {
    if (typeof input !== 'string' || !result || typeof result !== 'object')
        return null;
    const command = /^\/(sessions?|mcp)(?:\s|$)/iu.exec(input.trim())?.[1]?.toLowerCase();
    if (!command || ['silent', 'pick-session', 'pick-mcp', 'invoke-skill', 'exit'].includes(result.effect || ''))
        return null;
    const defaultTitle = command === 'mcp' ? 'MCP servers' : 'Sessions';
    const cleanTitle = typeof result.title === 'string'
        ? safeDisplay(result.title).replace(/\s+/g, ' ').trim()
        : '';
    return {
        title: cleanTitle || defaultTitle,
        text: typeof result.output === 'string' ? safeDisplay(result.output) : '',
        danger: result.ok === false
    };
}
