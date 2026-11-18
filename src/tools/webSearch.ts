import { BrowserCapabilityError, causyneBrowser } from '../browser/causyneBrowser.js';
import { publicResultUrl, searchPublicWeb, type SearchResult } from '../browser/searchProviders.js';

export function normalizeSearchResults(results: SearchResult[]): SearchResult[] {
  const safe: SearchResult[] = [];
  const clean = (value: string, length: number) => value
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, length);
  for (const item of results) {
    if (!item || typeof item.title !== 'string' || typeof item.url !== 'string') continue;
    const url = publicResultUrl(item.url);
    if (!url) continue;
    const title = clean(item.title, 300);
    if (!title) continue;
    safe.push({
      title, url, snippet: clean(typeof item.snippet === 'string' ? item.snippet : '', 500),
      engine: clean(typeof item.engine === 'string' ? item.engine : 'unknown', 40)
    });
    if (safe.length === 10) break;
  }
  return safe;
}

function renderResults(query: string, results: SearchResult[]): string {
  const lines = [`Search results for "${query}"`, ''];
  for (const [index, result] of results.entries()) {
    lines.push(`${index + 1}. ${result.title}`, `   URL: ${result.url}`);
    if (result.snippet) lines.push(`   ${result.snippet}`);
    lines.push('');
  }
  lines.push(`Search engine used: ${results[0]?.engine ?? 'unknown'}`);
  return lines.join('\n').trim();
}

export const webSearch = {
  schema: {
    name: 'web_search',
    description: 'Search the public web through lightweight providers, with the optional Causyne Browser as a rendered-page fallback. No browser binary is downloaded automatically.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query, 1-1000 characters.' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },

  async execute(args: { query?: string }) {
    if (typeof args?.query !== 'string') return { success: false, error: 'Search query must be a string' };
    const query = args.query.trim();
    if (!query || query.length > 1_000) return { success: false, error: 'Search query must contain 1-1000 characters' };
    let lightweightFailure = '';
    try {
      const results = normalizeSearchResults(await searchPublicWeb(query));
      if (results.length === 0) throw new Error('Public search returned no safe results');
      return { success: true, output: renderResults(query, results), results };
    } catch (error) {
      lightweightFailure = error instanceof Error ? error.message : String(error);
    }
    try {
      const results = normalizeSearchResults(await causyneBrowser().search(query, { skipPublicFallback: true }));
      if (results.length === 0) throw new Error('Rendered search returned no safe results');
      return { success: true, output: renderResults(query, results), results };
    } catch (error) {
      if (error instanceof BrowserCapabilityError) {
        return {
          success: false,
          error: `${lightweightFailure}; rendered browser fallback unavailable: ${error.message}`,
          requiresConsent: error.requiresConsent
        };
      }
      return {
        success: false,
        error: `Web search failed after lightweight and rendered providers: ${lightweightFailure}; ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
};
