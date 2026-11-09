import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { causyneHome } from '../utils/paths.js';
import { LICENSE_API_BASE, LICENSE_ENFORCEMENT_ENABLED, LICENSE_PLAN_KEYS } from './policy.js';

const TOKEN_FILE = 'installation-identity.json';
const USER_AGENT = 'Causyne-Agent/entitlements-v1';
const AUTH_TIMEOUT_MS = 10000;

export class EntitlementAccessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EntitlementAccessError';
    this.code = code;
  }
}

function base64url(input) { return Buffer.from(input).toString('base64url'); }
function digest(input) { return base64url(crypto.createHash('sha256').update(input).digest()); }
function sign(text, privateKey) { return base64url(crypto.sign(null, Buffer.from(text), privateKey)); }
function requestText(method, pathname, timestamp, nonce, hash) {
  return ['CAUSYNE_API_V1', method.toUpperCase(), pathname, timestamp, nonce, hash].join('\n');
}
function registrationText(key, nonce) { return ['CAUSYNE_REGISTER_V1', key, nonce].join('\n'); }

function requireIdentityFields(value) {
  if (!value || typeof value !== 'object' ||
      typeof value.privateKeyPem !== 'string' || typeof value.publicKey !== 'string') {
    throw new EntitlementAccessError('IDENTITY_CORRUPT',
      'The local Causyne installation identity is damaged. Contact support; do not delete it while recovering a paid license.');
  }
  const key = crypto.createPrivateKey(value.privateKeyPem);
  const derived = base64url(crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }));
  if (derived !== value.publicKey) throw new EntitlementAccessError('IDENTITY_CORRUPT', 'Installation public/private keys disagree.');
  if (value.installationId && !/^[\da-f-]{36}$/i.test(value.installationId)) {
    throw new EntitlementAccessError('IDENTITY_CORRUPT', 'Installation ID is invalid.');
  }
  return value;
}

/** No hardware serials, MAC addresses, device fingerprint or email required. */
export function loadInstallationIdentity(stateRoot = causyneHome()) {
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const file = path.join(stateRoot, TOKEN_FILE);
  try {
    const value = requireIdentityFields(JSON.parse(fs.readFileSync(file, 'utf8')));
    return { ...value, file };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const pair = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKey = base64url(pair.publicKey.export({ type: 'spki', format: 'der' }));
  const identity = { version: 1, publicKey, privateKeyPem, installationId: null };
  // Exclusive create prevents a second running CLI from replacing this identity.
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(identity), 'utf8');
  } catch (error) {
    if (error.code === 'EEXIST') return loadInstallationIdentity(stateRoot);
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  return { ...identity, file };
}

function saveInstallationIdentity(identity) {
  const value = { version: 1, privateKeyPem: identity.privateKeyPem,
    publicKey: identity.publicKey, installationId: identity.installationId };
  const file = identity.file;
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows ACLs differ */ }
  } finally { try { fs.unlinkSync(temp); } catch { /* rename removed it */ } }
}

export class EntitlementClient {
  constructor({ apiBase = LICENSE_API_BASE, stateRoot = causyneHome(), fetchFn = globalThis.fetch } = {}) {
    const url = new URL(apiBase);
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      throw new Error('Entitlement service requires HTTPS.');
    }
    this.apiBase = url.origin;
    this.stateRoot = stateRoot;
    this.fetchFn = fetchFn;
    this.identity = null;
  }

  async call(pathname, body, { register = false } = {}) {
    const identity = this.identity ||= loadInstallationIdentity(this.stateRoot);
    const method = body === undefined ? 'GET' : 'POST';
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers = { 'user-agent': USER_AGENT, 'accept': 'application/json',
      'content-type': 'application/json' };
    if (!register) {
      if (!identity.installationId) await this.register();
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = crypto.randomBytes(24).toString('base64url');
      headers['x-causyne-installation'] = identity.installationId;
      headers['x-causyne-timestamp'] = timestamp;
      headers['x-causyne-nonce'] = nonce;
      headers['x-causyne-signature'] = sign(requestText(method, pathname, timestamp, nonce, digest(raw)), identity.privateKeyPem);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const response = await this.fetchFn(`${this.apiBase}${pathname}`, {
        method, headers, ...(body !== undefined ? { body: raw } : {}), signal: controller.signal
      });
      const parsed = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new EntitlementAccessError(parsed?.error || 'SERVICE_ERROR',
          typeof parsed?.message === 'string' ? parsed.message : `Entitlement service returned HTTP ${response.status}.`);
      }
      return parsed;
    } catch (error) {
      if (error instanceof EntitlementAccessError) throw error;
      throw new EntitlementAccessError('NETWORK_UNAVAILABLE',
        'Cannot reach the Causyne licensing service. The current task is preserved; retry when connected.');
    } finally { clearTimeout(timeout); }
  }

  async register() {
    const identity = this.identity ||= loadInstallationIdentity(this.stateRoot);
    if (identity.installationId) return identity.installationId;
    const nonce = crypto.randomBytes(24).toString('base64url');
    const response = await this.call('/v1/installations', {
      publicKey: identity.publicKey, nonce,
      proof: sign(registrationText(identity.publicKey, nonce), identity.privateKeyPem)
    }, { register: true });
    if (!/^[\da-f-]{36}$/i.test(response.installationId || '')) {
      throw new EntitlementAccessError('REGISTRATION_ERROR', 'Licensing service returned an invalid installation ID.');
    }
    identity.installationId = response.installationId;
    saveInstallationIdentity(identity);
    return identity.installationId;
  }

  status() { return this.call('/v1/status'); }
  lease(requestId, sessionId) { return this.call('/v1/leases', { requestId, sessionId }); }
  async checkout(plan) {
    if (!LICENSE_PLAN_KEYS.includes(plan)) throw new EntitlementAccessError('INVALID_PLAN', 'Unknown Causyne plan.');
    const result = await this.call('/v1/checkout', { plan });
    const url = new URL(result.url);
    if (url.protocol !== 'https:' || !/(^|\.)lemonsqueezy\.com$/i.test(url.hostname)) {
      throw new EntitlementAccessError('BAD_CHECKOUT_URL', 'Invalid checkout destination returned by server.');
    }
    return result;
  }
}

