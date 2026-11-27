import { dom } from './dom.js';
import { apiUrl, authHeaders, state, updateComposerMetrics } from './state.js';
import { isHtmlOrSvgPath } from './validators.js';
import { renderMarkdownInto } from './markdown.js';
import { openStudio } from './studioShell.js';
import type { WorkspaceEntry } from './types.js';

export interface FilesAndCanvasCallbacks {
  attachWorkspaceFile(relPath: string): void;
  saveCurrentSessionWorkspace(): void;
  refreshDiffIfOpen(): void;
}

let callbacks: FilesAndCanvasCallbacks = {
  attachWorkspaceFile: () => {},
  saveCurrentSessionWorkspace: () => {},
  refreshDiffIfOpen: () => {}
};

export function configureFilesAndCanvasCallbacks(cbs: FilesAndCanvasCallbacks): void {
  callbacks = cbs;
}

export function syncArtifactVersionSelect(relPath: string): void {
  const list = state.artifactVersions.get(relPath || '') || [];
  dom.artifactVersionSelect.textContent = '';
  if (list.length <= 1) {
    dom.artifactVersionSelect.style.display = 'none';
    return;
  }
  dom.artifactVersionSelect.style.display = 'inline-block';
  for (const item of list) {
    const opt = document.createElement('option');
    opt.value = String(item.version);
    opt.textContent = `v${item.version}`;
    dom.artifactVersionSelect.appendChild(opt);
  }
  const latest = list[list.length - 1];
  if (latest) dom.artifactVersionSelect.value = String(latest.version);
}

export function recordArtifactVersion(relPath: string, content: string): number {
  const key = relPath || 'draft.idoc.md';
  const list = state.artifactVersions.get(key) || [];
  const last = list[list.length - 1];
  if (!last || last.content !== content) {
    list.push({ version: list.length + 1, content, at: Date.now() });
    state.artifactVersions.set(key, list);
  }
  syncArtifactVersionSelect(key);
  return list.length;
}

export function renderCanvasPreview(): void {
  const pathVal = (dom.filePathInput.value || '').trim();
  const content = dom.fileContentInput.value || '';
  if (isHtmlOrSvgPath(pathVal)) {
    dom.canvasPreviewEl.style.display = 'none';
    dom.canvasHtmlFrame.style.display = 'block';
    const trimmed = content.trim();
    if (trimmed.startsWith('<svg')) {
      dom.canvasHtmlFrame.srcdoc = `<!DOCTYPE html><html><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#141714">${content}</body></html>`;
      return;
    }
    // For saved multi-file workspace HTML documents, pack relative CSS/JS assets cleanly
    if (!state.canvasDirty && pathVal && !pathVal.startsWith('/') && /\.html?$/i.test(pathVal)) {
      dom.canvasHtmlFrame.srcdoc = content;
      void fetch(apiUrl(`/api/file/pack-html?path=${encodeURIComponent(pathVal)}`), { headers: authHeaders() })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { html?: string; packedAssets?: number } | null) => {
          if (data && typeof data.html === 'string' && state.canvasPreviewMode && (dom.filePathInput.value || '').trim() === pathVal) {
            dom.canvasHtmlFrame.srcdoc = data.html;
            if (typeof data.packedAssets === 'number' && data.packedAssets > 0) {
              dom.fileStatusEl.textContent = `Preview · ${pathVal} (${data.packedAssets} local asset${data.packedAssets === 1 ? '' : 's'} bundled)`;
            }
          }
        })
        .catch(() => { /* keep direct srcdoc fallback */ });
      return;
    }
    dom.canvasHtmlFrame.srcdoc = content;
  } else {
    dom.canvasHtmlFrame.style.display = 'none';
    dom.canvasPreviewEl.style.display = 'block';
    renderMarkdownInto(dom.canvasPreviewEl, content, false);
  }
}

export function setCanvasPreviewMode(previewOn: boolean): void {
  state.canvasPreviewMode = previewOn;
  dom.canvasCodeBtn.classList.toggle('active', !previewOn);
  dom.canvasModeBtn.classList.toggle('active', previewOn);
  dom.fileContentInput.style.display = previewOn ? 'none' : 'block';
  if (previewOn) {
    renderCanvasPreview();
  } else {
    dom.canvasPreviewEl.style.display = 'none';
    dom.canvasHtmlFrame.style.display = 'none';
  }
}

export function openInCanvas(suggestedPath: string, content: string, preferPreview: boolean): void {
  openStudio('canvas');
  const targetPath = suggestedPath || dom.filePathInput.value || 'draft.idoc.md';
  dom.filePathInput.value = targetPath;
  dom.fileContentInput.value = content || '';
  const ver = recordArtifactVersion(targetPath, content || '');
  dom.fileStatusEl.textContent = `Canvas · ${targetPath} (v${ver})`;
  setCanvasPreviewMode(Boolean(preferPreview));
}

