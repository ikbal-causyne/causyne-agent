export const webSearch = {
  schema: {
    name: 'web_search',
    description: 'High-Precision SERP Router. Searches the web and extracts top organic results.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query.'
        }
      },
      required: ['query']
    }
  },
  
  execute: async (args) => {
    try {
      // Phase 7 AGI Upgrade: Zero-Dependency Native Fetch Scraper
      // Skipping Google's aggressive 429 Blocks by utilizing Yahoo Search HTML parsing.
      const url = 'https://search.yahoo.com/search?p=' + encodeURIComponent(args.query);
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5'
        }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP Error ${response.status}`);
      }
      
      const html = await response.text();
      const results = [];
      
      // Robust Regex to extract Yahoo organic results
      const regex = /<div class=\"compTitle[^>]*>.*?<h3[^>]*>.*?<a[^>]*href=\"([^\"]+)\"[^>]*>(.*?)<\/a>.*?<\/h3>.*?<div class=\"compText[^>]*>(.*?)<\/div>/gs;
      
      let match;
      while ((match = regex.exec(html)) !== null && results.length < 8) {
        let link = match[1];
        
        // Yahoo heavily redirects via RU=..., decode it to get the raw clean URL
        if (link.includes('RU=')) {
          const ruMatch = link.match(/RU=([^/]+)\//);
          if (ruMatch) link = decodeURIComponent(ruMatch[1]);
        }
        
        // Skip sponsored Bing/Yahoo Ads
        if (link.includes('bing.com/aclick') || link.includes('yahoo.com/yhs/')) {
          continue;
        }
        
        results.push({ 
          url: link, 
          title: match[2].replace(/<[^>]+>/g, '').trim(),
          snippet: match[3].replace(/<[^>]+>/g, '').trim()
        });
      }
      
      if (results.length === 0) {
        return { success: true, output: "No organic results found. Try using web.fetch on known direct domains." };
      }
      
      let outputString = `🔍 SERP Results for "${args.query}":\n\n`;
      outputString += `[TOP WEB RESULTS]\n`;
      results.forEach((r, idx) => {
        outputString += `${idx + 1}. ${r.title}\n   URL: ${r.url}\n   Snippet: ${r.snippet}\n\n`;
      });
      
      return { success: true, output: outputString.trim() };
      
    } catch (error) {
      return { 
        success: false, 
        error: `Search Engine Blocked Request: ${error.message}. Do NOT guess random API URLs. Instead, use the web_fetch tool directly on known sites (e.g. finance.yahoo.com, coinmarketcap.com, wikipedia.org).` 
      };
    }
  }
};
