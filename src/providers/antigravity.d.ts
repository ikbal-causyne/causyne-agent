export const BASELINE_ANTIGRAVITY_MODELS: Record<string, string>;
export const ANTIGRAVITY_MODELS: string[];
export const ANTIGRAVITY_MODEL_IDS: Record<string, string>;
export const ANTIGRAVITY_LABEL_BY_ID: Record<string, string>;
export function registerAntigravityModel(slug: string, label?: string): void;
export function parseAgyModelsOutput(stdout: string): Array<{ id: string; label: string }>;
export function resolveAgyModelId(model: string | null | undefined): string;
export function resolveAgyEffort(model: string | null | undefined): string;
export function isAntigravityProvider(provider: string | null | undefined): boolean;
export function resolveAgyBinary(): string;
export class AntigravityProvider {
  constructor(config?: Record<string, unknown>);
}