/** Process-local gate. All AgentLoop instances in this process share one session. */
export class EntitlementGate {
  constructor({ enabled = LICENSE_ENFORCEMENT_ENABLED, client = new EntitlementClient() } = {}) {
    this.enabled = enabled;
    this.client = client;
    this.sessionId = crypto.randomUUID();
    this.activeRuns = 0;
    this.pausedRuns = 0;
    this.leaseUntil = 0;
    this.leasePlan = null;
    this.blockedError = null;
    this.timer = null;
    this.pending = null;
    this.listeners = new Set();
  }

  async ensureLease() {
    if (!this.enabled) return { plan: 'development-disabled' };
    if (this.blockedError) throw this.blockedError;
    if (Date.now() + 500 < this.leaseUntil) return { plan: this.leasePlan };
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const requestId = crypto.randomUUID();
      const result = await this.client.lease(requestId, this.sessionId);
      const expiration = Date.parse(result.expiresAt || '');
      if (!Number.isFinite(expiration) || expiration <= Date.now()) {
        throw new EntitlementAccessError('INVALID_LEASE', 'Licensing service returned an expired or invalid lease.');
      }
      this.leaseUntil = expiration;
      this.leasePlan = result.plan;
      this.blockedError = null;
      return result;
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  async begin(onBlocked = () => {}) {
    if (!this.enabled) return;
    await this.ensureLease();
    this.activeRuns++;
    this.listeners.add(onBlocked);
    if (this.activeRuns === 1) {
      // In-process only while tasks run. No daemon or remotely accessible port.
      this.timer = setInterval(async () => {
        if (this.pausedRuns >= this.activeRuns || Date.now() < this.leaseUntil) return;
        try { await this.ensureLease(); }
        catch (error) {
          this.blockedError = error;
          for (const listener of this.listeners) {
            try { listener(error); } catch { /* do not crash current tool */ }
          }
        }
      }, 1000);
      this.timer.unref?.();
    }
  }

  pause() { if (this.enabled) this.pausedRuns++; }
  resume() { if (this.enabled) this.pausedRuns = Math.max(0, this.pausedRuns - 1); }

  async beforeStep() {
    if (!this.enabled) return;
    await this.ensureLease();
  }

  end(onBlocked) {
    if (!this.enabled) return;
    this.listeners.delete(onBlocked);
    this.activeRuns = Math.max(0, this.activeRuns - 1);
    this.pausedRuns = Math.min(this.pausedRuns, this.activeRuns);
    if (this.activeRuns === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

let processGate;
export function getProcessEntitlementGate() {
  return processGate ||= new EntitlementGate();
}

export async function runLicenseCommand(action = 'status', plan = '') {
  const client = new EntitlementClient();
  if (action === 'plans') {
    console.log('Causyne Go plans: monthly, annual, two_month_pass, two_year_pass');
    console.log('Paid access does not include paid model inference.');
    console.log('One-time passes are non-recurring; pricing is shown at merchant checkout.');
    return;
  }
  if (action === 'status') {
    const data = await client.status();
    console.log(`Causyne software entitlement: ${data.entitlement}`);
    if (data.paidUntil) console.log(`Paid through: ${data.paidUntil}`);
    else {
      console.log(`Free allowance remaining: ${Math.floor(data.remainingSeconds / 60)} of ${Math.floor(data.dailySeconds / 60)} minutes`);
      console.log(`UTC reset: ${data.resetsAt}`);
    }
    console.log('Model-provider inference has separate limits and costs.');
    return;
  }
  if (action === 'buy') {
    const result = await client.checkout(plan);
    console.log(`Checkout: ${result.url}`);
    console.log('Your entitlement activates only after the provider confirms payment.');
    return;
  }
  throw new EntitlementAccessError('UNKNOWN_COMMAND', 'Use: causyne license status | plans | buy <plan>.');
}
