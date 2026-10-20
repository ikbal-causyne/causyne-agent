export interface CapabilityVerdict {
  ok: boolean;
  group: string;
  reason?: string;
  requiresConsent?: boolean;
}

export function ensureCapability(group: string): Promise<CapabilityVerdict>;
export function loadCapabilityPackage(packageName: string): Promise<unknown>;
export function capabilityDirectory(): string;
