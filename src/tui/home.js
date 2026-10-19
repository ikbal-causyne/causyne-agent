// Local desktop home: chat, configuration and workspace reports.

import { SelectLayer, InputLayer } from './dialogs.js';
import { paint, dim, bold, badge, GLYPHS } from './theme.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';

/** Local runtime and provider summary. */
export function homeStatusLine({ config = {} } = {}) {
  const model = config.model ? `${config.provider || 'default'}/${config.model}` : (config.provider || 'no provider');
  const configured = config.apiKey || config.provider === 'ollama';
  return '  ' + [
    paint('success', `${GLYPHS.bullet} local desktop`),
    configured ? dim(model) : paint('warn', `${model} — no key`)
  ].join(dim(`  ${GLYPHS.dot}  `));
}

/**
 * Actions shown on the front page.
 *
 * `kind` decides what happens after `run`:
 *   'stay'     — the result is drawn into the live region, home stays up
 *   'takeover' — the prompt is stopped and something else owns the terminal
 *   'chat'     — nothing to run; closing the menu already IS chat
 */
export const PRIMARY_ACTIONS = [
  { id: 'chat', label: 'chat', hint: 'talk to the agent here', kind: 'chat' },
  {
    id: 'status',
    label: 'status',
    hint: 'local runtime and workspace',
    kind: 'stay',
    run: async () => {
      const { buildStatusText } = await import('../reporting.js');
      return buildStatusText();
    }
  },
  {
    id: 'usage',
    label: 'usage',
    hint: 'tokens and cost today',
    kind: 'stay',
    run: async () => (await import('../reporting.js')).buildUsageText()
  },
  { id: 'config', label: 'config', hint: 'provider, model, API key', kind: 'config' },
  { id: 'more', label: 'more…', hint: 'context · checkpoints · undo · mcp · update', kind: 'more' }
];

/**
 * The second page.
 *
 * These are real, and several of them are destructive, which is why they are
 * one level down rather than absent: hiding `unpair` would not make it safer,
 * it would make it undiscoverable.
 */
export const MORE_ACTIONS = [
  {
    id: 'context', label: 'context', category: 'reports', hint: 'what fills the context window', kind: 'stay',
    run: async () => (await import('../reporting.js')).buildContextText()
  },
  {
    id: 'checkpoints', label: 'checkpoints', category: 'reports', hint: 'recent undo points', kind: 'stay',
    run: async () => (await import('../reporting.js')).buildCheckpointsText(15)
  },
  {
    id: 'undo', label: 'undo', category: 'reports', hint: 'roll back the last task', kind: 'command',
    // Routed through the registry so it gets the same confirmation gate the
    // typed command gets. An action that wrote files straight from a menu would
    // be the one path around the gate.
    command: '/undo'
  },
  { id: 'mcp', label: 'mcp', category: 'tools', hint: 'manage MCP servers', kind: 'mcp' },
  {
    id: 'update', label: 'update', category: 'tools', hint: 'update to the latest version', kind: 'takeover',
    run: async () => {
      const { runSelfUpdate } = await import('../autoUpdate.js');
      await runSelfUpdate(true);
    }
  },

];

/** Items in the shape SelectList wants, for the `more…` page. */
export function moreLayer(onPick) {
  return new SelectLayer({
    title: 'more',
    items: MORE_ACTIONS.map((action) => ({
      id: action.id,
      label: action.label,
      description: action.hint,
      category: action.category,
      value: action
    })),
    onPick: (item) => onPick(item && item.value)
  });
}

/** The hint row under the input while the menu is up. */
export function homeHint() {
  return dim(`  ${bold('↑↓')} pick  ${GLYPHS.dot}  ${bold('enter')} run  ${GLYPHS.dot}  ${bold('esc')} menu off  ${GLYPHS.dot}  or just start typing`);
}

export { badge };

// ---------------------------------------------------------------------------
// The two flows that need a keyboard
//
// Both of these used inquirer, which takes stdin while ChatPrompt is already
// holding it in raw mode — the two contend and the question lands on a
// half-drawn prompt. Inside home there IS a live region and a modal stack, so
// they can be asked properly. `causyne config` invoked on its own still uses the
// inquirer wizard, because standalone there is no live region to draw into and
// building a second one is how the deleted alt-screen shell started.
// ---------------------------------------------------------------------------

