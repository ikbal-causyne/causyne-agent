export const desktopAct: {
  schema: Record<string, unknown>;
  execute(args?: Record<string, unknown>, context?: Record<string, unknown>): Promise<{
    success: boolean;
    output?: string;
    error?: string;
    requiresConsent?: boolean;
    useToolInstead?: string;
  }>;
};
