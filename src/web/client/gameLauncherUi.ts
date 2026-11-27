import { announceAlert, announceStatus, dom } from './dom.js';
import { apiUrl, authHeaders, setLiveness, state } from './state.js';

interface GameStatusPayload {
  ok?: boolean;
  running?: boolean;
  installed?: boolean;
  ready?: boolean;
  url?: string;
  openedBrowser?: boolean;
  error?: string;
}

export async function loadGameStatus(): Promise<void> {
  if (!dom.navGameBtn || !dom.navGameBadge) return;
  try {
    const r = await fetch(apiUrl('/api/game/status'), { headers: authHeaders() });
    if (!r.ok) return;
    const d = await r.json() as GameStatusPayload;
    state.gameStatus = d as Record<string, unknown>;
    if (d && d.running) {
      dom.navGameBadge.textContent = 'Live';
      dom.navGameBtn.classList.add('active');
      dom.navGameBtn.title = `Open Causyne Game (${d.url || 'running'})`;
    } else if (d && d.installed && d.ready) {
      dom.navGameBadge.textContent = '';
      dom.navGameBtn.classList.remove('active');
      dom.navGameBtn.title = 'Launch Causyne Game Studio';
    } else {
      dom.navGameBadge.textContent = 'Setup';
      dom.navGameBtn.classList.remove('active');
      dom.navGameBtn.title = 'Install or launch Causyne Game Studio';
    }
  } catch { /* ignore */ }
}

export async function launchCausyneGameFromUi(): Promise<void> {
  if (!dom.navGameBtn || !dom.navGameBadge) return;
  if (state.gameLaunching) return;
  state.gameLaunching = true;
  const prevLabel = dom.navGameBadge.textContent;
  dom.navGameBadge.textContent = 'Opening…';
  try {
    const r = await fetch(apiUrl('/api/game/launch'), {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ openBrowser: true })
    });
    const d = await r.json().catch(() => ({})) as GameStatusPayload;
    if (r.ok && d && d.ok && d.url) {
      state.gameStatus = d as Record<string, unknown>;
      dom.navGameBadge.textContent = 'Live';
      dom.navGameBtn.classList.add('active');
      dom.navGameBtn.title = `Open Causyne Game (${d.url})`;
      announceStatus(`Causyne Game running at ${d.url}`);
      if (!d.openedBrowser) {
        try { window.open(d.url, '_blank', 'noopener,noreferrer'); } catch { /* ignore */ }
      }
    } else {
      dom.navGameBadge.textContent = prevLabel || 'Setup';
      const errText = d?.error || 'Could not launch Causyne Game. Run causyne game install --yes.';
      announceAlert(errText);
      setLiveness(false, errText);
    }
  } catch (err) {
    dom.navGameBadge.textContent = prevLabel || '';
    const msg = err instanceof Error ? err.message : String(err);
    announceAlert(`Causyne Game launch failed: ${msg}`);
  } finally {
    state.gameLaunching = false;
  }
}

export function bindGameLauncherEvents(): void {
  if (dom.navGameBtn) {
    dom.navGameBtn.addEventListener('click', () => { void launchCausyneGameFromUi(); });
  }
}
