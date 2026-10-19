import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Phase 3 AGI Upgrade: HTML Cleanup to Markdown
function htmlToText(html) {
  // AGI Optimization: Aggressively strip scripts, styles, svg, and tags
  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  text = text.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '');
  text = text.replace(/<[^>]+>/g, ' '); // Strip HTML tags
  text = text.replace(/&nbsp;/g, ' '); // Decode basic entities
  text = text.replace(/\s{2,}/g, ' '); // Normalize spaces
  text = text.replace(/\n\s*\n/g, '\n\n'); // Normalize line breaks
  return text.trim();
}

export const webFetch = {
  schema: {
    name: 'web.fetch',
    description: 'Make HTTP requests. Automatically strips raw HTML into clean text to protect Context Window.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string' },
        headers: { type: 'object' },
        body: { type: 'string' },
        outputFile: { type: 'string', description: 'If provided, saves as a binary file instead of returning text' }
      },
      required: ['url']
    }
  },
  async execute(args) {
    try {
      const options = {
        method: args.method || 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0 Safari/537.36',
          ...args.headers
        }
      };
      
      if (args.body) options.body = args.body;
      
      const response = await fetch(args.url, options);
      
      if (args.outputFile) {
        const target = args.outputFile.replace(/^~\//, os.homedir() + '/');
        const buffer = await response.arrayBuffer();
        await fs.writeFile(target, Buffer.from(buffer));
        return { success: true, output: `Downloaded ${buffer.byteLength} bytes to ${args.outputFile}`, status: response.status };
      }
      
      const text = await response.text();
      
      // Phase 3 AGI Upgrade: Clean HTML unless it's an API JSON response
      let cleanOutput = text;
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        cleanOutput = htmlToText(text);
      }
      
      // Strict Context Paging Protection
      if (cleanOutput.length > 50000) {
        cleanOutput = cleanOutput.substring(0, 50000) + '\n\n[... OUTPUT TRUNCATED TO 50KB ...]';
      }

      return { success: true, output: cleanOutput, status: response.status };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
