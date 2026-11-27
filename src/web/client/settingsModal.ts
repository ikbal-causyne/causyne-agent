import { dom } from './dom.js';
import { apiUrl, applyTheme, authHeaders } from './state.js';
import { isSafeBillingUrl } from './validators.js';

interface LicenseStatusPayload {
  entitlement?: string;
  plan?: string;
  paidUntil?: string | null;
  dailySeconds?: number | null;
  remainingSeconds?: number | null;
  recoveryCode?: string | null;
  supportMessage?: string;
  error?: string;
}

export interface SettingsModalCallbacks {
  loadHealth(): Promise<void>;
  loadModels(mode?: string): Promise<void>;
}

let callbacks: SettingsModalCallbacks = {
  loadHealth: async () => {},
  loadModels: async () => {}
};

export function configureSettingsModalCallbacks(cbs: SettingsModalCallbacks): void {
  callbacks = cbs;
}

export async function loadDoctorReport(): Promise<void> {
  dom.doctorPre.textContent = 'Loading redacted diagnostics...';
  const res = await fetch(apiUrl('/api/doctor/report'), { headers: authHeaders() });
  if (!res.ok) { dom.doctorPre.textContent = 'Unable to load diagnostics.'; return; }
  const data = await res.json() as { report?: string };
  dom.doctorPre.textContent = data.report || 'No diagnostics available.';
}

export async function loadLicenseStatus(forceLive: boolean): Promise<void> {
  if (!dom.licenseSummaryEl) return;
  dom.licenseSummaryEl.textContent = 'Checking plan status...';
  const qs = forceLive ? '?live=1' : '';
  const res = await fetch(apiUrl(`/api/license/status${qs}`), { headers: authHeaders() }).catch(() => null);
  if (!res) { dom.licenseSummaryEl.textContent = 'Could not load plan status.'; return; }
  const data = await res.json().catch(() => null) as LicenseStatusPayload | null;
  if (!res.ok || !data) {
    dom.licenseSummaryEl.textContent = (data && data.error) || 'Licensing service offline.';
    return;
  }
  const isPro = data.entitlement === 'pro' && Boolean(data.paidUntil);
  if (dom.licenseBadgeEl) {
    dom.licenseBadgeEl.textContent = isPro ? (`Pro · ${data.plan || 'active'}`) : 'Free · 6h/day';
    dom.licenseBadgeEl.classList.toggle('is-pro', isPro);
  }
  if (dom.licensePortalBtn) dom.licensePortalBtn.style.display = isPro ? 'inline-flex' : 'none';
  if (isPro) {
    const untilStr = String(data.paidUntil).slice(0, 10);
    dom.licenseSummaryEl.textContent = `Unlimited daily execution · Paid through ${untilStr}`;
    if (dom.licenseMeterWrap) dom.licenseMeterWrap.style.display = 'none';
    if (dom.licenseSupportNote) {
      dom.licenseSupportNote.textContent = data.recoveryCode
        ? `Thank you for supporting Causyne! Save your multi-device recovery code: ${data.recoveryCode}`
        : 'Thank you for supporting independent Causyne development and community maintenance.';
    }
  } else {
    const daySec = Number(data.dailySeconds || 21600);
    const remSec = typeof data.remainingSeconds === 'number' ? Math.max(0, data.remainingSeconds) : daySec;
    const remMin = Math.floor(remSec / 60);
    const dayMin = Math.floor(daySec / 60);
    const pct = daySec > 0 ? Math.max(0, Math.min(100, Math.round((remSec / daySec) * 100))) : 100;
    dom.licenseSummaryEl.textContent = `${remMin} of ${dayMin} free active minutes remaining today (resets 00:00 UTC)`;
    if (dom.licenseMeterWrap) dom.licenseMeterWrap.style.display = 'block';
    if (dom.licenseMeterFill) dom.licenseMeterFill.style.width = `${pct}%`;
    if (dom.licenseSupportNote) {
      dom.licenseSupportNote.textContent = remSec <= 0 && data.supportMessage
        ? data.supportMessage
        : 'Free includes 6 hours/day of active execution. Upgrade to Causyne Pro for unlimited daily usage and to support independent development, ongoing maintenance, and making Causyne Agent better for the entire community. Thank you for your trust and support.';
    }
  }
}