/** Provider choices for local CLI configuration. */
// Suggested models come from src/modelCatalogue.js rather than being repeated
// here. This list had drifted to `gpt-4o` and `gemini-2.5-pro` — two

// stale values again. Labels and hints stay local because they are terminal UI.
export const PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek', hint: 'recommended for STEM' },
  { id: 'qwen', label: 'Qwen / Alibaba Cloud', hint: 'fastest' },
  { id: 'dashscope-byok', label: 'Alibaba DashScope', hint: 'multi-model gateway' },
  { id: 'muse', label: 'Meta Model API', hint: 'Muse Spark · 1M context' },
  { id: 'anthropic', label: 'Anthropic', hint: 'Claude' },
  { id: 'openai', label: 'OpenAI', hint: 'GPT' },
  { id: 'gemini', label: 'Gemini', hint: 'Google' },
  { id: 'moonshot', label: 'Moonshot', hint: 'Kimi' },
  { id: 'xai', label: 'xAI', hint: 'Grok' },
  { id: 'openai-compatible', label: 'OpenAI-compatible endpoint', hint: 'custom base URL' },
  { id: 'ollama', label: 'Ollama', hint: 'local / offline' }
].map((entry) => ({ ...entry, model: DEFAULT_MODEL_BY_PROVIDER[entry.id] ?? '' }));

/**
 * Ask for provider, then model, then key — each in the prompt's own panel.
 *
 * Resolves when the last answer is in, or when any step is dismissed. Dismissing
 * cancels the whole flow rather than saving a half-configuration, because a
 * provider saved without its key leaves the agent in a state that fails on the
 * next turn with an error about credentials rather than about the cancel.
 */
export function configureInPrompt(prompt, { loadConfig, saveConfig }) {
  return new Promise((resolve) => {
    const config = loadConfig();

    prompt.openLayer(new SelectLayer({
      title: 'provider',
      items: PROVIDERS.map((p) => ({ id: p.id, label: p.label, description: p.hint, value: p })),
      onPick: (item) => {
        if (!item) { resolve(null); return; }
        const provider = item.value;
        askModel(provider);
      }
    }));

    function askModel(provider) {
      const suggested = (config.provider === provider.id && config.model) ? config.model : provider.model;
      prompt.openLayer(new InputLayer({
        title: `model for ${provider.label}`,
        lines: [
          'Model ids change often. Type the one you want, or accept the suggestion.'
        ],
        value: suggested,
        placeholder: 'model id',
        onSubmit: (model) => askKey(provider, (model || '').trim() || suggested),
        onCancel: () => resolve(null)
      }));
    }

    function askKey(provider, model) {
      prompt.openLayer(new InputLayer({
        title: 'API key',
        lines: [
          `${provider.label} ${GLYPHS.arrow} ${model}`,
          '',
          'Stored encrypted in ~/.causyne/config.json. It never leaves this machine.'
        ],
        mask: true,
        value: '',
        placeholder: 'paste your key (blank keeps the current one)',
        onSubmit: (apiKey) => {
          const next = loadConfig();
          next.provider = provider.id;
          next.model = model;
          if (apiKey) next.apiKey = apiKey;
          saveConfig(next);
          resolve({ provider: provider.id, model });
        },
        onCancel: () => resolve(null)
      }));
    }
  });
}

/** The MCP server list, as something you can act on rather than read. */
export async function mcpPicker(prompt, onAction) {
  const { serverStatus } = await import('../mcp/mcpRegistry.js');
  const servers = await serverStatus();
  const rows = Array.isArray(servers) ? servers : (servers && servers.servers) || [];

  if (rows.length === 0) {
    return { empty: true };
  }

  prompt.openLayer(new SelectLayer({
    title: 'MCP servers',
    items: rows.map((server) => ({
      id: server.name,
      label: server.name,
      description: `${server.granted ? 'granted' : 'not granted'}${server.command ? ` ${GLYPHS.dot} ${server.command}` : ''}`,
      category: server.granted ? 'granted' : 'available',
      value: server
    })),
    onPick: (item) => { if (item) onAction(item.value); }
  }));
  return { empty: false };
}
