export type PermissionPresetId = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface PermissionPresetItem {
  readonly id: PermissionPresetId;
  readonly label: string;
  readonly description: string;
  readonly autonomyMode: 'A' | 'B' | 'C';
  readonly readOnly: boolean;
  readonly requiresRiskConfirmation: boolean;
}

export interface ArtifactVersion {
  version: number;
  content: string;
  at: number;
}

export interface SessionSummary {
  id: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  messageCount?: number;
  running?: boolean;
  awaitingClient?: boolean;
}

export interface SessionWorkspaceSnapshot {
  studioOpen: boolean;
  studioTab: string;
  canvasPath: string;
  canvasContent: string;
  canvasPreviewMode: boolean;
  canvasStatus: string;
  canvasDirty: boolean;
  diffScope: 'session' | 'workspace';
  diffStaged: boolean;
  attachments: string[];
  draftPrompt: string;
  usageTokens: number;
  browserEngine: 'agent' | 'frame';
  browserMode: 'empty' | 'url' | 'srcdoc';
  browserUrl: string;
  browserSrcdoc: string;
  cliConsoleText: string;
  cliStatusText: string;
}

export interface ModelItemValue {
  type?: string;
  action?: string;
  isToggle?: boolean;
  peerKey?: string;
  providerId?: string;
  modelId?: string;
  providerLabel?: string;
  envVar?: string;
  setupInstruction?: string;
  installed?: boolean;
  isCurrent?: boolean;
  isConfigured?: boolean;
}

export interface ModelPickerItem {
  id?: string;
  label?: string;
  category?: string;
  description?: string;
  value?: ModelItemValue;
}

export interface ModelsResponse {
  activeProvider?: string;
  activeModel?: string;
  initialTab?: 'acp' | 'byok' | 'free';
  tabs?: Record<string, ModelPickerItem[]>;
}

export interface CliCommandEntry {
  name: string;
  aliases?: string[];
  usage?: string;
  description?: string;
}

export interface WorkspaceEntry {
  path: string;
  name: string;
  type: 'dir' | 'file';
  size?: number;
}

export interface MentionEntry {
  name?: string;
  path?: string;
  description?: string;
}

export interface BrowserTabInfo {
  tabId: string;
  title?: string;
  url?: string;
  active?: boolean;
}

export interface BrowserAgentActivityState {
  active?: boolean;
  tool?: string;
  detail?: string;
}

export interface LiveBrowserFramePayload {
  type?: string;
  active?: boolean;
  visible?: boolean;
  engine?: string | null;
  enginePreference?: string;
  enginesAvailable?: { camoufox?: boolean; chromium?: boolean };
  streamMode?: string;
  fps?: number;
  controlOwner?: string;
  width?: number;
  height?: number;
  url?: string;
  imageBase64?: string;
  mimeType?: string;
  tabs?: BrowserTabInfo[];
  agentActivity?: BrowserAgentActivityState;
  snapshot?: string;
  refsCount?: number;
  syncedUrl?: string;
  importedUrls?: string[];
  importedCookies?: number;
  error?: string;
}

export interface RestoredStep {
  tool?: string;
  target?: string;
  status?: string;
  output?: string;
}

export interface RestoredBlock {
  kind: 'reasoning' | 'steps' | 'text';
  content?: string;
  steps?: RestoredStep[];
}

export interface DecisionOption {
  id?: string;
  label?: string;
  description?: string;
}

export interface DecisionRequestPayload {
  id?: string;
  question?: string;
  options?: DecisionOption[];
}

export interface PlanItemPayload {
  status?: string;
  text?: string;
  step?: string;
}

export interface StreamEventPayload {
  type?: string;
  sessionId?: string;
  title?: string;
  delta?: string;
  content?: string;
  streaming?: boolean;
  elapsedMs?: number;
  plan?: PlanItemPayload[];
  explanation?: string;
  message?: string;
  activity?: string;
  tool?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  success?: boolean;
  error?: string;
  summary?: string;
  output?: string;
  result?: Record<string, unknown>;
  id?: string;
  path?: string;
  code?: string;
  phase?: string;
  operation?: string;
  request?: DecisionRequestPayload;
  totalTokens?: number;
  sessionTokens?: number;
  promptTokens?: number;
  nativeStep?: boolean;
  nativeFailed?: boolean;
  actionName?: string;
  detail?: string;
}

