import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { causyneHome } from '../utils/paths.js';
import { LICENSE_API_BASE, LICENSE_CHECKOUT_ALLOWED_HOST_SUFFIX, LICENSE_ENFORCEMENT_ENABLED, LICENSE_PLAN_KEYS, MAX_ENTITLEMENT_RESPONSE_BYTES, isValidLicensePlan } from './policy.js';
import { redactProviderSecrets } from '../providers/byokHttp.js';
import { safeDisplay } from '../tui/text.js';
const TOKEN_FILE = 'installation-identity.json';
const USER_AGENT = 'Causyne-Agent/entitlements-v1';
const AUTH_TIMEOUT_MS = 10000;
const MAX_IDENTITY_BYTES = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class EntitlementAccessError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'EntitlementAccessError';
        this.code = code;
    }
}
function base64url(input) {
    return Buffer.from(input).toString('base64url');
}
function digest(input) {
    return base64url(crypto.createHash('sha256').update(input).digest());
}
function sign(text, privateKey) {
    return base64url(crypto.sign(null, Buffer.from(text), privateKey));
}
function requestText(method, pathname, timestamp, nonce, hash) {
    return ['CAUSYNE_API_V1', method.toUpperCase(), pathname, timestamp, nonce, hash].join('\n');
}
function registrationText(key, nonce) {
    return ['CAUSYNE_REGISTER_V1', key, nonce].join('\n');
}
function requireIdentityFields(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.privateKeyPem !== 'string'
        || typeof value.publicKey !== 'string') {
        throw new EntitlementAccessError('IDENTITY_CORRUPT', 'The local Causyne installation identity is damaged. Contact support; do not delete it while recovering a paid license.');
    }
    const record = value;
    const privateKeyPem = record.privateKeyPem;
    const publicKey = record.publicKey;
    const installationId = record.installationId;
    let derived;
    try {
        const key = crypto.createPrivateKey(privateKeyPem);
        derived = base64url(crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }));
    }
    catch {
        throw new EntitlementAccessError('IDENTITY_CORRUPT', 'Installation private key is unreadable or corrupted.');
    }
    if (derived !== publicKey) {
        throw new EntitlementAccessError('IDENTITY_CORRUPT', 'Installation public/private keys disagree.');
    }
    if (installationId && (typeof installationId !== 'string' || !UUID_RE.test(installationId))) {
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
export function loadInstallationIdentity(stateRoot = causyneHome(), depth = 0) {
    if (typeof stateRoot !== 'string' || !stateRoot.trim() || stateRoot.includes('\0')) {
        throw new EntitlementAccessError('IDENTITY_CORRUPT', 'Invalid state directory for installation identity.');
    }
    const resolvedRoot = path.resolve(stateRoot);
    if (!fs.existsSync(resolvedRoot)) {
        fs.mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
    }
    else {
        const dirStat = fs.lstatSync(resolvedRoot);
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
            throw new EntitlementAccessError('IDENTITY_CORRUPT', 'Refusing symlink or non-directory state root.');
        }
    }
    if (process.platform !== 'win32') {
        try {
            fs.chmodSync(resolvedRoot, 0o700);
        }
        catch { /* ignore */ }
    }
    const file = path.join(resolvedRoot, TOKEN_FILE);
    try {
        const fileStat = fs.lstatSync(file);
        if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size > MAX_IDENTITY_BYTES) {
            throw new EntitlementAccessError('IDENTITY_CORRUPT', 'Installation identity file must be a regular non-symlink file.');
        }
        const value = requireIdentityFields(JSON.parse(fs.readFileSync(file, 'utf8')));
        return { ...value, file };
    }
    catch (error) {
        if (error instanceof EntitlementAccessError)
            throw error;
        const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
        if (code !== 'ENOENT')
            throw error;
    }
    const pair = crypto.generateKeyPairSync('ed25519');
    const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKey = base64url(pair.publicKey.export({ type: 'spki', format: 'der' }));
    const identity = { version: 1, publicKey, privateKeyPem, installationId: null };
    // Exclusive create prevents a second running CLI from replacing this identity.
    let fd;
    try {
        fd = fs.openSync(file, 'wx', 0o600);
        const buf = Buffer.from(JSON.stringify(identity), 'utf8');
        fs.writeSync(fd, buf, 0, buf.length);
        fs.fsyncSync(fd);
    }
    catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
        if (code === 'EEXIST' && depth < 3)
            return loadInstallationIdentity(resolvedRoot, depth + 1);
        throw error;
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
    }
    if (process.platform !== 'win32') {
        try {
            fs.chmodSync(file, 0o600);
        }
        catch { /* ignore */ }
    }
    return { ...identity, file };
}
function saveInstallationIdentity(identity) {
    const value = {
        version: 1,
        privateKeyPem: identity.privateKeyPem,
        publicKey: identity.publicKey,
        installationId: identity.installationId
    };
    const file = identity.file;
    try {
        const existing = fs.lstatSync(file);
        if (existing.isSymbolicLink() || !existing.isFile()) {
            throw new EntitlementAccessError('IDENTITY_CORRUPT', 'Refusing to overwrite symlink or non-regular identity file.');
        }
    }
    catch (err) {
        if (err instanceof EntitlementAccessError)
            throw err;
        const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
        if (code !== 'ENOENT')
            throw err;
    }
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const payload = Buffer.from(JSON.stringify(value), 'utf8');
    try {
        const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
        try {
            fs.writeSync(fd, payload, 0, payload.length);
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temp, file);
        if (process.platform !== 'win32') {
            try {
                fs.chmodSync(file, 0o600);
            }
            catch { /* Windows ACLs differ */ }
        }
    }
    finally {
        try {
            fs.unlinkSync(temp);
        }
        catch { /* rename removed it */ }
    }
}
export class EntitlementClient {
    apiBase;
    stateRoot;
    fetchFn;
    identity;
    registerPromise;
    constructor(options) {
        const safeOpts = options && typeof options === 'object' ? options : {};
        const apiBase = safeOpts.apiBase ?? LICENSE_API_BASE;
        const stateRoot = safeOpts.stateRoot ?? causyneHome();
        const fetchFn = safeOpts.fetchFn ?? globalThis.fetch;
        const url = new URL(apiBase);
        if (url.username || url.password) {
            throw new Error('Entitlement service URL must not embed credentials.');
        }
        const isLoopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '::1';
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
            throw new Error('Entitlement service requires HTTPS.');
        }
        if (typeof fetchFn !== 'function') {
            throw new Error('Entitlement client requires a valid fetch implementation.');
        }
        this.apiBase = url.origin;
        this.stateRoot = stateRoot;
        this.fetchFn = fetchFn;
        this.identity = null;
        this.registerPromise = null;
    }
    async call(pathname, body, { register = false } = {}) {
        if (typeof pathname !== 'string'
            || !pathname.startsWith('/')
            || pathname.startsWith('//')
            || pathname.length > 256
            || pathname.includes('..')
            || /[\s\r\n\0]/.test(pathname)) {
            throw new EntitlementAccessError('INVALID_REQUEST', 'Invalid entitlement API path.');
        }
        const identity = this.identity ||= loadInstallationIdentity(this.stateRoot);
        const method = body === undefined ? 'GET' : 'POST';
        let raw = '';
        if (body !== undefined) {
            try {
                const serialized = JSON.stringify(body);
                if (typeof serialized !== 'string') {
                    throw new EntitlementAccessError('INVALID_REQUEST', 'Entitlement request payload is not JSON-serializable.');
                }
                raw = serialized;
            }
            catch (err) {
                if (err instanceof EntitlementAccessError)
                    throw err;
                throw new EntitlementAccessError('INVALID_REQUEST', 'Entitlement request payload is not JSON-serializable.');
            }
        }
        const headers = {
            'user-agent': USER_AGENT,
            'accept': 'application/json',
            'content-type': 'application/json'
        };
        if (!register) {
            if (!identity.installationId)
                await this.register();
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
                redirect: 'error',
                ...(body !== undefined ? { body: raw } : {}),
                signal: controller.signal
            });
            const declaredLength = Number(response.headers?.get?.('content-length') || '0');
            if (Number.isFinite(declaredLength) && declaredLength > MAX_ENTITLEMENT_RESPONSE_BYTES) {
                throw new EntitlementAccessError('SERVICE_ERROR', 'Entitlement service response exceeded size limit.');
            }
            let parsed = {};
            if (typeof response.text === 'function') {
                const rawText = await response.text().catch(() => '');
                if (Buffer.byteLength(rawText, 'utf8') > MAX_ENTITLEMENT_RESPONSE_BYTES) {
                    throw new EntitlementAccessError('SERVICE_ERROR', 'Entitlement service response exceeded size limit.');
                }
                if (rawText.trim()) {
                    try {
                        parsed = JSON.parse(rawText);
                    }
                    catch {
                        parsed = {};
                    }
                }
            }
            else {
                parsed = await response.json().catch(() => ({}));
            }
            if (!response.ok) {
                const errCode = typeof parsed?.error === 'string' && /^[A-Z0-9_]{1,64}$/i.test(parsed.error)
                    ? parsed.error
                    : 'SERVICE_ERROR';
                const errMessage = typeof parsed?.message === 'string' && parsed.message.trim()
                    ? safeDisplay(redactProviderSecrets(parsed.message)).slice(0, 400)
                    : `Entitlement service returned HTTP ${response.status}.`;
                throw new EntitlementAccessError(errCode, errMessage);
            }
            return parsed;
        }
        catch (error) {
            if (error instanceof EntitlementAccessError)
                throw error;
            throw new EntitlementAccessError('NETWORK_UNAVAILABLE', 'Cannot reach the Causyne licensing service. The current task is preserved; retry when connected.');
        }
        finally {
            clearTimeout(timeout);
        }
    }
    async register() {
        const identity = this.identity ||= loadInstallationIdentity(this.stateRoot);
        if (identity.installationId)
            return identity.installationId;
        if (this.registerPromise)
            return this.registerPromise;
        this.registerPromise = (async () => {
            const nonce = crypto.randomBytes(24).toString('base64url');
            const response = await this.call('/v1/installations', {
                publicKey: identity.publicKey,
                nonce,
                proof: sign(registrationText(identity.publicKey, nonce), identity.privateKeyPem)
            }, { register: true });
            if (typeof response?.installationId !== 'string' || !UUID_RE.test(response.installationId)) {
                throw new EntitlementAccessError('REGISTRATION_ERROR', 'Licensing service returned an invalid installation ID.');
            }
            const nextId = response.installationId;
            identity.installationId = nextId;
            saveInstallationIdentity(identity);
            return nextId;
        })().finally(() => {
            this.registerPromise = null;
        });
        return this.registerPromise;
    }
    status() {
        return this.call('/v1/status');
    }
    lease(requestId, sessionId) {
        return this.call('/v1/leases', { requestId, sessionId });
    }
    async checkout(plan) {
        if (!LICENSE_PLAN_KEYS.includes(plan)) {
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
    enabled;
    client;
    sessionId;
    activeRuns;
    pausedRuns;
    leaseUntil;
    leasePlan;
    blockedError;
    timer;
    pending;
    listeners;
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
        if (!this.enabled)
            return { plan: 'development-disabled' };
        if (this.blockedError)
            throw this.blockedError;
        if (Date.now() + 500 < this.leaseUntil)
            return { plan: this.leasePlan };
        if (this.pending)
            return this.pending;
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
    async begin(onBlocked = () => { }) {
        if (!this.enabled)
            return;
        await this.ensureLease();
        this.activeRuns++;
        this.listeners.add(onBlocked);
        if (this.activeRuns === 1) {
            // In-process only while tasks run. No daemon or remotely accessible port.
            this.timer = setInterval(async () => {
                if (this.pausedRuns >= this.activeRuns || Date.now() < this.leaseUntil)
                    return;
                try {
                    await this.ensureLease();
                }
                catch (error) {
                    this.blockedError = error;
                    for (const listener of this.listeners) {
                        try {
                            listener(error);
                        }
                        catch { /* do not crash current tool */ }
                    }
                }
            }, 1000);
            this.timer.unref?.();
        }
    }
    pause() {
        if (this.enabled)
            this.pausedRuns++;
    }
    resume() {
        if (this.enabled)
            this.pausedRuns = Math.max(0, this.pausedRuns - 1);
    }
    async beforeStep() {
        if (!this.enabled)
            return;
        await this.ensureLease();
    }
    end(onBlocked) {
        if (!this.enabled)
            return;
        if (onBlocked)
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
        if (data.paidUntil)
            console.log(`Paid through: ${data.paidUntil}`);
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
