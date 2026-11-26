import { loadConfig, saveConfig } from '../config.js';
import { getAvailableProvidersOverview, getLiveAntigravityModels, getModelVariantsForPeer } from '../dynamicCatalogue.js';
import { resolveModelVariants } from '../modelVariants.js';
import { isAcpProvider } from '../providers/acp.js';
import { writeClipboardSync } from './clipboardSync.js';
import { SelectLayer } from './dialogs.js';
import { looksSensitive } from './history.js';

interface ControlPrompt {
  openLayer(layer: unknown): void;
  deliver(command: string): boolean;
  scheduleDraw(): void;
  notice: string;
}

interface ControlLoop {
  config: Record<string, unknown>;
  setAutonomyMode(mode: string): void;
}

export function openModeControl(prompt: ControlPrompt, loop: ControlLoop): void {
  const config = loadConfig();
  const current = String(config.autonomyMode || 'B').toUpperCase();
  prompt.openLayer(new SelectLayer({
    title: 'Autonomy mode',
    items: [
      { id: 'A', label: 'A · Ask', description: 'Review actions before execution', value: 'A' },
      { id: 'B', label: 'B · Balanced', description: 'Work independently within permission boundaries', value: 'B' },
      { id: 'C', label: 'C · Autonomous', description: 'Continue within the selected workspace and policy', value: 'C' }
    ].map(item => ({ ...item, label: `${item.label}${item.value === current ? '  (active)' : ''}` })),
    onPick: (item: { value?: string } | null) => {
      if (!item?.value) return;
      config.autonomyMode = item.value;
      saveConfig(config);
      loop.setAutonomyMode(item.value);
      (prompt as any).renderer?.status?.setSession?.({ autonomyMode: item.value });
      (prompt as any).surface?.setSessionInfo?.({ autonomyMode: item.value });
      prompt.notice = `Mode ${item.value} active`;
      prompt.scheduleDraw();
    }
  }));
}

function splitModelVariant(model: string): { base: string; variant: string } | null {
  if (!model.endsWith(')')) return null;
  const openIndex = model.lastIndexOf(' (');
  if (openIndex < 0) return null;
  const variant = model.slice(openIndex + 2, -1);
  if (!variant || variant.includes('(') || variant.includes(')')) return null;
  return { base: model.slice(0, openIndex), variant };
}

/** Only offer sibling variants the selected provider actually advertises. */
export function availableModelVariants(config: Record<string, unknown>): string[] {
  if (!config || typeof config !== 'object') return [];
  const current = typeof config.model === 'string' ? config.model : String(config.model ?? '');
  const parsed = splitModelVariant(current);
  if (!parsed) return [];
  const overview = getAvailableProvidersOverview(config);
  const provider = typeof config.provider === 'string' ? config.provider : String(config.provider ?? '');
  const advertised = overview.acp.find(peer => peer.providerKey === provider)?.models
    ?? overview.byok.find(item => item.id === provider)?.models
    ?? [];
  return advertised.filter(model => splitModelVariant(model)?.base === parsed.base);
}

export function cycleModeControl(prompt: ControlPrompt, loop: ControlLoop): void {
  const config = loadConfig();
  const order = ['A', 'B', 'C'] as const;
  const current = String(loop?.config?.autonomyMode || config.autonomyMode || 'B').toUpperCase();
  const idx = order.indexOf(current as (typeof order)[number]);
  const next = order[(idx + 1) % order.length]!;
  config.autonomyMode = next;
  saveConfig(config);
  loop.setAutonomyMode(next);
  (prompt as any).renderer?.status?.setSession?.({ autonomyMode: next });
  (prompt as any).surface?.setSessionInfo?.({ autonomyMode: next });
  const labels: Record<string, string> = { A: 'Ask', B: 'Balanced', C: 'Autonomous' };
  prompt.notice = `Mode ${next} · ${labels[next]} (Shift+Tab cycle · Ctrl+G menu)`;
  prompt.scheduleDraw();
}