export interface AssistantTurnHandle {
  setActivity(active: boolean, label: string): void;
  appendText(delta: string): void;
  setText(full: string, streaming: boolean): void;
  updateReasoning(ev: StreamEventPayload): void;
  renderRestoredBlocks(blocks: RestoredBlock[]): void;
  updatePlan(ev: StreamEventPayload): void;
  addStepStart(ev: StreamEventPayload): void;
  addStepEnd(ev: StreamEventPayload, failed: boolean): void;
  addNativeStep(ev: StreamEventPayload, failed: boolean): void;
  upsertCodeProgress(ev: StreamEventPayload): void;
  addApproval(ev: StreamEventPayload): void;
  addDecision(reqObj: DecisionRequestPayload): void;
  addNotice(msg: string): void;
  addError(msg: string, retryText?: string, code?: string): void;
  addInterrupted(msg: string, retryText?: string): void;
  finish(): void;
}

export interface WorkspaceFileHrefInfo {
  fullPath: string;
  relPath: string | null;
  display: string;
  lineBadge: string;
}

export interface AvailableShellPayload {
  id: string;
  label: string;
  path: string;
  isDefault: boolean;
}

export interface TerminalSessionPayload {
  id: string;
  name: string;
  shell: string;
  shellLabel: string;
  cwd: string;
  origin: 'user' | 'agent';
  control: 'user' | 'agent';
  transport: 'pty' | 'pipe';
  status: 'running' | 'exited';
  exitCode: number | null;
  cols: number;
  rows: number;
  createdAt: number;
  lastActivityAt: number;
  scrollbackBytes: number;
}

export interface AppState {
  sessionId: string | null;
  sessions: SessionSummary[];
  models: ModelsResponse | null;
  modelTab: 'acp' | 'byok' | 'free' | null;
  modelQuery: string;
  modelExpandedPeers: Set<string>;
  modelSelectedIndex: number;
  modelRefreshing: boolean;
  modelLiveHydrated: boolean;
  modelNotice: string;
  activeProvider: string;
  activeModel: string;
  permissionPreset: PermissionPresetId;
  defaultPermissionPreset: PermissionPresetId;
  workspaceRoot: string;
  lastScrollTop: number;
  attachments: string[];
  currentDir: string;
  parentDir: string;
  studioTab: string;
  studioSplit: boolean;
  studioSecondaryTab: string;
  studioExpanded: boolean;
  studioWidth: number;
  terminalSessions: TerminalSessionPayload[];
  activeTerminalId: string | null;
  availableShells: AvailableShellPayload[];
  canvasPreviewMode: boolean;
  canvasDirty: boolean;
  artifactVersions: Map<string, ArtifactVersion[]>;
  sessionWorkspaces: Map<string, SessionWorkspaceSnapshot>;
  sessionSwitchSeq: number;
  usageTokens: number;
  diffScope: 'session' | 'workspace';
  browserEngine: 'agent' | 'frame';
  browserMode: 'empty' | 'url' | 'srcdoc';
  browserUrl: string;
  browserSrcdoc: string;
  browserViewport: string;
  liveBrowserActive: boolean;
  liveBrowserVisible: boolean;
  liveBrowserRuntime: string | null;
  liveBrowserPref: string;
  liveStreamMode: string;
  liveStreamAbort: AbortController | null;
  liveStreamConnected: boolean;
  liveFps: number;
  pointerDragging: boolean;
  liveBrowserWidth: number;
  liveBrowserHeight: number;
  controlOwner: 'human' | 'agent';
  cliCommands: CliCommandEntry[];
  mentionMode: 'file' | 'command';
  mentionItems: MentionEntry[];
  mentionIndex: number;
  mentionStart: number;
  diffStaged: boolean;
  isComposing: boolean;
  stickToBottom: boolean;
  activeController: AbortController | null;
  activeTurn: AssistantTurnHandle | null;
  activePrompt: string;
  gameStatus: Record<string, unknown> | null;
  gameLaunching: boolean;
}
