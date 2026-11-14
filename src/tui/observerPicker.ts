// Sovereign Interactive Cold Observer Setup & Picker — modal dialog for configuring Cold Observer.
// Authored in Strict TypeScript for Causyne Agent.
// Source-available under BUSL-1.1.

// @ts-expect-error untyped local TUI dialogs
import { SelectLayer, InputLayer, TextLayer } from './dialogs.js';
// @ts-expect-error untyped local TUI theme
import { paint, bold, dim, GLYPHS } from './theme.js';
import {
  coldObserver,
  type ObserverConfig,
  type ObserverMode,
  type ObserverStrictness,
  type ColdObserverAuditRecord
} from '../observer/coldObserver.js';

export interface ObserverPickerItemValue {
  action: 'toggle' | 'mode' | 'strictness' | 'endpoint' | 'model' | 'test' | 'audit' | 'reset';
  data?: string;
}

export interface ObserverPickerItem {
  id: string;
  label: string;
  category: string;
  description: string;
  searchText?: string;
  value: ObserverPickerItemValue;
}

export interface PromptHost {
  openLayer(layer: unknown): unknown;
  closeLayer(): void;
  draw(): void;
  notice?: string;
}

class DetailTextLayer extends TextLayer {
  private onDismiss?: (() => void) | undefined;
  private dismissed = false;

  constructor(options: {
    title: string;
    lines: string[];
    width?: number;
    height?: number;
    onDismiss?: () => void;
  }) {
    super(options);
    this.onDismiss = options.onDismiss;
  }

  answer(): void {
    if (this.dismissed) return;
    this.dismissed = true;
    if (this.onDismiss) this.onDismiss();
  }
}

/**
 * Build interactive menu items reflecting live Cold Observer configuration and state.
 */
export function buildObserverPickerItems(
  config: ObserverConfig,
  auditCount: number,
  vetoCount: number
): ObserverPickerItem[] {
  const items: ObserverPickerItem[] = [];

  // 1. Toggle Protection
  const activeStatus = config.enabled ? '[Active  ●]' : '[Disabled  ○]';
  const toggleAction = config.enabled ? 'Click to Turn OFF' : 'Click to Turn ON';
  items.push({
    id: 'toggle',
    label: `${activeStatus} — ${toggleAction}`,
    category: 'Protection Status',
    description: config.enabled
      ? 'Cold Observer is actively verifying tool mutations and completion claims'
      : 'Cold Observer is DISABLED — safety invariants and claim checks are disabled',
    searchText: 'toggle enable disable active status turn off turn on switch protection',
    value: { action: 'toggle' }
  });

  // 2. Review Mode
  const modeLabel = config.mode === 'advisory' ? 'ADVISORY (Neural loopback)' : 'DETERMINISTIC (Fast rules)';
  items.push({
    id: 'mode',
    label: `Review Mode: ${modeLabel}`,
    category: 'Configuration',
    description: config.mode === 'advisory'
      ? 'Uses local neural loopback endpoint to verify task claims'
      : 'Uses fast, zero-latency deterministic command & outcome analysis',
    searchText: 'mode deterministic advisory neural rules review verify',
    value: { action: 'mode' }
  });

  // 3. Strictness
  const strictnessLabel = config.strictness.toUpperCase();
  items.push({
    id: 'strictness',
    label: `Strictness: ${strictnessLabel}`,
    category: 'Configuration',
    description: config.strictness === 'strict'
      ? 'Strict: requires explicit test/build confirmation before declaring complete'
      : config.strictness === 'relaxed'
        ? 'Relaxed: minimal false vetoes; allows standard developer autonomy'
        : 'Standard: balanced oversight without false vetoes (recommended)',
    searchText: 'strictness standard strict relaxed level threshold safety',
    value: { action: 'strictness' }
  });

  // 4. Advisory Loopback Endpoint
  const endpointDisplay = config.endpoint || '(not configured)';
  items.push({
    id: 'endpoint',
    label: `Advisory Endpoint: ${endpointDisplay}`,
    category: 'Advisory Endpoint',
    description: 'Local loopback HTTP endpoint for neural verification (e.g. http://localhost:11434/v1 or none)',
    searchText: 'endpoint url loopback ollama localhost http address advisory',
    value: { action: 'endpoint' }
  });

  // 5. Advisory Model Name
  const modelDisplay = config.model || '(unset)';
  items.push({
    id: 'model',
    label: `Advisory Model: ${modelDisplay}`,
    category: 'Advisory Endpoint',
    description: 'Name of the local neural model (e.g. tiny, qwen, llama3, or none)',
    searchText: 'model name llama qwen tiny advisory neural',
    value: { action: 'model' }
  });

  // 6. Test Advisory Endpoint
  items.push({
    id: 'test',
    label: 'Test Advisory Endpoint (Health Probe)',
    category: 'Diagnostics',
    description: 'Probe loopback advisory endpoint and report latency and model readiness',
    searchText: 'test health check ping probe latency verify endpoint',
    value: { action: 'test' }
  });

  // 7. Audit History
  items.push({
    id: 'audit',
    label: `Audit History (${auditCount} events recorded, ${vetoCount} vetoes)`,
    category: 'Diagnostics',
    description: 'Inspect recent mutation reviews and safety veto records',
    searchText: 'audit history logs events vetoes inspect recent records',
    value: { action: 'audit' }
  });

  // 8. Reset to Defaults
  items.push({
    id: 'reset',
    label: 'Reset Configuration to Defaults',
    category: 'Actions',
    description: 'Restore enabled state, deterministic mode, standard strictness, and cleared endpoint',
    searchText: 'reset default restore factory clear settings',
    value: { action: 'reset' }
  });

  return items;
}

