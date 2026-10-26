import { loadConfig, saveConfig } from '../config.js';
import { getAvailableProvidersOverview } from '../dynamicCatalogue.js';
// @ts-expect-error dialogs.js is awaiting TypeScript migration.
import { SelectLayer } from './dialogs.js';

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
      prompt.notice = `Mode ${item.value} active`;
      prompt.scheduleDraw();
    }
  }));
}

/** Only offer sibling variants the selected provider actually advertises. */
export function availableModelVariants(config: Record<string, unknown>): string[] {
  const current = String(config.model || '');
  const match = current.match(/^(.*)\s\(([^()]+)\)$/);
  if (!match) return [];
  const overview = getAvailableProvidersOverview(config);
  const provider = String(config.provider || '');
  const advertised = overview.acp.find(peer => peer.providerKey === provider)?.models
    ?? overview.byok.find(item => item.id === provider)?.models
    ?? [];
  return advertised.filter(model => {
    const sibling = model.match(/^(.*)\s\(([^()]+)\)$/);
    return sibling?.[1] === match[1];
  });
}

export function openVariantControl(prompt: ControlPrompt): void {
  const config = loadConfig();
  const variants = availableModelVariants(config);
  if (variants.length < 2) {
    prompt.notice = 'This provider has no advertised model variants';
    prompt.scheduleDraw();
    return;
  }
  prompt.openLayer(new SelectLayer({
    title: 'Model variant',
    items: variants.map(model => ({
      id: model,
      label: `${model}${model === config.model ? '  (active)' : ''}`,
      description: String(config.provider || ''),
      value: model
    })),
    onPick: (item: { value?: string } | null) => {
      if (!item?.value || item.value === config.model) return;
      prompt.deliver(`/model ${String(config.provider)}/${item.value}`);
      prompt.notice = 'Model variant change queued';
      prompt.scheduleDraw();
    }
  }));
}
