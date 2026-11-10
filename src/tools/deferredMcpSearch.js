// registry.js imports THIS module to build its tool table, so a static import
// back the other way is a cycle: whichever side loads first sees the other as
// uninitialised and the whole registry throws. It happened to work only while
// registry.js was always imported first. Loaded on demand instead — execute()
// is async, so this costs nothing.
async function toolDefinitions() {
    const { getSearchableToolDefinitions } = await import('./registry.js');
    return getSearchableToolDefinitions();
}
import { buildToolsList } from '../toolsList.js';
import { PACKS, PACK_NAMES, packForTool, isCoreTool, isResidentTool } from '../toolPacks.js';
import { literalSearchPattern, formatSkillSearchLine, MAX_TOOL_SEARCH_QUERY } from '../skills/skillSearchSafety.js';
import { queryTerms, wordsOf, termMatches, requiredCoverage } from './searchRelevance.js';
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
async function searchSkills(terms, pattern, options = {}) {
    // Imported lazily, not at module scope: registry.js imports THIS module, and
    // skillsManager pulls registry back in transitively — a static import here
    // closes the cycle and the whole tool registry fails to initialise. Same
    // pattern registry.js already uses for capabilityTools.
    let catalogue;
    try {
        const { listCompiledSkills } = await import('../skillsManager.js');
        catalogue = listCompiledSkills();
    }
    catch (e) {
        return []; // a broken skill store must not take tool search down
    }
    const scored = [];
    const minCoverage = requiredCoverage(terms.length);
    for (const skill of catalogue) {
        // Whole-word matching: a substring test let "kill" match every "skill"
        // and "and" match every "android".
        const titleWords = wordsOf(`${skill.id} ${skill.name}`);
        const domainWords = wordsOf(skill.domain);
        const allWords = wordsOf(`${skill.id} ${skill.name} ${skill.domain} ${skill.description || ''}`);
        let score = 0;
        let coverage = 0;
        let phraseHit = false;
        if (pattern) {
            if (pattern.test(skill.name) || pattern.test(skill.id)) {
                score += 10;
                phraseHit = true;
            }
            if (pattern.test(skill.description || ''))
                score += 4;
        }
        for (const term of terms) {
            if (termMatches(term, titleWords)) {
                score += 8;
                coverage++;
            }
            else if (termMatches(term, domainWords)) {
                score += 6;
                coverage++;
            }
            else if (termMatches(term, allWords)) {
                score += 3;
                coverage++;
            }
        }
        if (score > 0)
            scored.push({ skill, score, coverage, phraseHit });
    }
    const strong = scored.filter(entry => entry.phraseHit || entry.coverage >= minCoverage);
    const pool = strong.length > 0 ? strong : (options.allowFallback ? scored : []);
    return pool
        .sort((a, b) => (b.coverage - a.coverage) || (b.score - a.score))
        .slice(0, MAX_SKILL_HITS)
        .map(({ skill }) => formatSkillSearchLine(skill));
}
function scoreTool(definition, terms, pattern) {
    const name = (definition.name || '').toLowerCase();
    const description = (definition.description || '').toLowerCase();
    // Parameter names (e.g. `port`) identify capabilities directly; parameter
    // descriptions often list example platforms and act only as tiebreakers.
    let paramKeysText = '';
    let paramDescText = '';
    const properties = definition.parameters?.properties || definition.input_schema?.properties;
    if (properties) {
        for (const [key, value] of Object.entries(properties)) {
            paramKeysText += ` ${key}`;
            if (value && value.description) {
                paramDescText += ` ${value.description}`;
            }
        }
    }
    paramKeysText = paramKeysText.toLowerCase();
    paramDescText = paramDescText.toLowerCase();
    let score = 0;
    let coverage = 0;
    let nameHit = false;
    if (pattern) {
        if (pattern.test(name)) {
            score += 12;
            nameHit = true;
        }
        if (pattern.test(description))
            score += 6;
        if (pattern.test(paramKeysText) || pattern.test(paramDescText))
            score += 2;
    }
    // Whole-word matching. Substring tests let "and" hit "command", "kill" hit
    // "skill" and "port" hit "export", which unlocked unrelated schemas.
    const nameWords = wordsOf(definition.name || '');
    const descriptionWords = wordsOf(description);
    const paramKeyWords = wordsOf(paramKeysText);
    const paramDescWords = wordsOf(paramDescText);
    for (const term of terms) {
        let matched = false;
        if (termMatches(term, nameWords)) {
            score += 10;
            matched = true;
        }
        if (termMatches(term, descriptionWords)) {
            score += 4;
            matched = true;
        }
        if (termMatches(term, paramKeyWords)) {
            score += 3;
            matched = true;
        }
        if (matched) {
            coverage++;
        }
        else if (termMatches(term, paramDescWords)) {
            score += 1;
        }
    }
    return { score, coverage, nameHit };
}
function buildPattern(query) {
    // Never compile LLM-generated regex. A pattern such as (a+)+$ can freeze
    // Node's single-threaded event loop. Natural-language token scoring is
    // preserved; the phrase match is literal and bounded.
    return literalSearchPattern(query);
}
export const deferredMcpSearch = {
    schema: {
        name: 'tool.search',
        description: 'Discover tools or skills from the live catalog. Select exact names, describe a capability, or explicitly load a pack. Selected schemas appear next turn; execution permissions still apply.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'What capability you need. Use natural language or exact tool/skill names. Special regex characters are treated literally.'
                },
                names: { type: 'array', items: { type: 'string' }, description: 'Exact tool names selected from the compact catalog. Loads only these schemas.' },
                pack: {
                    type: 'string',
                    enum: [...PACK_NAMES, 'all'],
                    description: 'Optional. Load an entire capability pack at once instead of searching: game, web, media, system, or advanced.'
                },
                limit: {
                    type: 'integer',
                    description: 'Maximum number of tools to return. Defaults to 8.'
                }
            }
        }
    },
    async execute(args, context = {}) {
        try {
            const rawQueries = args.queries;
            const joinedQueries = Array.isArray(rawQueries)
                ? rawQueries.map((item) => String(item ?? '').trim()).filter(Boolean).join(' ')
                : (typeof rawQueries === 'string' ? rawQueries : '');
            const rawQuery = Array.isArray(args.query)
                ? args.query.map((item) => String(item ?? '').trim()).filter(Boolean).join(' ')
                : args.query;
            const query = String(rawQuery ?? args.q ?? args.search ?? args.term ??
                args.regex ?? args.description ?? args.pattern ?? joinedQueries ?? '').trim();
            if (query.length > MAX_TOOL_SEARCH_QUERY) {
                return { success: false, error: `Search query exceeds ${MAX_TOOL_SEARCH_QUERY} characters. Use a shorter capability description.` };
            }
            const requestedPack = args.pack ? String(args.pack).toLowerCase() : null;
            const definitions = context.parentLoop?.searchableTools
                ? await context.parentLoop.searchableTools() : await toolDefinitions();
            const hints = new Map(buildToolsList(definitions).map((entry) => [entry.name, entry.hint]));
            if (Array.isArray(args.names) && args.names.length > 0) {
                const available = new Map(definitions.map((definition) => [definition.name.toLowerCase(), definition.name]));
                const chosen = [...new Set(args.names.map((name) => available.get(String(name).toLowerCase())).filter((name) => Boolean(name)))];
                if (chosen.length !== new Set(args.names.map((name) => String(name).toLowerCase())).size) {
                    return { success: false, error: 'One or more selected tools are unavailable under the current policy. Select exact names from the current catalog.' };
                }
                return { success: true, output: `Selected ${chosen.length} tool schemas for your next turn:\n${chosen.map((name) => `- ${name}: ${hints.get(name) || 'tool'}`).join('\n')}`, _unlock_tools: chosen };
            }
            if (!query && !requestedPack) {
                return { success: false, error: 'Provide a "query" describing the capability you need, or a "pack" name to load.' };
            }
            // Whole-pack load. Cheaper than five searches when the agent already
            // knows it is starting a game or a media pipeline.
            if (requestedPack && requestedPack !== 'all' && Object.hasOwn(PACKS, requestedPack)) {
                const packTools = definitions.filter(d => packForTool(d.name) === requestedPack);
                return {
                    success: true,
                    output: `Loaded capability pack "${requestedPack}" (${packTools.length} tools). These are now callable:\n` +
                        packTools.map(d => `- ${d.name}: ${hints.get(d.name) || 'tool'}`).join('\n'),
                    _unlock_packs: [requestedPack],
                    _unlock_tools: packTools.map(d => d.name)
                };
            }
            const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 25) : 8;
            const lower = query.toLowerCase();
            const terms = queryTerms(query);
            const pattern = buildPattern(query);
            // Tool discovery stays bounded: an entry sharing a single generic word
            // with a multi-word request is not a match.
            const minCoverage = requiredCoverage(terms.length);
            const exact = definitions.find(definition => definition.name.toLowerCase() === lower);
            const scored = (exact ? [exact] : definitions)
                .map(definition => ({ definition, ...scoreTool(definition, terms, pattern) }))
                .filter(entry => entry.score > 0 && (exact !== undefined || entry.nameHit || entry.coverage >= minCoverage))
                .sort((a, b) => (b.coverage - a.coverage) || (b.score - a.score))
                .slice(0, limit);
            if (scored.length === 0) {
                // Still search skills. "how do I structure a django migration" matches
                // no tool name and every relevant skill — returning "no tools matched"
                // and stopping was the whole reason a 40-entry catalogue had to sit in
                // the system prompt.
                const skillOnly = await searchSkills(terms, pattern, { allowFallback: true });
                if (skillOnly.length > 0) {
                    const canUnlockSkillReader = !isResidentTool('fs_read_skill') &&
                        definitions.some((definition) => definition.name === 'fs_read_skill');
                    return {
                        success: true,
                        output: `No tools matched "${query}". Matching SKILLS — read one with fs_read_skill:\n` +
                            skillOnly.join('\n'),
                        ...(canUnlockSkillReader ? { _unlock_tools: ['fs_read_skill'], _unlock_packs: [] } : {})
                    };
                }
                return {
                    success: true,
                    output: `Nothing matched "${query}". Available capability packs: ${PACK_NAMES.join(', ')}. ` +
                        `Try a broader term, or set the "pack" argument to load a whole pack at once.`
                };
            }
            const unlockTools = [];
            const lines = [];
            for (const { definition } of scored) {
                const pack = packForTool(definition.name);
                // Unlock anything that is not already resident. The old condition was
                // `!isCoreTool(...)`, which was correct while the entire core shipped
                // in every request. It is not any more: on a provider without native
                // schema deferral only RESIDENT_TOOLS ship, and a non-resident core
                // tool found here would have been reported as "already loaded" and
                // then stayed invisible forever.
                if (!isResidentTool(definition.name))
                    unlockTools.push(definition.name);
                const state = isCoreTool(definition.name) ? 'core' : `pack: ${pack || 'custom'}`;
                lines.push(`- ${definition.name} (${state}): ${hints.get(definition.name) || 'tool'}`);
            }
            // Skills are searched alongside tools because `tool_search` is the only
            // discovery surface the model always has. The compiled skill catalogue is
            // 100 entries; listing it in the system prompt cost ~841 tokens on EVERY
            // request of every task, including a bare "hi". Retrieval replaces the
            // catalogue — but only because the retrieval exists, which it did not
            // before this change.
            const skillLines = exact ? [] : await searchSkills(terms, pattern, { allowFallback: false });
            const parts = [];
            if (scored.length > 0) {
                parts.push(`Found ${scored.length} tool(s) for "${query}". Their full schemas are now loaded and callable on your next turn:\n` +
                    lines.join('\n'));
            }
            if (skillLines.length > 0) {
                if (!isResidentTool('fs_read_skill') &&
                    !unlockTools.includes('fs_read_skill') &&
                    definitions.some((definition) => definition.name === 'fs_read_skill')) {
                    unlockTools.push('fs_read_skill');
                }
                parts.push(`\nMatching SKILLS — read one with fs_read_skill before you plan, do not guess syntax it covers:\n` +
                    skillLines.join('\n'));
            }
            return {
                success: true,
                output: parts.join('\n'),
                _unlock_tools: unlockTools,
                _unlock_packs: []
            };
        }
        catch (e) {
            return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
    }
};
