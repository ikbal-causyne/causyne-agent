export declare class EntitlementAccessError extends Error {
  code: string;
  constructor(code: string, message: string);
}
export declare class EntitlementGate {
  enabled: boolean;
  begin(onBlocked?: (error: unknown) => void): Promise<void>;
  beforeStep(): Promise<void>;
  pause(): void;
  resume(): void;
  end(onBlocked?: (error: unknown) => void): void;
}
export declare function getProcessEntitlementGate(): EntitlementGate;
export declare function runLicenseCommand(action?: string, plan?: string): Promise<void>;
