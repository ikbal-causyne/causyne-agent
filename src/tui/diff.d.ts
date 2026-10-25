export type DiffLine = { kind: 'ctx' | 'add' | 'del'; text: string };
export function diffLines(before: string, after: string): { ops: DiffLine[]; truncated: boolean };