function resolveVariantSpecForControl(config: Record<string, any>, loop?: any) {
  const provider = typeof config.provider === 'string' ? config.provider.trim() : '';
  const model = typeof config.model === 'string' ? config.model.trim() : '';
  const liveAcpVariant = typeof loop?.llm?.getLiveVariantOption === 'function'
    ? loop.llm.getLiveVariantOption()
    : null;
  let ollamaSupportsThinking: boolean | null = null;
  if (provider.toLowerCase() === 'ollama' && loop?.llm) {
    const metaCache = (loop.llm as any)._modelMetaCache as Map<string, { supportsThinking?: boolean }> | undefined;
    const cachedMeta = metaCache?.get(model);
    if (cachedMeta && typeof cachedMeta.supportsThinking === 'boolean') {
      ollamaSupportsThinking = cachedMeta.supportsThinking;
    }
  }
  const providerLower = provider.toLowerCase();
  const liveAgyModels = (providerLower.includes('antigravity') || providerLower === 'agy')
    ? getLiveAntigravityModels(config)
    : undefined;
  const peerModelVariants = isAcpProvider(provider)
    ? getModelVariantsForPeer(provider, model, config)
    : undefined;

  return resolveModelVariants({
    provider,
    model,
    currentVariant: typeof config.reasoningEffort === 'string' ? config.reasoningEffort : null,
    liveAcpVariant,
    peerModelVariants,
    ollamaSupportsThinking,
    availableAgyModels: liveAgyModels && liveAgyModels.length > 0 ? liveAgyModels : undefined
  });
}

export function cycleVariantControl(prompt: ControlPrompt, loop?: any): void {
  const config = loadConfig();
  const spec = resolveVariantSpecForControl(config, loop);

  if (!spec.supported || spec.options.length === 0) {
    prompt.notice = spec.note || 'Active model does not expose tunable reasoning variants';
    prompt.scheduleDraw();
    return;
  }

  const cycleValues = spec.source === 'agy_models'
    ? spec.options.map((o) => o.id)
    : [...spec.options.map((o) => o.id), 'auto'];
  const currentId = (typeof config.reasoningEffort === 'string' && config.reasoningEffort.trim())
    ? config.reasoningEffort.trim().toLowerCase()
    : (spec.source === 'agy_models' && spec.currentVariant ? spec.currentVariant.toLowerCase() : 'auto');
  const currentIdx = cycleValues.findIndex((v) => v.toLowerCase() === currentId);
  const nextIdx = (currentIdx + 1) % cycleValues.length;
  const nextVal = cycleValues[nextIdx]!;

  prompt.deliver(`/variant ${nextVal}`);
  const positionLabel = nextVal === 'auto'
    ? 'auto (default)'
    : `${nextVal} (${nextIdx + 1}/${spec.options.length})`;
  prompt.notice = `Variant: ${positionLabel} · Ctrl+T cycle · Alt+T list`;
  prompt.scheduleDraw();
}

export function openVariantControl(prompt: ControlPrompt, loop?: any): void {
  const config = loadConfig();
  const spec = resolveVariantSpecForControl(config, loop);

  if (!spec.supported || spec.options.length === 0) {
    prompt.notice = spec.note || 'Active model does not expose tunable reasoning variants';
    prompt.scheduleDraw();
    return;
  }

  const sourceLabel = spec.source === 'acp_live'
    ? 'ACP Live'
    : (spec.source === 'peer_catalogue'
      ? 'Peer Catalogue'
      : (spec.source === 'agy_models' ? 'Antigravity' : (spec.source === 'ollama_live' ? 'Ollama Local' : 'Detected')));

  const items = [
    ...spec.options.map((opt) => {
      const isActive = Boolean(spec.currentVariant && opt.id.toLowerCase() === spec.currentVariant.toLowerCase());
      return {
        id: opt.id,
        label: `${isActive ? '● ' : '  '}${opt.label} (${opt.id})`,
        description: opt.description,
        category: `${spec.model || spec.provider} — ${sourceLabel}`,
        value: opt.id
      };
    }),
    {
      id: 'auto',
      label: `${!spec.currentVariant ? '● ' : '  '}Auto (model default)`,
      description: spec.defaultVariant ? `Use model default (${spec.defaultVariant})` : 'Reset explicit variant override',
      category: 'Reset',
      value: 'auto'
    }
  ];

  prompt.openLayer(new SelectLayer({
    title: `Variant · ${spec.model || spec.provider || 'Model'}`,
    items,
    showFilter: items.length > 6,
    onPick: (item: { value?: string } | null) => {
      if (!item?.value) return;
      prompt.deliver(`/variant ${item.value}`);
      prompt.notice = item.value === 'auto' ? 'Variant reset to auto' : `Variant set to ${item.value}`;
      prompt.scheduleDraw();
    }
  }));
}

