// Local desktop home: chat, configuration and workspace reports.

import { SelectLayer, InputLayer } from './dialogs.js';
import { paint, dim, bold, badge, GLYPHS } from './theme.js';
import { runSetup } from './setup.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';

/** Local runtime and provider summary. */
export function homeStatusLine({ config = {} } = {}) {
  const hasProvider = Boolean(config.provider && config.provider !== 'unconfigured');
  const model = hasProvider
    ? (config.model ? `${config.provider}/${config.model}` : config.provider)
    : 'no provider configured';
  const configured = Boolean((hasProvider && config.apiKey) || config.provider === 'ollama');
  return '  ' + [
    paint('success', `${GLYPHS.bullet} local desktop`),
    configured
      ? dim(model)
      : (hasProvider ? paint('warn', `${model} — no key`) : paint('warn', 'no provider configured — run /setup'))
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
  { id: 'config', label: 'setup', hint: 'provider · endpoint · model · permissions', kind: 'config' },
  { id: 'more', label: 'more…', hint: 'sessions · model · approvals · tools', kind: 'more' }
];

/**
 * The second page.
 *
 * These are real local capabilities kept one level down so the first screen
 * stays readable while the complete command surface remains discoverable.
 */
export const MORE_ACTIONS = [
  { id: 'sessions', label: 'sessions', category: 'workspace', hint: 'browse saved local sessions', kind: 'command', command: '/sessions' },
  { id: 'model', label: 'model', category: 'workspace', hint: 'show the active provider and model', kind: 'command', command: '/model' },
  { id: 'approvals', label: 'approvals', category: 'workspace', hint: 'review standing session approvals', kind: 'command', command: '/approvals' },
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
  {
    id: 'creative', label: 'creative apps', category: 'tools', hint: 'check installed apps and adapter readiness', kind: 'stay',
    run: async () => {
      const { creativeAppStatus } = await import('../creative/apps.js');
      return (await creativeAppStatus()).map(app => `${app.label}: ${app.available ? 'available' : 'not connected'}\n  ${app.detail}`).join('\n');
    }
  },
  { id: 'mcp', label: 'mcp', category: 'tools', hint: 'manage MCP servers', kind: 'mcp' },
  { id: 'help', label: 'commands', category: 'tools', hint: 'show every slash command', kind: 'command', command: '/help' },
  {
    id: 'doctor', label: 'doctor', category: 'tools', hint: 'installation, runtime and update channel', kind: 'stay',
    run: async () => {
      const { diagnoseInstallation, formatDoctorReport } = await import('../autoUpdate.js');
      return formatDoctorReport(await diagnoseInstallation());
    }
  },
  {
    id: 'update', label: 'update', category: 'tools', hint: 'update to the latest version', kind: 'takeover',
    run: async () => {
      const { runSelfUpdate } = await import('../autoUpdate.js');
      await runSelfUpdate(true);
    }
  }
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
// Provider setup and MCP navigation
//
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

/** Run the shared setup transaction inside the existing prompt. */
export function configureInPrompt(prompt, store) {
  return runSetup({
    select: (options) => new Promise((resolve) => {
      const layer = new SelectLayer({ ...options, onPick: resolve });
      prompt.openLayer(layer);
    }),
    text: (options) => new Promise((resolve) => {
      prompt.openLayer(new InputLayer({ ...options, onSubmit: resolve, onCancel: () => resolve(null) }));
    })
  }, PROVIDERS, store);
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
      description: `${server.granted ? 'granted' : 'not granted'}${server.target ? ` ${GLYPHS.dot} ${server.target}` : ''}`,
      category: server.granted ? 'granted' : 'available',
      value: server
    })),
    onPick: (item) => { if (item) onAction(item.value); }
  }));
  return { empty: false };
}
