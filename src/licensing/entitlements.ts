import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { causyneHome } from '../utils/paths.js';
import { LICENSE_API_BASE, LICENSE_ENFORCEMENT_ENABLED, LICENSE_PLAN_KEYS } from './policy.js';

const TOKEN_FILE = 'installation-identity.json';
const USER_AGENT = 'Causyne-Agent/entitlements-v1';
const AUTH_TIMEOUT_MS = 10000;
const MAX_IDENTITY_BYTES = 64 * 1024;

export interface InstallationIdentity {
  version: number;
  publicKey: string;
  privateKeyPem: string;
  installationId: string | null;
  file: string;
}

export interface EntitlementClientOptions {
  apiBase?: string | undefined;
  stateRoot?: string | undefined;
  fetchFn?: typeof globalThis.fetch | undefined;
}

export interface EntitlementGateOptions {
  enabled?: boolean | undefined;
  client?: Pick<EntitlementClient, 'lease'> | undefined;
}

export class EntitlementAccessError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EntitlementAccessError';
    this.code = code;
  }
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}
function digest(input: string): string {
  return base64url(crypto.createHash('sha256').update(input).digest());
}
function sign(text: string, privateKey: string): string {
  return base64url(crypto.sign(null, Buffer.from(text), privateKey));
}
function requestText(method: string, pathname: string, timestamp: string, nonce: string, hash: string): string {
  return ['CAUSYNE_API_V1', method.toUpperCase(), pathname, timestamp, nonce, hash].join('\n');
}
function registrationText(key: string, nonce: string): string {
  return ['CAUSYNE_REGISTER_V1', key, nonce].join('\n');
}

function requireIdentityFields(value: unknown): Omit<InstallationIdentity, 'file'> {
  if (
    !value || typeof value !== 'object' || Array.isArray(value)
    || typeof (value as Record<string, unknown>).privateKeyPem !== 'string'
    || typeof (value as Record<string, unknown>).publicKey !== 'string'
  ) {
    throw new EntitlementAccessError(
      'IDENTITY_CORRUPT',
      'The local Causyne installation identity is damaged. Contact support; do not delete it while recovering a paid license.'
    );
  }
  const record = value as Record<string, unknown>;
  const privateKeyPem = record.privateKeyPem as string;
  const publicKey = record.publicKey as string;
  const installationId = record.installationId;
  const key = crypto.createPrivateKey(privateKeyPem);
  const derived = base64url(crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }));
  if (derived !== publicKey) {
    throw new EntitlementAccessError('IDENTITY_CORRUPT', 'Installation public/private keys disagree.');
  }
  if (installationId && (typeof installationId !== 'string' || !/^[\da-f-]{36}$/i.test(installationId))) {
    throw new EntitlementAccessError('IDENTITY_CORRUPT', 'Installation ID is invalid.');
  }
  return {
    version: typeof record.version === 'number' ? record.version : 1,
    publicKey,
    privateKeyPem,
    installationId: typeof installationId === 'string' ? installationId : null
  };
}

