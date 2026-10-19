// registry.js imports THIS module to build its tool table, so a static import
// back the other way is a cycle: whichever side loads first sees the other as
// uninitialised and the whole registry throws. It happened to work only while
// registry.js was always imported first. Loaded on demand instead — execute()
// is async, so this costs nothing.
async function toolDefinitions() {
  const { TOOL_DEFINITIONS } = await import('./registry.js');
  return TOOL_DEFINITIONS;
}
import { PACKS, PACK_NAMES, packForTool, isCoreTool, isResidentTool } from '../toolPacks.js';

/** Max skills returned alongside the tool matches, so one search stays cheap. */
const MAX_SKILL_HITS = 5;

/**
 * Score the skill catalogue with the same query the tools were scored with.
 *
 * Exists because there was no skill search at all: the system prompt carried a
 * 40-entry catalogue and that was the ONLY way the model could learn a skill id.
 * Replacing that catalogue with a domain header is only safe once this exists.
 *
 * @returns {string[]} formatted lines, empty when nothing matched
 */
async function searchSkills(terms, pattern) {
  // Imported lazily, not at module scope: registry.js imports THIS module, and
  // skillsManager pulls registry back in transitively — a static import here
  // closes the cycle and the whole tool registry fails to initialise. Same
  // pattern registry.js already uses for capabilityTools.
  let catalogue;
  try {
    const { listCompiledSkills } = await import('../skillsManager.js');
    catalogue = listCompiledSkills();
  } catch (e) {
    return []; // a broken skill store must not take tool search down
  }

  const scored = [];
  for (const skill of catalogue) {
    const haystack = `${skill.id} ${skill.name} ${skill.domain} ${skill.description || ''}`.toLowerCase();
    let score = 0;
    if (pattern) {
      if (pattern.test(skill.name) || pattern.test(skill.id)) score += 10;
      if (pattern.test(skill.description || '')) score += 4;
    }
    for (const term of terms) {
      if (skill.id.toLowerCase().includes(term) || skill.name.toLowerCase().includes(term)) score += 8;
      else if (skill.domain.toLowerCase() === term) score += 6;
      else if (haystack.includes(term)) score += 3;
    }
    if (score > 0) scored.push({ skill, score });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SKILL_HITS)
    .map(({ skill }) => `- ${skill.domain}/${skill.id} — ${skill.name}: ${skill.description || ''}`);
}

// Real progressive-disclosure tool search.
//
// The previous version of this file advertised "80% token savings" while
// searching a hardcoded catalogue of seven tools that did not exist in the
// registry (mcp_postgres_data, mcp_github_workflow, mcp_android_cli). Any tool
// the model discovered that way led straight to a "Tool does not exist" error,
// and nothing was ever actually deferred.
//
// This version searches the live tool registry and unlocks what it finds. The
// agent loop reads the _unlock_* fields off the result and loads the matching
// schemas into the next request.

function scoreTool(definition, terms, pattern) {
  const name = (definition.name || '').toLowerCase();
  const description = (definition.description || '').toLowerCase();

  // Parameter names and descriptions are searchable too — a query like
  // "kill process on port" should find a tool whose `port` argument mentions it.
  let parameterText = '';
  const properties = definition.parameters?.properties || definition.input_schema?.properties;
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      parameterText += ` ${key} ${(value && value.description) || ''}`;
    }
  }
  parameterText = parameterText.toLowerCase();

  let score = 0;

  if (pattern) {
    if (pattern.test(name)) score += 12;
    if (pattern.test(description)) score += 6;
    if (pattern.test(parameterText)) score += 2;
  }

  for (const term of terms) {
    if (name.includes(term)) score += 10;
    if (description.includes(term)) score += 4;
    if (parameterText.includes(term)) score += 1;
  }

  return score;
}

function buildPattern(query) {
  // The query may be a natural-language phrase or a regular expression. Trying
  // it as a regex first gives power users exact control; a malformed pattern
  // simply falls back to keyword scoring instead of throwing.
  try {
    return new RegExp(query, 'i');
  } catch (e) {
    return null;
  }
}

