export type NativeEngineAction =
  | 'status'
  | 'catalog'
  | 'describe'
  | 'inspect'
  | 'execute'
  | 'batch'
  | 'export'
  | 'render'
  | 'probe'
  | 'install';

export interface NativeEngineStep {
  id: string;
  params?: Record<string, unknown>;
}

export interface NativeEngineRequest {
  engine: string;
  action: NativeEngineAction;
  command?: string;
  params?: Record<string, unknown>;
  steps?: NativeEngineStep[];
  project?: string;
  saveAs?: string;
  save?: boolean;
  demo?: boolean;
  output?: string;
  preset?: string;
  format?: string;
  seconds?: number;
  scale?: number;
  quality?: number;
  range?: string;
  start?: number;
  end?: number;
  allowOffline?: boolean;
  keepGoing?: boolean;
  query?: string;
  open?: boolean;
  confirm?: boolean;
}

export interface NativeEngineContext {
  workspace: string;
  project?: string;
  saveAs?: string;
  save: boolean;
  demo: boolean;
  keepGoing: boolean;
}

export interface NativeEngineInvocation {
  args: string[];
  stdin?: string;
  artifacts: string[];
  timeoutMs: number;
}

export interface NativeEngineAdapter {
  id: string;
  label: string;
  envVar: string;
  binaryName: string;
  actions: readonly NativeEngineAction[];
  invoke(request: NativeEngineRequest, context: NativeEngineContext): NativeEngineInvocation;
}

export interface NativeEngineRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}