/** No hardware serials, MAC addresses, device fingerprint or email required. */
export function loadInstallationIdentity(stateRoot = causyneHome(), depth = 0): InstallationIdentity {
  if (typeof stateRoot !== 'string' || !stateRoot.trim() || stateRoot.includes('\0')) {
    throw new EntitlementAccessError('IDENTITY_CORRUPT', 'Invalid state directory for installation identity.');
  }
  const resolvedRoot = path.resolve(stateRoot);
  if (!fs.existsSync(resolvedRoot)) {
    fs.mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
  } else {
    const dirStat = fs.lstatSync(resolvedRoot);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new EntitlementAccessError('IDENTITY_CORRUPT', 'Refusing symlink or non-directory state root.');
    }
  }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(resolvedRoot, 0o700); } catch { /* ignore */ }
  }
  const file = path.join(resolvedRoot, TOKEN_FILE);
  try {
    const fileStat = fs.lstatSync(file);
    if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size > MAX_IDENTITY_BYTES) {
      throw new EntitlementAccessError('IDENTITY_CORRUPT', 'Installation identity file must be a regular non-symlink file.');
    }
    const value = requireIdentityFields(JSON.parse(fs.readFileSync(file, 'utf8')));
    return { ...value, file };
  } catch (error: unknown) {
    if (error instanceof EntitlementAccessError) throw error;
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    if (code !== 'ENOENT') throw error;
  }
  const pair = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKey = base64url(pair.publicKey.export({ type: 'spki', format: 'der' }));
  const identity = { version: 1, publicKey, privateKeyPem, installationId: null };
  // Exclusive create prevents a second running CLI from replacing this identity.
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
    const buf = Buffer.from(JSON.stringify(identity), 'utf8');
    fs.writeSync(fd, buf, 0, buf.length);
    fs.fsyncSync(fd);
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    if (code === 'EEXIST' && depth < 3) return loadInstallationIdentity(resolvedRoot, depth + 1);
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
  }
  return { ...identity, file };
}

function saveInstallationIdentity(identity: InstallationIdentity): void {
  const value = {
    version: 1,
    privateKeyPem: identity.privateKeyPem,
    publicKey: identity.publicKey,
    installationId: identity.installationId
  };
  const file = identity.file;
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows ACLs differ */ }
  } finally {
    try { fs.unlinkSync(temp); } catch { /* rename removed it */ }
  }
}

export class EntitlementClient {
  apiBase: string;
  stateRoot: string;
  fetchFn: typeof globalThis.fetch;
  identity: InstallationIdentity | null;

