import { BrowserCapabilityError, causyneBrowser, type BrowserAction } from '../browser/causyneBrowser.js';

export const browserAct = {
  schema: {
    name: 'browser.act',
    description: 'Use the dedicated Causyne Camoufox browser for resilient search, navigation, accessible snapshots, interaction, extraction, and workspace-scoped downloads. Take a snapshot before interacting by ref.',
    parameters: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          minItems: 1,
          maxItems: 40,
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['newTab', 'switchTab', 'listTabs', 'closeTab', 'search', 'goto', 'snapshot', 'scrape', 'click', 'clickIndex', 'type', 'typeIndex', 'selectOption', 'keyPress', 'scroll', 'back', 'forward', 'reload', 'extract', 'download', 'screenshot']
              },
              tabId: { type: 'string', description: 'Tab id returned by newTab or listTabs.' },
              url: { type: 'string', description: 'Public http(s) URL for goto or newTab.' },
              query: { type: 'string', description: 'Search query.' },
              ref: { type: 'string', description: 'Current accessibility ref, for example e12.' },
              index: { type: 'number', description: 'Legacy numeric form of an accessibility ref.' },
              selector: { type: 'string', description: 'CSS selector when a current accessibility ref is unavailable.' },
              text: { type: 'string' },
              value: { type: 'string' },
              key: { type: 'string' },
              direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
              amount: { type: 'number' },
              offset: { type: 'number', description: 'Character offset for a paged accessibility snapshot.' },
              outputFile: { type: 'string', description: 'Download or screenshot destination inside the selected workspace.' },
              fullPage: { type: 'boolean', description: 'Capture the complete page for a screenshot instead of the visible viewport.' }
            },
            required: ['type'],
            additionalProperties: false
          }
        }
      },
      required: ['actions'],
      additionalProperties: false
    }
  },

  async execute(args: { actions?: BrowserAction[] }) {
    try {
      const results = await causyneBrowser().run(args.actions ?? []);
      return { success: true, output: JSON.stringify(results, null, 2), data: results };
    } catch (error) {
      if (error instanceof BrowserCapabilityError) {
        return { success: false, error: error.message, requiresConsent: error.requiresConsent };
      }
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
};