export async function loadFiles(dir: string, query: string): Promise<void> {
  const params = new URLSearchParams();
  if (dir) params.set('dir', dir);
  if (query) params.set('q', query);
  const qs = params.toString() ? (`?${params.toString()}`) : '';
  const res = await fetch(apiUrl(`/api/files${qs}`), { headers: authHeaders() });
  if (!res.ok) return;
  const data = await res.json() as { dir?: string; parentDir?: string; entries?: WorkspaceEntry[] };
  state.currentDir = data.dir || '';
  state.parentDir = data.parentDir || '';
  dom.fileUpBtn.disabled = !state.currentDir;
  dom.fileListEl.textContent = '';
  const entries = data.entries || [];
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'session-empty';
    empty.textContent = 'No files in this directory.';
    dom.fileListEl.appendChild(empty);
    return;
  }
  for (const item of entries) {
    const row = document.createElement('div');
    row.className = 'file-row';
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'file-open-btn';
    openBtn.textContent = (item.type === 'dir' ? '[dir] ' : '') + item.path;
    openBtn.addEventListener('click', () => {
      if (item.type === 'dir') void loadFiles(item.path, '');
      else void openFile(item.path);
    });
    row.appendChild(openBtn);
    if (item.type === 'file') {
      const atBtn = document.createElement('button');
      atBtn.type = 'button';
      atBtn.className = 'file-attach-btn';
      atBtn.textContent = '+ @';
      atBtn.title = 'Attach to prompt';
      atBtn.addEventListener('click', () => callbacks.attachWorkspaceFile(item.path));
      row.appendChild(atBtn);
    }
    dom.fileListEl.appendChild(row);
  }
}

export async function openFile(relPath: string): Promise<void> {
  const seq = state.sessionSwitchSeq;
  const res = await fetch(apiUrl(`/api/file?path=${encodeURIComponent(relPath)}`), { headers: authHeaders() });
  if (seq !== state.sessionSwitchSeq) return;
  const data = await res.json() as { path?: string; content?: string; size?: number; error?: string };
  if (!res.ok) {
    dom.fileStatusEl.textContent = data.error || 'Read failed';
    return;
  }
  state.canvasDirty = false;
  const targetPath = data.path || relPath;
  openInCanvas(targetPath, data.content || '', isHtmlOrSvgPath(targetPath));
  dom.fileStatusEl.textContent = `Loaded ${targetPath} (${data.size || 0} B)`;
  callbacks.saveCurrentSessionWorkspace();
}

export async function saveFile(): Promise<void> {
  const relPath = (dom.filePathInput.value || '').trim();
  if (!relPath) {
    dom.fileStatusEl.textContent = 'Enter a workspace relative path first.';
    return;
  }
  const content = dom.fileContentInput.value || '';
  const res = await fetch(apiUrl('/api/file'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ path: relPath, content, sessionId: state.sessionId || undefined })
  });
  const data = await res.json() as { path?: string; bytes?: number; error?: string };
  if (!res.ok) {
    dom.fileStatusEl.textContent = data.error || 'Write failed';
    return;
  }
  state.canvasDirty = false;
  const savedPath = data.path || relPath;
  const ver = recordArtifactVersion(savedPath, content);
  dom.fileStatusEl.textContent = `Saved ${savedPath} v${ver} (${data.bytes || 0} B)`;
  callbacks.saveCurrentSessionWorkspace();
  void loadFiles(state.currentDir, dom.fileFilterEl.value || '');
  callbacks.refreshDiffIfOpen();
}

export function bindFilesAndCanvasEvents(): void {
  dom.fileFilterEl.addEventListener('input', () => { void loadFiles(state.currentDir, dom.fileFilterEl.value || ''); });
  dom.fileUpBtn.addEventListener('click', () => { void loadFiles(state.parentDir, ''); });
  dom.refreshFilesBtn.addEventListener('click', () => { void loadFiles(state.currentDir, dom.fileFilterEl.value || ''); });
  dom.saveFileBtn.addEventListener('click', () => { void saveFile(); });
  dom.canvasCodeBtn.addEventListener('click', () => setCanvasPreviewMode(false));
  dom.canvasModeBtn.addEventListener('click', () => setCanvasPreviewMode(true));
  dom.fileContentInput.addEventListener('input', () => {
    state.canvasDirty = true;
    const p = (dom.filePathInput.value || '').trim();
    dom.fileStatusEl.textContent = (p ? (`${p} · `) : '') + 'Unsaved';
  });
  dom.artifactVersionSelect.addEventListener('change', () => {
    const list = state.artifactVersions.get((dom.filePathInput.value || '').trim()) || [];
    const chosen = list.find((item) => String(item.version) === dom.artifactVersionSelect.value);
    if (chosen) {
      dom.fileContentInput.value = chosen.content;
      if (state.canvasPreviewMode) renderCanvasPreview();
    }
  });
  dom.canvasDownloadBtn.addEventListener('click', () => {
    const name = ((dom.filePathInput.value || 'causyne-artifact.md').split('/').pop()) || 'artifact.md';
    const blob = new Blob([dom.fileContentInput.value || ''], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  dom.canvasRefineBtn.addEventListener('click', () => {
    const p = (dom.filePathInput.value || '').trim();
    if (p) callbacks.attachWorkspaceFile(p);
    dom.promptInput.value = p
      ? `Review and improve ${p} in this workspace.`
      : 'Improve the open Canvas draft.';
    updateComposerMetrics();
    dom.promptInput.focus();
  });
}
