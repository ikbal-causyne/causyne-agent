const MAX_PROVIDER_BYTES = 2 * 1024 * 1024;
const MAX_RESULTS = 10;
const SEARCH_TIMEOUT_MS = 15_000;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
}

interface SearchOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (full, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? full;
  });
}

function cleanMarkup(value: string): string {
  return decodeEntities(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function publicResultUrl(value: string): string | null {
  try {
    const parsed = new URL(decodeEntities(value));
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (/(^|\.)(bing|duckduckgo)\.com$/i.test(parsed.hostname)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function parseBingRss(xml: string): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const item of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const body = item[1] ?? '';
    const title = cleanMarkup(body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
    const url = publicResultUrl(cleanMarkup(body.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i)?.[1] ?? ''));
    const snippet = cleanMarkup(body.match(/<description\b[^>]*>([\s\S]*?)<\/description>/i)?.[1] ?? '');
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    results.push({ title: title.slice(0, 300), url, snippet: snippet.slice(0, 500), engine: 'bing-rss' });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const anchors = [...html.matchAll(/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  for (const [index, anchor] of anchors.entries()) {
    let href = decodeEntities(anchor[1] ?? '');
    try {
      const candidate = new URL(href, 'https://html.duckduckgo.com/');
      if (candidate.hostname.endsWith('duckduckgo.com') && candidate.pathname.startsWith('/l/')) {
        href = candidate.searchParams.get('uddg') ?? href;
      }
    } catch {
      continue;
    }
    const url = publicResultUrl(href);
    const title = cleanMarkup(anchor[2] ?? '');
    const tail = html.slice(anchor.index ?? 0, anchors[index + 1]?.index ?? html.length);
    const snippet = cleanMarkup(tail.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i)?.[1] ?? '');
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    results.push({ title: title.slice(0, 300), url, snippet: snippet.slice(0, 500), engine: 'duckduckgo-html' });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_PROVIDER_BYTES) throw new Error('search response is too large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('search response is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size).toString('utf8');
}

export async function searchPublicWeb(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const cleaned = String(query ?? '').trim();
  if (!cleaned || cleaned.length > 1_000) throw new Error('Search query must contain 1-1000 characters');
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  const signal = options.signal ?? controller.signal;
  const providers = [
    {
      engine: 'duckduckgo-html',
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleaned)}`,
      parse: parseDuckDuckGoHtml,
      accept: 'text/html,application/xhtml+xml'
    },
    {
      engine: 'bing-rss',
      url: `https://www.bing.com/search?format=rss&q=${encodeURIComponent(cleaned)}`,
      parse: parseBingRss,
      accept: 'application/rss+xml,application/xml,text/xml'
    }
  ];
  const failures: string[] = [];
  try {
    for (const provider of providers) {
      try {
        const response = await fetchImpl(provider.url, {
          method: 'GET',
          redirect: 'error',
          signal,
          headers: {
            Accept: provider.accept,
            'Accept-Language': 'en-US,en;q=0.8',
            'User-Agent': 'Causyne-Agent/1.10 (+https://causyne.com)'
          }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const results = provider.parse(await readBoundedText(response));
        if (results.length > 0) return results;
        failures.push(`${provider.engine}: no results`);
      } catch (error) {
        failures.push(`${provider.engine}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    clearTimeout(timeout);
  }
  throw new Error(`Lightweight search providers exhausted. ${failures.join('; ')}`);
}
