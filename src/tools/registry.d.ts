export const TOOL_DEFINITIONS: any;
export function getDynamicTools(...args: any[]): any;
export function resolveTool(...args: any[]): any;
export function canonicalToolName(...args: any[]): any;
export function getSearchableToolDefinitions(): Promise<Array<{ name: string; description?: string; parameters?: import('./toolSelfRepair.js').ParameterSchema }>>;
