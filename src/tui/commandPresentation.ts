export interface CommandPresentationResult {
  ok?: boolean;
  effect?: string;
  output?: string;
  title?: string;
}

/** Local session and MCP feedback belongs in a dialog, never a chat turn. */
export function commandDialog(input: string, result: CommandPresentationResult):
  { title: string; text: string; danger: boolean } | null {
  const command = /^\/(sessions?|mcp)(?:\s|$)/iu.exec(input.trim())?.[1]?.toLowerCase();
  if (!command || ['silent', 'pick-session', 'pick-mcp', 'invoke-skill', 'exit'].includes(result.effect || '')) return null;
  return {
    title: result.title || (command === 'mcp' ? 'MCP servers' : 'Sessions'),
    text: result.output || '',
    danger: result.ok === false
  };
}