export interface InterruptiblePrompt {
  busy: boolean;
  interruptedTurn?: boolean;
  lastCtrlC: number;
  notice: string;
  statusMessage: string;
  queue?: unknown[];
  completion: unknown;
  editor: {
    isEmpty: boolean;
    getText(): string;
    clear(): void;
  };
  erase(): void;
  commit(kind: string, produce: (width: number) => string[]): void;
  onInterrupt(): void;
  onExit(): void;
  scheduleDraw(): void;
}

export function resetTurnInterruptState(
  prompt: { interruptedTurn?: boolean; statusMessage?: string; notice?: string },
  busy: boolean
): void {
  prompt.interruptedTurn = false;
  if (!busy) {
    prompt.statusMessage = '';
    prompt.notice = '';
  }
}

export function shouldAcceptStatusUpdate(
  prompt: { busy?: boolean; interruptedTurn?: boolean }
): boolean {
  return !(prompt.busy && prompt.interruptedTurn);
}

export function triggerTurnInterrupt(
  prompt: InterruptiblePrompt,
  formatInterruptedRow: () => string[],
  options: { viaCtrlC?: boolean } = {}
): void {
  if (Array.isArray(prompt.queue)) {
    prompt.queue.length = 0;
  }
  prompt.statusMessage = 'interrupting…';
  if (!prompt.interruptedTurn) {
    prompt.interruptedTurn = true;
    prompt.erase();
    prompt.commit('notice', () => formatInterruptedRow());
    prompt.notice = options.viaCtrlC ? 'interrupting… press Ctrl+C again to exit' : '';
  } else {
    prompt.notice = 'interrupting… press Ctrl+C again to exit';
  }
  prompt.onInterrupt();
  prompt.scheduleDraw();
}

export function handlePromptCtrlC(
  prompt: InterruptiblePrompt,
  formatInterruptedRow: () => string[],
  windowMs = 2000,
  now = Date.now()
): void {
  if (!prompt.editor.isEmpty) {
    const text = prompt.editor.getText();
    const isSecret = Boolean(text && looksSensitive(text));
    if (text && !isSecret) {
      writeClipboardSync(text);
      if ('killRing' in prompt.editor) {
        (prompt.editor as { killRing?: string }).killRing = text;
      }
    }
    prompt.editor.clear();
    prompt.completion = null;
    prompt.notice = !text
      ? ''
      : (isSecret ? 'cleared (secret not copied to clipboard)' : 'cleared and copied to clipboard');
    return;
  }
  if (prompt.busy) {
    if (prompt.interruptedTurn && now - prompt.lastCtrlC < windowMs) {
      prompt.onInterrupt();
      prompt.onExit();
      return;
    }
    prompt.lastCtrlC = now;
    triggerTurnInterrupt(prompt, formatInterruptedRow, { viaCtrlC: true });
    return;
  }
  if (now - prompt.lastCtrlC < windowMs) {
    prompt.onExit();
    return;
  }
  prompt.lastCtrlC = now;
  prompt.notice = 'press Ctrl+C again to exit';
}

export function handlePromptEscape(
  prompt: InterruptiblePrompt,
  formatInterruptedRow: () => string[]
): void {
  if ((prompt as any).surface?.hoveredTurnIndex !== null && (prompt as any).surface?.hoveredTurnIndex !== undefined) {
    (prompt as any).surface.hoveredTurnIndex = null;
    (prompt as any).surface.hoveredTurnAnchorY = null;
    prompt.scheduleDraw();
    return;
  }
  if ((prompt as any).usageCard || (prompt as any).usageCardLoading) {
    if (typeof (prompt as any).closeUsageCard === 'function') (prompt as any).closeUsageCard();
    else {
      (prompt as any).usageCard = null;
      prompt.scheduleDraw();
    }
    return;
  }
  if ((prompt as any).statusCard !== null && (prompt as any).statusCard !== undefined) {
    if (typeof (prompt as any).closeStatusCard === 'function') (prompt as any).closeStatusCard();
    else {
      (prompt as any).statusCard = null;
      prompt.scheduleDraw();
    }
    return;
  }
  if (prompt.completion) {
    prompt.completion = null;
    if (prompt.editor.getText().startsWith('/')) {
      prompt.editor.clear();
    }
    prompt.scheduleDraw();
    return;
  }
  if (prompt.busy) {
    triggerTurnInterrupt(prompt, formatInterruptedRow, { viaCtrlC: false });
    return;
  }
  prompt.editor.clear();
}