  constructor({ apiBase = LICENSE_API_BASE, stateRoot = causyneHome(), fetchFn = globalThis.fetch }: EntitlementClientOptions = {}) {
    const url = new URL(apiBase);
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      throw new Error('Entitlement service requires HTTPS.');
    }
    this.apiBase = url.origin;
    this.stateRoot = stateRoot;
    this.fetchFn = fetchFn;
    this.identity = null;
  }

  async call(pathname: string, body?: unknown, { register = false }: { register?: boolean } = {}): Promise<any> {
    const identity = this.identity ||= loadInstallationIdentity(this.stateRoot);
    const method = body === undefined ? 'GET' : 'POST';
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      'accept': 'application/json',
      'content-type': 'application/json'
    };
    if (!register) {
      if (!identity.installationId) await this.register();
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = crypto.randomBytes(24).toString('base64url');
      headers['x-causyne-installation'] = identity.installationId || '';
      headers['x-causyne-timestamp'] = timestamp;
      headers['x-causyne-nonce'] = nonce;
      headers['x-causyne-signature'] = sign(requestText(method, pathname, timestamp, nonce, digest(raw)), identity.privateKeyPem);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const response = await this.fetchFn(`${this.apiBase}${pathname}`, {
        method,
        headers,
        ...(body !== undefined ? { body: raw } : {}),
        signal: controller.signal
      });
      const parsed: any = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new EntitlementAccessError(
          typeof parsed?.error === 'string' && parsed.error ? parsed.error : 'SERVICE_ERROR',
          typeof parsed?.message === 'string' ? parsed.message : `Entitlement service returned HTTP ${response.status}.`
        );
      }
      return parsed;
    } catch (error: unknown) {
      if (error instanceof EntitlementAccessError) throw error;
      throw new EntitlementAccessError(
        'NETWORK_UNAVAILABLE',
        'Cannot reach the Causyne licensing service. The current task is preserved; retry when connected.'
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async register(): Promise<string> {
    const identity = this.identity ||= loadInstallationIdentity(this.stateRoot);
    if (identity.installationId) return identity.installationId;
    const nonce = crypto.randomBytes(24).toString('base64url');
    const response = await this.call('/v1/installations', {
      publicKey: identity.publicKey,
      nonce,
      proof: sign(registrationText(identity.publicKey, nonce), identity.privateKeyPem)
    }, { register: true });
    if (typeof response?.installationId !== 'string' || !/^[\da-f-]{36}$/i.test(response.installationId)) {
      throw new EntitlementAccessError('REGISTRATION_ERROR', 'Licensing service returned an invalid installation ID.');
    }
    const nextId: string = response.installationId;
    identity.installationId = nextId;
    saveInstallationIdentity(identity);
    return nextId;
  }

  status(): Promise<any> {
    return this.call('/v1/status');
  }

  lease(requestId: string, sessionId: string): Promise<any> {
    return this.call('/v1/leases', { requestId, sessionId });
  }

  async checkout(plan: string): Promise<any> {
    if (!(LICENSE_PLAN_KEYS as readonly string[]).includes(plan)) {
      throw new EntitlementAccessError('INVALID_PLAN', 'Unknown Causyne plan.');
    }
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
  enabled: boolean;
  client: Pick<EntitlementClient, 'lease'>;
  sessionId: string;
  activeRuns: number;
  pausedRuns: number;
  leaseUntil: number;
  leasePlan: string | null;
  blockedError: unknown;
  timer: ReturnType<typeof setInterval> | null;
  pending: Promise<any> | null;
  listeners: Set<(error: unknown) => void>;

  constructor({ enabled = LICENSE_ENFORCEMENT_ENABLED, client = new EntitlementClient() }: EntitlementGateOptions = {}) {
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

  async ensureLease(): Promise<any> {
    if (!this.enabled) return { plan: 'development-disabled' };
    if (this.blockedError) throw this.blockedError;
    if (Date.now() + 500 < this.leaseUntil) return { plan: this.leasePlan };
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const requestId = crypto.randomUUID();
      const result = await this.client.lease(requestId, this.sessionId);
      const expiration = Date.parse(result?.expiresAt || '');
      if (!Number.isFinite(expiration) || expiration <= Date.now()) {
        throw new EntitlementAccessError('INVALID_LEASE', 'Licensing service returned an expired or invalid lease.');
      }
      this.leaseUntil = expiration;
      this.leasePlan = result.plan ?? null;
      this.blockedError = null;
      return result;
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async begin(onBlocked: (error: unknown) => void = () => {}): Promise<void> {
    if (!this.enabled) return;
    await this.ensureLease();
    this.activeRuns++;
    this.listeners.add(onBlocked);
    if (this.activeRuns === 1) {
      // In-process only while tasks run. No daemon or remotely accessible port.
      this.timer = setInterval(async () => {
        if (this.pausedRuns >= this.activeRuns || Date.now() < this.leaseUntil) return;
        try {
          await this.ensureLease();
        } catch (error: unknown) {
          this.blockedError = error;
          for (const listener of this.listeners) {
            try { listener(error); } catch { /* do not crash current tool */ }
          }
        }
      }, 1000);
      this.timer.unref?.();
    }
  }

  pause(): void {
    if (this.enabled) this.pausedRuns++;
  }

  resume(): void {
    if (this.enabled) this.pausedRuns = Math.max(0, this.pausedRuns - 1);
  }

  async beforeStep(): Promise<void> {
    if (!this.enabled) return;
    await this.ensureLease();
  }

  end(onBlocked?: (error: unknown) => void): void {
    if (!this.enabled) return;
    if (onBlocked) this.listeners.delete(onBlocked);
    this.activeRuns = Math.max(0, this.activeRuns - 1);
    this.pausedRuns = Math.min(this.pausedRuns, this.activeRuns);
    if (this.activeRuns === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

let processGate: EntitlementGate | undefined;
export function getProcessEntitlementGate(): EntitlementGate {
  return processGate ||= new EntitlementGate();
}

export async function runLicenseCommand(action = 'status', plan = ''): Promise<void> {
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