async function startLicenseCheckout(): Promise<void> {
  if (!dom.licensePlanSelect || !dom.licenseStatusMsg) return;
  const plan = dom.licensePlanSelect.value || 'monthly';
  dom.licenseStatusMsg.textContent = 'Opening secure Paddle checkout...';
  const res = await fetch(apiUrl('/api/license/checkout'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ plan })
  }).catch(() => null);
  if (!res) { dom.licenseStatusMsg.textContent = 'Could not reach checkout service.'; return; }
  const data = await res.json().catch(() => ({ error: 'Checkout error' })) as { url?: string; error?: string };
  if (!res.ok || !data.url || !isSafeBillingUrl(data.url)) {
    dom.licenseStatusMsg.textContent = data.error || 'Checkout unavailable right now. Visit causyne.com/pricing.html.';
    return;
  }
  window.open(data.url, '_blank', 'noopener,noreferrer');
  dom.licenseStatusMsg.textContent = 'Paddle checkout opened in a new tab. Click Refresh after payment completes.';
}

async function claimLicenseRecovery(): Promise<void> {
  if (!dom.licenseRecoveryInput || !dom.licenseStatusMsg) return;
  const code = (dom.licenseRecoveryInput.value || '').trim();
  if (!code) { dom.licenseStatusMsg.textContent = 'Enter your CSYN-XXXX-XXXX-XXXX-XXXX recovery code first.'; return; }
  dom.licenseStatusMsg.textContent = 'Linking license...';
  const res = await fetch(apiUrl('/api/license/recover'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ recoveryCode: code })
  }).catch(() => null);
  if (!res) { dom.licenseStatusMsg.textContent = 'Could not reach licensing service.'; return; }
  const data = await res.json().catch(() => ({ error: 'Recovery failed' })) as { error?: string };
  if (!res.ok) { dom.licenseStatusMsg.textContent = data.error || 'Could not link recovery code.'; return; }
  dom.licenseRecoveryInput.value = '';
  dom.licenseStatusMsg.textContent = 'Causyne Pro linked to this device!';
  void loadLicenseStatus(true);
}

async function openBillingPortal(): Promise<void> {
  if (!dom.licenseStatusMsg) return;
  dom.licenseStatusMsg.textContent = 'Opening Paddle billing portal...';
  const res = await fetch(apiUrl('/api/license/portal'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: '{}'
  }).catch(() => null);
  if (!res) { dom.licenseStatusMsg.textContent = 'Could not open billing portal.'; return; }
  const data = await res.json().catch(() => ({ error: 'Portal unavailable' })) as { url?: string; error?: string };
  if (!res.ok || !data.url || !isSafeBillingUrl(data.url)) {
    dom.licenseStatusMsg.textContent = data.error || 'Billing portal unavailable.';
    return;
  }
  window.open(data.url, '_blank', 'noopener,noreferrer');
  dom.licenseStatusMsg.textContent = 'Paddle billing portal opened in a new tab.';
}

async function saveVaultApiKey(): Promise<void> {
  const provider = dom.vaultProviderSelect.value;
  const apiKey = (dom.vaultKeyInput.value || '').trim();
  if (!apiKey) { dom.vaultStatusEl.textContent = 'Enter an API key first.'; return; }
  dom.vaultStatusEl.textContent = 'Saving...';
  const res = await fetch(apiUrl('/api/config/key'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ provider, apiKey, activate: true })
  }).catch(() => null);
  dom.vaultKeyInput.value = '';
  if (!res || !res.ok) { dom.vaultStatusEl.textContent = 'Could not save key.'; return; }
  const data = await res.json() as { provider?: string };
  dom.vaultStatusEl.textContent = `Saved for ${data.provider || provider}.`;
  void callbacks.loadHealth();
  void callbacks.loadModels();
}

export function openSettingsModal(): void {
  dom.settingsModal.classList.add('open');
  void loadLicenseStatus(false);
  void loadDoctorReport();
}

export function bindSettingsModalEvents(): void {
  dom.navSettingsBtn.addEventListener('click', openSettingsModal);
  dom.settingsCloseBtn.addEventListener('click', () => dom.settingsModal.classList.remove('open'));
  dom.settingsModal.addEventListener('click', (e) => {
    if (e.target === dom.settingsModal) dom.settingsModal.classList.remove('open');
  });
  dom.themeToggleBtn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(cur === 'light' ? 'dark' : 'light');
  });
  dom.doctorLoadBtn.addEventListener('click', () => { void loadDoctorReport(); });
  dom.vaultSaveBtn.addEventListener('click', () => { void saveVaultApiKey(); });
  if (dom.licenseUpgradeBtn) dom.licenseUpgradeBtn.addEventListener('click', () => { void startLicenseCheckout(); });
  if (dom.licensePortalBtn) dom.licensePortalBtn.addEventListener('click', () => { void openBillingPortal(); });
  if (dom.licenseRefreshBtn) dom.licenseRefreshBtn.addEventListener('click', () => { void loadLicenseStatus(true); });
  if (dom.licenseRecoverBtn) dom.licenseRecoverBtn.addEventListener('click', () => { void claimLicenseRecovery(); });
}