export const deferredMcpSearch = {
  schema: {
    name: 'tool.search',
    description: 'Search your full native tool catalogue and load additional tool schemas on demand. Causyne keeps specialised capability packs (game development, media generation, browser and vision, system control, advanced orchestration) out of your context until you need them. Call this whenever a task needs a capability you cannot currently see — the matching tools become callable immediately on your next turn. Accepts natural language ("generate music", "godot scene", "kill process on port", "read a pdf") or a regular expression.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What capability you need. Natural language or a regex pattern matched against tool names, descriptions and argument descriptions.'
        },
        pack: {
          type: 'string',
          enum: [...PACK_NAMES, 'all'],
          description: 'Optional. Load an entire capability pack at once instead of searching: game, web, media, system, or advanced.'
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of tools to return. Defaults to 8.'
        }
      },
      required: ['query']
    }
  },

  async execute(args, context = {}) {
    try {
      const query = String(args.query || '').trim();
      const requestedPack = args.pack ? String(args.pack).toLowerCase() : null;

      if (!query && !requestedPack) {
        return { success: false, error: 'Provide a "query" describing the capability you need, or a "pack" name to load.' };
      }

      // Whole-pack load. Cheaper than five searches when the agent already
      // knows it is starting a game or a media pipeline.
      if (requestedPack && requestedPack !== 'all' && PACKS[requestedPack]) {
        const packTools = (await toolDefinitions()).filter(d => packForTool(d.name) === requestedPack);
        return {
          success: true,
          output: `Loaded capability pack "${requestedPack}" (${packTools.length} tools). These are now callable:\n` +
            packTools.map(d => `- ${d.name}: ${d.description || ''}`).join('\n'),
          _unlock_packs: [requestedPack],
          _unlock_tools: packTools.map(d => d.name)
        };
      }

      const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 25) : 8;
      const lower = query.toLowerCase();
      const terms = lower.split(/[^a-z0-9_]+/).filter(t => t.length > 2);
      const pattern = buildPattern(query);

      const scored = (await toolDefinitions())
        .map(definition => ({ definition, score: scoreTool(definition, terms, pattern) }))
        .filter(entry => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      if (scored.length === 0) {
        // Still search skills. "how do I structure a django migration" matches
        // no tool name and every relevant skill — returning "no tools matched"
        // and stopping was the whole reason a 40-entry catalogue had to sit in
        // the system prompt.
        const skillOnly = await searchSkills(terms, pattern);
        if (skillOnly.length > 0) {
          return {
            success: true,
            output: `No tools matched "${query}", but these SKILLS did — read one with fs_read_skill:\n` +
              skillOnly.join('\n')
          };
        }
        return {
          success: true,
          output: `Nothing matched "${query}". Available capability packs: ${PACK_NAMES.join(', ')}. ` +
            `Try a broader term, or set the "pack" argument to load a whole pack at once.`
        };
      }

      const unlockTools = [];
      const unlockPacks = new Set();
      const lines = [];

      for (const { definition } of scored) {
        const pack = packForTool(definition.name);
        // Unlock anything that is not already resident. The old condition was
        // `!isCoreTool(...)`, which was correct while the entire core shipped
        // in every request. It is not any more: on a provider without native
        // schema deferral only RESIDENT_TOOLS ship, and a non-resident core
        // tool found here would have been reported as "already loaded" and
        // then stayed invisible forever.
        if (!isResidentTool(definition.name)) {
          unlockTools.push(definition.name);
          if (pack) unlockPacks.add(pack);
        }
        const state = isResidentTool(definition.name)
          ? 'already loaded'
          : (isCoreTool(definition.name) ? 'core' : `pack: ${pack || 'custom'}`);
        lines.push(`- ${definition.name} (${state}): ${definition.description || ''}`);
      }

      // Skills are searched alongside tools because `tool_search` is the only
      // discovery surface the model always has. The compiled skill catalogue is
      // 100 entries; listing it in the system prompt cost ~841 tokens on EVERY
      // request of every task, including a bare "hi". Retrieval replaces the
      // catalogue — but only because the retrieval exists, which it did not
      // before this change.
      const skillLines = await searchSkills(terms, pattern);

      const parts = [];
      if (scored.length > 0) {
        parts.push(
          `Found ${scored.length} tool(s) for "${query}". Their full schemas are now loaded and callable on your next turn:\n` +
          lines.join('\n')
        );
      }
      if (skillLines.length > 0) {
        parts.push(
          `\nMatching SKILLS — read one with fs_read_skill before you plan, do not guess syntax it covers:\n` +
          skillLines.join('\n')
        );
      }

      return {
        success: true,
        output: parts.join('\n'),
        _unlock_tools: unlockTools,
        _unlock_packs: [...unlockPacks]
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
