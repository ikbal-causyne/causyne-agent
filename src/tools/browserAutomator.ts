import {
  BrowserCapabilityError,
  causyneBrowser,
  getSupportedSearchMacros,
  type BrowserAction,
  type BrowserActionType
} from '../browser/causyneBrowser.js';

interface SandboxContext {
  workspacePaths?: string[];
  workspaceRoot?: string;
}

const SUPPORTED_ACTION_TYPES: BrowserActionType[] = [
  'newTab', 'new_tab',
  'switchTab', 'switch_tab',
  'listTabs', 'list_tabs',
  'closeTab', 'close_tab',
  'search',
  'goto', 'open', 'navigate',
  'snapshot', 'scrape',
  'click', 'clickIndex',
  'type', 'typeIndex', 'fill',
  'selectOption', 'select',
  'keyPress', 'press',
  'hover',
  'scroll',
  'wait',
  'viewport',
  'back', 'forward', 'reload', 'refresh',
  'extract', 'links', 'images',
  'upload', 'download', 'screenshot'
];

function normalizeActions(args: Record<string, unknown> | undefined): BrowserAction[] {
  if (!args || typeof args !== 'object') return [];
  if (Array.isArray(args.actions)) {
    return args.actions.map(item => {
      if (item && typeof item === 'object' && !('type' in item) && typeof (item as Record<string, unknown>).action === 'string') {
        const { action, ...rest } = item as Record<string, unknown>;
        return { ...rest, type: action as BrowserActionType } as BrowserAction;
      }
      return item as BrowserAction;
    });
  }
  const singleType = typeof args.type === 'string'
    ? args.type
    : typeof args.action === 'string'
      ? args.action
      : null;
  if (singleType) {
    const { action: _action, ...rest } = args;
    return [{ ...rest, type: singleType as BrowserActionType } as BrowserAction];
  }
  return [];
}

export const browserAct = {
  schema: {
    name: 'browser.act',
    description: `Use the dedicated Causyne Browser for resilient search, navigation, search macros (${getSupportedSearchMacros().slice(0, 6).join(', ')}, etc.), accessible snapshots (including child iframes and structured forms/tables), interaction, deterministic schema extraction, and workspace-scoped uploads/downloads. Take a snapshot before interacting by ref.`,
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
                enum: SUPPORTED_ACTION_TYPES
              },
              tabId: { type: 'string', description: 'Tab id returned by newTab or listTabs.' },
              url: { type: 'string', description: 'Public http(s) URL or @macro_search shorthand for goto/newTab.' },
              macro: { type: 'string', description: 'Search macro such as @google_search, @youtube_search, @wikipedia_search, @reddit_search, @amazon_search.' },
              query: { type: 'string', description: 'Search query for search action or search macro.' },
              ref: { type: 'string', description: 'Current accessibility ref, for example e12.' },
              index: { type: 'number', description: 'Legacy numeric form of an accessibility ref.' },
              selector: { type: 'string', description: 'CSS selector when a current accessibility ref is unavailable.' },
              text: { type: 'string' },
              value: { type: 'string' },
              option: { type: 'string', description: 'Option value or visible label for selectOption/select.' },
              key: { type: 'string', description: 'Keyboard key or chord (e.g. Enter, Escape, Control+a, Meta+k).' },
              mode: { type: 'string', enum: ['fill', 'keyboard'], description: 'Typing mode for type/fill action.' },
              delay: { type: 'number', description: 'Per-character delay in ms when mode is keyboard.' },
              submit: { type: 'boolean', description: 'Press Enter after typing text.' },
              pressEnter: { type: 'boolean', description: 'Alias for submit: press Enter after typing text.' },
              doubleClick: { type: 'boolean', description: 'Perform a double click instead of a single click.' },
              direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
              amount: { type: 'number' },
              offset: { type: 'number', description: 'Character offset for a paged accessibility snapshot or links pagination.' },
              limit: { type: 'number', description: 'Maximum number of links or images to return.' },
              timeout: { type: 'number', description: 'Wait timeout in milliseconds for wait action.' },
              waitForNetwork: { type: 'boolean', description: 'Wait for networkidle during wait action.' },
              dismissConsent: { type: 'boolean', description: 'Automatically dismiss common cookie/consent banners.' },
              width: { type: 'number', description: 'Viewport width in pixels (100-4000) for viewport action.' },
              height: { type: 'number', description: 'Viewport height in pixels (100-4000) for viewport action.' },
              schema: {
                type: 'object',
                description: 'Deterministic JSON Schema with x-ref annotations for extract action.'
              },
              filePath: {
                oneOf: [
                  { type: 'string' },
                  { type: 'array', items: { type: 'string' } }
                ],
                description: 'Workspace-relative file path(s) for upload action.'
              },
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

  async execute(args: { actions?: BrowserAction[] } & Record<string, unknown>, sandbox?: SandboxContext) {
    try {
      const workspace = sandbox?.workspacePaths?.[0] ?? sandbox?.workspaceRoot ?? process.cwd();
      const actions = normalizeActions(args);
      const results = await causyneBrowser({ workspace }).run(actions, { workspace });
      return { success: true, output: JSON.stringify(results, null, 2), data: results };
    } catch (error) {
      if (error instanceof BrowserCapabilityError) {
        return { success: false, error: error.message, requiresConsent: error.requiresConsent };
      }
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
};
