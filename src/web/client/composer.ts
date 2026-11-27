import { dom } from './dom.js';
import { apiUrl, authHeaders, state, updateComposerMetrics } from './state.js';
import type { WorkspaceEntry } from './types.js';

export interface ComposerCallbacks {
  submitPrompt(promptText: string, attachList: string[]): Promise<void>;
  stopActiveRun(): Promise<void>;
  runCliCommand(rawInput: string, target: 'studio' | 'chat'): Promise<void>;
}

let callbacks: ComposerCallbacks = {
  submitPrompt: async () => {},
  stopActiveRun: async () => {},
  runCliCommand: async () => {}
};

export function configureComposerCallbacks(cbs: ComposerCallbacks): void {
  callbacks = cbs;
}

export function renderAttachmentChips(): void {
  dom.composerChipsEl.textContent = '';
  dom.composerChipsEl.classList.toggle('has-items', state.attachments.length > 0);
  for (const rel of state.attachments) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const label = document.createElement('span');
    label.textContent = `@${rel}`;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = 'x';
    rm.setAttribute('aria-label', `Remove ${rel}`);
    rm.addEventListener('click', () => {
      state.attachments = state.attachments.filter((item) => item !== rel);
      renderAttachmentChips();
    });
    chip.appendChild(label);
    chip.appendChild(rm);
    dom.composerChipsEl.appendChild(chip);
  }
}

export function attachWorkspaceFile(relPath: string): void {
  if (!relPath || state.attachments.includes(relPath) || state.attachments.length >= 6) return;
  state.attachments.push(relPath);
  renderAttachmentChips();
  dom.promptInput.focus();
}

function applySlashChoice(cmdName: string): void {
  dom.promptInput.value = `/${cmdName} `;
  state.mentionItems = [];
  state.mentionStart = -1;
  dom.mentionPopover.classList.remove('open');
  updateComposerMetrics();
  dom.promptInput.focus();
}

function applyMentionChoice(relPath: string): void {
  const pos = dom.promptInput.selectionStart || dom.promptInput.value.length;
  if (state.mentionStart >= 0 && pos >= state.mentionStart) {
    dom.promptInput.value = dom.promptInput.value.slice(0, state.mentionStart) + dom.promptInput.value.slice(pos);
  }
  attachWorkspaceFile(relPath);
  state.mentionItems = [];
  state.mentionStart = -1;
  dom.mentionPopover.classList.remove('open');
  updateComposerMetrics();
}

function renderMentionList(): void {
  dom.mentionPopover.textContent = '';
  if (state.mentionItems.length === 0) {
    dom.mentionPopover.classList.remove('open');
    return;
  }
  dom.mentionPopover.classList.add('open');
  state.mentionItems.forEach((item, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `mention-item${idx === state.mentionIndex ? ' selected' : ''}`;
    if (state.mentionMode === 'command') {
      const cmdName = item.name || '';
      btn.textContent = `/${cmdName}${item.description ? ` — ${item.description.slice(0, 62)}` : ''}`;
      btn.addEventListener('click', () => applySlashChoice(cmdName));
    } else {
      const filePath = item.path || '';
      btn.textContent = `@${filePath}`;
      btn.addEventListener('click', () => applyMentionChoice(filePath));
    }
    dom.mentionPopover.appendChild(btn);
  });
}

async function checkAtMention(): Promise<void> {
  const val = dom.promptInput.value || '';
  const trimmedLeft = val.trimStart();
  if (trimmedLeft.startsWith('/') && !trimmedLeft.includes(' ') && state.cliCommands.length > 0) {
    const q = trimmedLeft.slice(1).toLowerCase();
    state.mentionMode = 'command';
    const prefixHits = state.cliCommands.filter((c) => c.name.toLowerCase().startsWith(q));
    const nameHits = state.cliCommands.filter((c) => {
      const n = c.name.toLowerCase();
      return !n.startsWith(q) && n.includes(q);
    });
    const descHits = state.cliCommands.filter((c) => {
      const n = c.name.toLowerCase();
      return !n.includes(q) && (c.description || '').toLowerCase().includes(q);
    });
    state.mentionItems = prefixHits.concat(nameHits, descHits).slice(0, 10);
    state.mentionIndex = 0;
    renderMentionList();
    return;
  }
  const pos = dom.promptInput.selectionStart || val.length;
  const before = val.slice(0, pos);
  const atIdx = before.lastIndexOf('@');
  if (atIdx < 0 || (atIdx > 0 && !/\s/.test(before[atIdx - 1] || ''))) {
    state.mentionItems = [];
    state.mentionStart = -1;
    dom.mentionPopover.classList.remove('open');
    return;
  }
  const query = before.slice(atIdx + 1);
  if (/\s/.test(query)) { dom.mentionPopover.classList.remove('open'); return; }
  state.mentionMode = 'file';
  state.mentionStart = atIdx;
  const res = await fetch(apiUrl(`/api/files?q=${encodeURIComponent(query)}`), { headers: authHeaders() }).catch(() => null);
  if (!res || !res.ok) return;
  const data = await res.json() as { entries?: WorkspaceEntry[] };
  state.mentionItems = (data.entries || []).filter((x) => x.type === 'file').slice(0, 8);
  state.mentionIndex = 0;
  renderMentionList();
}

export function bindComposerEvents(): void {
  dom.composerPill.addEventListener('click', (e) => {
    if (e.target === dom.composerPill) dom.promptInput.focus();
  });
  dom.promptInput.addEventListener('compositionstart', () => { state.isComposing = true; });
  dom.promptInput.addEventListener('compositionend', () => { state.isComposing = false; });
  dom.promptInput.addEventListener('input', () => {
    updateComposerMetrics();
    void checkAtMention();
  });
  dom.promptInput.addEventListener('keydown', (e) => {
    if (dom.mentionPopover.classList.contains('open') && state.mentionItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        state.mentionIndex = (state.mentionIndex + 1) % state.mentionItems.length;
        renderMentionList();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        state.mentionIndex = (state.mentionIndex - 1 + state.mentionItems.length) % state.mentionItems.length;
        renderMentionList();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const chosen = state.mentionItems[state.mentionIndex];
        if (chosen) {
          if (state.mentionMode === 'command' && chosen.name) applySlashChoice(chosen.name);
          else if (chosen.path) applyMentionChoice(chosen.path);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        dom.mentionPopover.classList.remove('open');
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !state.isComposing) {
      e.preventDefault();
      dom.chatForm.requestSubmit();
    }
  });

  dom.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.activeController) { void callbacks.stopActiveRun(); return; }
    const text = (dom.promptInput.value || '').trim();
    if (!text) return;
    const toAttach = state.attachments.slice();
    dom.promptInput.value = '';
    state.attachments = [];
    renderAttachmentChips();
    updateComposerMetrics();
    if (text.startsWith('/') && /^\/[a-z?][a-z0-9_-]*/i.test(text)) {
      void callbacks.runCliCommand(text, 'chat');
      return;
    }
    void callbacks.submitPrompt(text, toAttach);
  });

  dom.sendBtn.addEventListener('click', (e) => {
    if (state.activeController) {
      e.preventDefault();
      void callbacks.stopActiveRun();
    }
  });
  dom.heroHelpBtn.addEventListener('click', () => {
    dom.promptInput.value = 'Inspect this local workspace and summarize its architecture and next steps.';
    updateComposerMetrics();
    dom.promptInput.focus();
  });
}
