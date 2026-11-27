import { copyText, dom } from './dom.js';
import { apiUrl, authHeaders, scrollToBottom, setStageMode, state } from './state.js';
import { openStudio } from './studioShell.js';
import { openInCanvas } from './filesAndCanvas.js';
import type { CliCommandEntry } from './types.js';

const QUICK_CLI_COMMANDS: readonly string[] = [
  '/status', '/doctor', '/map', '/rules', '/checkpoints', '/undo',
  '/worktree list', '/pr', '/tasks', '/mcp', '/skills', '/peers',
  '/plugins', '/slop', '/policy', '/audit', '/eval'
];

export interface CliPanelCallbacks {
  startFreshChat(): Promise<void>;
  appendUserTurn(prompt: string, attachments: string[], animate?: boolean): void;
  loadHealth(): Promise<void>;
}

let callbacks: CliPanelCallbacks = {
  startFreshChat: async () => {},
  appendUserTurn: () => {},
  loadHealth: async () => {}
};

export function configureCliPanelCallbacks(cbs: CliPanelCallbacks): void {
  callbacks = cbs;
}

export function renderCliQuickGrid(): void {
  dom.cliQuickGrid.textContent = '';
  for (const cmd of QUICK_CLI_COMMANDS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cli-chip';
    btn.textContent = cmd;
    btn.addEventListener('click', () => { void runCliCommand(cmd, 'studio'); });
    dom.cliQuickGrid.appendChild(btn);
  }
}

export async function loadCliCommands(): Promise<void> {
  const res = await fetch(apiUrl('/api/commands'), { headers: authHeaders() }).catch(() => null);
  if (!res || !res.ok) return;
  const data = await res.json() as { commands?: CliCommandEntry[] };
  state.cliCommands = data.commands || [];
}

export async function loadCliOverview(): Promise<void> {
  const res = await fetch(apiUrl('/api/cli/overview'), { headers: authHeaders() }).catch(() => null);
  if (!res || !res.ok) return;
  const d = await res.json() as {
    commandsCount?: number;
    skillsCount?: number;
    checkpoints?: unknown[];
    mcpServers?: unknown[];
    tasks?: unknown[];
  };
  const parts = [
    `${d.commandsCount || 0} commands`,
    `${d.skillsCount || 0} skills`
  ];
  const cps = (d.checkpoints || []).length;
  if (cps > 0) parts.push(`${cps} checkpoints`);
  const mcps = (d.mcpServers || []).length;
  if (mcps > 0) parts.push(`${mcps} MCP`);
  const tasks = (d.tasks || []).length;
  if (tasks > 0) parts.push(`${tasks} running`);
  dom.cliStatsEl.textContent = parts.join(' · ');
}

function appendCliTurnCard(cmdLine: string, title: string, output: string, ok: boolean): void {
  setStageMode(true);
  const turn = document.createElement('div');
  turn.className = 'turn assistant';
  const card = document.createElement('div');
  card.className = 'cli-turn-card';
  const head = document.createElement('div');
  head.className = 'cli-turn-head';
  const left = document.createElement('span');
  left.textContent = (title || cmdLine) + (ok ? '' : ' (failed)');
  if (!ok) left.style.color = 'var(--err)';
  const right = document.createElement('div');
  right.style.display = 'inline-flex';
  right.style.gap = '6px';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'code-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => copyText(output || '', copyBtn));
  const canvasBtn = document.createElement('button');
  canvasBtn.type = 'button';
  canvasBtn.className = 'code-btn';
  canvasBtn.textContent = 'Canvas';
  canvasBtn.addEventListener('click', () => openInCanvas('cli-output.md', output || '', false));
  right.appendChild(copyBtn);
  right.appendChild(canvasBtn);
  head.appendChild(left);
  head.appendChild(right);
  const pre = document.createElement('pre');
  pre.className = 'cli-turn-body';
  pre.textContent = output || '(no output)';
  card.appendChild(head);
  card.appendChild(pre);
  turn.appendChild(card);
  dom.threadEl.appendChild(turn);
  scrollToBottom(true);
}

export async function runCliCommand(rawInput: string, target: 'studio' | 'chat'): Promise<void> {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) return;
  if (trimmed === '/new' || trimmed === '/clear') { await callbacks.startFreshChat(); return; }
  if (trimmed === '/browser') { openStudio('browser'); return; }
  if (trimmed === '/diff') { openStudio('diff'); }
  if (target === 'studio') {
    dom.cliStatusEl.textContent = `Running ${trimmed}...`;
    dom.cliConsoleEl.textContent = `Executing ${trimmed}...`;
  } else {
    callbacks.appendUserTurn(trimmed, []);
  }
  const res = await fetch(apiUrl('/api/command'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ input: trimmed })
  }).catch(() => null);
  if (!res) {
    if (target === 'studio') dom.cliConsoleEl.textContent = 'Command request failed.';
    else appendCliTurnCard(trimmed, trimmed, 'Command request failed.', false);
    return;
  }
  const data = await res.json().catch(() => ({ ok: false, output: `HTTP ${res.status}` })) as {
    ok?: boolean;
    title?: string;
    output?: string;
    error?: string;
  };
  const outText = data.output || data.error || '(done)';
  if (target === 'studio') {
    dom.cliConsoleEl.textContent = outText;
    dom.cliStatusEl.textContent = (data.ok ? 'OK · ' : 'Failed · ') + trimmed;
    void loadCliOverview();
  } else {
    appendCliTurnCard(trimmed, data.title || trimmed, outText, Boolean(data.ok));
  }
  void callbacks.loadHealth();
}

export async function runZeroSpendProbe(): Promise<void> {
  dom.cliStatusEl.textContent = 'Testing connections...';
  dom.cliConsoleEl.textContent = 'Checking local Ollama and configured providers...';
  const res = await fetch(apiUrl('/api/doctor/probe'), { method: 'POST', headers: authHeaders() }).catch(() => null);
  if (!res || !res.ok) { dom.cliConsoleEl.textContent = 'Connection test failed.'; return; }
  const data = await res.json() as { report?: string; summary?: { passedCount?: number } };
  dom.cliConsoleEl.textContent = data.report || 'Completed.';
  dom.cliStatusEl.textContent = `${data.summary?.passedCount || 0} connected`;
}

export function bindCliPanelEvents(): void {
  dom.cliRunBtn.addEventListener('click', () => {
    void runCliCommand(dom.cliCmdInput.value, 'studio');
    dom.cliCmdInput.value = '';
  });
  dom.cliCmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void runCliCommand(dom.cliCmdInput.value, 'studio');
      dom.cliCmdInput.value = '';
    }
  });
  dom.cliProbeBtn.addEventListener('click', () => { void runZeroSpendProbe(); });
}
