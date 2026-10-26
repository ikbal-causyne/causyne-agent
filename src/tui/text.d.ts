export function safeDisplay(value: string): string;
export function truncate(value: string, width: number, ellipsis?: string): string;
export function padEnd(value: string, width: number): string;
export function visibleWidth(value: string): number;
export function wrap(value: string, width: number, options?: { hang?: number }): string[];
export function wrapBlock(value: string, width: number, options?: { hang?: number }): string[];
