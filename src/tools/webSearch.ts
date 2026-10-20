import { BrowserCapabilityError, causyneBrowser } from '../browser/causyneBrowser.js';
import { searchPublicWeb, type SearchResult } from '../browser/searchProviders.js';

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
    description: 'Search the public web through lightweight providers, with the optional Causyne Camoufox browser as a rendered-page fallback. No browser binary is downloaded automatically.',
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
    const query = String(args.query ?? '').trim();
    if (!query || query.length > 1_000) return { success: false, error: 'Search query must contain 1-1000 characters' };
    let lightweightFailure = '';
    try {
      const results = await searchPublicWeb(query);
      return { success: true, output: renderResults(query, results), results };
    } catch (error) {
      lightweightFailure = error instanceof Error ? error.message : String(error);
    }
    try {
      const results = await causyneBrowser().search(query);
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