/**
 * Launch the Interactive Cold Observer Setup Modal in the live prompt.
 */
export function runInteractiveObserverPicker(prompt: PromptHost): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (msg: string): void => {
      if (settled) return;
      settled = true;
      resolve(msg);
    };

    function openMenu(): void {
      const cfg = coldObserver.getConfig();
      const audits = coldObserver.getAuditHistory();
      const vetoes = audits.filter((a: ColdObserverAuditRecord) => a.veto).length;
      const items = buildObserverPickerItems(cfg, audits.length, vetoes);

      const statusTag = cfg.enabled ? 'ACTIVE' : 'DISABLED';
      const selectLayer = new SelectLayer({
        title: `Cold Observer Setup (${statusTag} · ${cfg.mode.toUpperCase()})`,
        placeholder: 'Search observer settings...',
        emptyText: 'No matching observer settings found.',
        items,
        width: 76,
        height: 20,
        footer: `↑↓ choose  ${GLYPHS.dot}  enter toggle/edit  ${GLYPHS.dot}  esc finish`,
        onPick: (picked: ObserverPickerItem | null): string | void => {
          if (!picked) {
            prompt.closeLayer();
            const currentCfg = coldObserver.getConfig();
            finish(`Cold Observer is ${currentCfg.enabled ? 'ACTIVE' : 'DISABLED'} (${currentCfg.mode}, ${currentCfg.strictness}).`);
            return;
          }

          const action = picked.value.action;

          // 1. Toggle Protection (Synchronous in-place toggle with visual confirmation)
          if (action === 'toggle') {
            const current = coldObserver.getConfig();
            const newEnabled = !current.enabled;
            coldObserver.updateConfig({ enabled: newEnabled });
            prompt.notice = `Cold Observer is now ${newEnabled ? 'ACTIVE (Enabled)' : 'DISABLED (Inactive)'}`;
            refreshLayer();
            return 'keep';
          }

          // 2. Mode Toggle
          if (action === 'mode') {
            const current = coldObserver.getConfig();
            const nextMode: ObserverMode = current.mode === 'deterministic' ? 'advisory' : 'deterministic';
            coldObserver.updateConfig({ mode: nextMode });
            prompt.notice = `Cold Observer mode set to "${nextMode.toUpperCase()}"`;
            refreshLayer();
            return 'keep';
          }

          // 3. Strictness Cycle
          if (action === 'strictness') {
            const current = coldObserver.getConfig();
            let nextStrictness: ObserverStrictness = 'standard';
            if (current.strictness === 'standard') nextStrictness = 'strict';
            else if (current.strictness === 'strict') nextStrictness = 'relaxed';
            else nextStrictness = 'standard';

            coldObserver.updateConfig({ strictness: nextStrictness });
            prompt.notice = `Cold Observer strictness set to "${nextStrictness}"`;
            refreshLayer();
            return 'keep';
          }

          // 4. Advisory Endpoint Input
          if (action === 'endpoint') {
            const current = coldObserver.getConfig();
            prompt.openLayer(new InputLayer({
              title: 'Advisory Loopback Endpoint',
              placeholder: 'http://localhost:11434/v1 (or "none" to clear)',
              value: current.endpoint,
              lines: [
                'Enter local loopback endpoint URL for advisory neural verification.',
                'Only loopback URLs (localhost, 127.0.0.1) are accepted for security.',
                'Type "none" to clear the endpoint.'
              ],
              onSubmit: (val: string) => {
                const trimmed = val.trim();
                try {
                  coldObserver.updateConfig({ endpoint: trimmed === 'none' ? '' : trimmed });
                  prompt.notice = coldObserver.getConfig().endpoint
                    ? `Advisory endpoint set to ${coldObserver.getConfig().endpoint}`
                    : 'Advisory endpoint cleared';
                } catch (err) {
                  prompt.notice = err instanceof Error ? err.message : 'Invalid loopback endpoint';
                }
                openMenu();
              },
              onCancel: () => {
                openMenu();
              }
            }));
            return 'handled';
          }

          // 5. Advisory Model Input
          if (action === 'model') {
            const current = coldObserver.getConfig();
            prompt.openLayer(new InputLayer({
              title: 'Advisory Model Name',
              placeholder: 'model name (e.g. tiny, qwen2.5-coder) or "none"',
              value: current.model,
              lines: [
                'Enter local advisory model name served at the loopback endpoint.',
                'Type "none" to clear the model name.'
              ],
              onSubmit: (val: string) => {
                const trimmed = val.trim();
                coldObserver.updateConfig({ model: trimmed === 'none' ? '' : trimmed });
                prompt.notice = coldObserver.getConfig().model
                  ? `Advisory model set to ${coldObserver.getConfig().model}`
                  : 'Advisory model cleared';
                openMenu();
              },
              onCancel: () => {
                openMenu();
              }
            }));
            return 'handled';
          }

          // 6. Test Advisory Endpoint
          if (action === 'test') {
            void coldObserver.healthCheck().then((health) => {
              const textLines = health.endpoint
                ? [
                    `Endpoint: ${health.endpoint}`,
                    `Model:    ${health.model || '(unset)'}`,
                    `Status:   ${health.healthy ? 'HEALTHY' : 'UNREACHABLE'} (${health.latencyMs}ms latency)`,
                    `Detail:   ${health.detail}`,
                    '',
                    'Press Esc or Enter to return to Observer setup.'
                  ]
                : [
                    'No advisory endpoint configured.',
                    'The deterministic observer requires no endpoint and remains fully active.',
                    '',
                    'Press Esc or Enter to return to Observer setup.'
                  ];

              prompt.openLayer(new DetailTextLayer({
                title: 'Advisory Endpoint Health Check',
                lines: textLines,
                width: 70,
                height: 12,
                onDismiss: () => openMenu()
              }));
            });
            return 'handled';
          }

          // 7. Audit History
          if (action === 'audit') {
            const recentAudits = coldObserver.getAuditHistory();
            const lines = recentAudits.length === 0
              ? ['No Cold Observer audit records yet.', '', 'Press Esc or Enter to return to Observer setup.']
              : recentAudits.slice(-12).map((a: ColdObserverAuditRecord) => {
                  const dt = typeof a.timestamp === 'number' && Number.isFinite(a.timestamp) ? new Date(a.timestamp) : null;
                  const time = dt && Number.isFinite(dt.getTime()) ? dt.toLocaleTimeString() : '--:--:--';
                  const tag = a.type === 'mutation' ? `[mutation ${a.tool || ''}]` : '[verification]';
                  const score = typeof a.riskScore === 'number' && Number.isFinite(a.riskScore)
                    ? `(${(a.riskScore * 100).toFixed(0)}% risk)`
                    : '';
                  const veto = a.veto ? paint('danger', 'VETO') : paint('success', 'PASS');
                  return `${time} ${tag} ${veto} ${score} ${a.details}`;
                });

            prompt.openLayer(new DetailTextLayer({
              title: `Cold Observer Audits (Last ${Math.min(12, recentAudits.length)})`,
              lines,
              width: 76,
              height: 18,
              onDismiss: () => openMenu()
            }));
            return 'handled';
          }

          // 8. Reset Defaults
          if (action === 'reset') {
            coldObserver.updateConfig({
              enabled: true,
              mode: 'deterministic',
              endpoint: '',
              model: '',
              timeoutMs: 800,
              strictness: 'standard'
            });
            prompt.notice = 'Cold Observer reset to default settings';
            refreshLayer();
            return 'keep';
          }

          return;
        }
      });

      function refreshLayer(): void {
        const updatedCfg = coldObserver.getConfig();
        const updatedAudits = coldObserver.getAuditHistory();
        const updatedVetoes = updatedAudits.filter((a: ColdObserverAuditRecord) => a.veto).length;
        const newItems = buildObserverPickerItems(updatedCfg, updatedAudits.length, updatedVetoes);
        selectLayer.title = `Cold Observer Setup (${updatedCfg.enabled ? 'ACTIVE' : 'DISABLED'} · ${updatedCfg.mode.toUpperCase()})`;
        selectLayer.list.setItems(newItems);
        prompt.draw();
      }

      prompt.openLayer(selectLayer);
    }

    openMenu();
  });
}
