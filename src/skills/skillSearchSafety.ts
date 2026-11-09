/**
 * The tool_search query is written by a model or a user, not trusted code.
 * Node's RegExp engine can spend unbounded CPU on catastrophic backtracking.
 * Search is literal by default; token scoring still handles natural language.
 * This changes the old regex-query behavior intentionally to keep the agent's
 * event loop responsive under malformed or adversarial inputs.
 */
export const MAX_TOOL_SEARCH_QUERY = 240;
export const MAX_SKILL_SEARCH_DESCRIPTION = 180;

export function literalSearchPattern(query: unknown): RegExp | null {
  if (typeof query !== 'string') return null;
  const text = query.trim();
  if (text.length === 0 || text.length > MAX_TOOL_SEARCH_QUERY) return null;
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'i');
}

/** Only display metadata in a tool search result; not raw multiline skill text. */
export function formatSkillSearchLine(skill: {
  domain: string; id: string; name: string; description?: string; source?: string;
}): string {
  const clean = (value: string, limit: number) => value
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim().slice(0, limit);
  const id = `${skill.domain}/${skill.id}`;
  const name = clean(skill.name || skill.id, 80);
  const description = clean(skill.description || '', MAX_SKILL_SEARCH_DESCRIPTION);
  const source = ['native', 'user', 'plugin'].includes(skill.source || '') ? skill.source : 'unknown';
  return `- ${id} [${source}] — ${name}: ${description}`;
}
