/**
 * Causyne Agent — OpenRouter Free Authentication & OAuth PKCE Flow
 *
 * Implements the official OpenRouter OAuth PKCE authorization with S256,
 * loopback callback server on ephemeral 127.0.0.1 port, headless/manual fallback,
 * and secure credential storage in Causyne's encrypted configuration vault.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import { loadConfig, saveConfig } from '../config.js';
import { openWithNativeOS } from '../tools/desktopOpen.js';
export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
export const OPENROUTER_TOKEN_EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';
export const OPENROUTER_FREE_MODEL = 'openrouter/free';
export class OpenRouterAuthError extends Error {
    constructor(message) {
        super(message);
        this.name = 'OpenRouterAuthError';
    }
}
/**
 * Generate cryptographically secure PKCE verifier, S256 challenge, and CSRF state token.
 */
export function generatePkceCodes() {
    // 32 random bytes as base64url string yields 43 characters (RFC 7636 compliant: 43-128 chars)
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    return {
        codeVerifier,
        codeChallenge,
        codeChallengeMethod: 'S256',
        state
    };
}
/**
 * Build the official OpenRouter OAuth authorization URL.
 */
export function buildAuthorizationUrl(callbackUrl, codeChallenge, state) {
    const url = new URL(OPENROUTER_AUTH_URL);
    url.searchParams.set('callback_url', callbackUrl);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    return url.toString();
}
/**
 * Exchange the authorization code for an OpenRouter API key using PKCE verifier.
 */
export async function exchangeCodeForApiKey(code, codeVerifier, fetchFn = fetch) {
    const cleanCode = (code || '').trim();
    const cleanVerifier = (codeVerifier || '').trim();
    if (!cleanCode) {
        throw new OpenRouterAuthError('Authorization code cannot be empty.');
    }
    if (!cleanVerifier) {
        throw new OpenRouterAuthError('PKCE code verifier cannot be empty.');
    }
    const payload = {
        code: cleanCode,
        code_verifier: cleanVerifier,
        code_challenge_method: 'S256'
    };
    let response;
    try {
        response = await fetchFn(OPENROUTER_TOKEN_EXCHANGE_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://causyne.com',
                'X-Title': 'Causyne Agent'
            },
            body: JSON.stringify(payload)
        });
    }
    catch (err) {
        throw new OpenRouterAuthError(`Failed to reach OpenRouter token exchange: ${err?.message || err}`);
    }
    if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new OpenRouterAuthError(`OpenRouter token exchange failed (HTTP ${response.status}): ${errorBody || 'Invalid code or verifier'}`);
    }
    const data = (await response.json().catch(() => null));
    const apiKey = data?.key?.trim();
    if (!apiKey) {
        throw new OpenRouterAuthError('OpenRouter response did not contain an API key.');
    }
    return apiKey;
}
/**
 * Start loopback HTTP server on 127.0.0.1 to receive the OAuth redirect code.
 */
export async function startLoopbackAuth(options = {}) {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const openBrowser = options.openBrowser ?? true;
    const fetchFn = options.fetchFn ?? fetch;
    const pkce = generatePkceCodes();
    return new Promise((resolve, reject) => {
        let resolved = false;
        let timeoutTimer = null;
        const cleanup = () => {
            if (timeoutTimer) {
                clearTimeout(timeoutTimer);
                timeoutTimer = null;
            }
            try {
                server.close();
            }
            catch {
                // Ignore close errors
            }
        };
        const server = http.createServer(async (req, res) => {
            try {
                const reqUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
                if (reqUrl.pathname !== '/callback') {
                    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('Not Found');
                    return;
                }
                const code = reqUrl.searchParams.get('code');
                const state = reqUrl.searchParams.get('state');
                if (!state || state !== pkce.state) {
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end('<html><body style="font-family:sans-serif;padding:32px;background:#111;color:#eee;">' +
                        '<h2 style="color:#ef4444;">Authorization Error: State Mismatch</h2>' +
                        '<p>The received CSRF verification state did not match the session. Please try again.</p>' +
                        '</body></html>');
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        reject(new OpenRouterAuthError('State mismatch detected during OpenRouter callback.'));
                    }
                    return;
                }
                if (!code) {
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end('<html><body style="font-family:sans-serif;padding:32px;background:#111;color:#eee;">' +
                        '<h2 style="color:#ef4444;">Authorization Failed</h2>' +
                        '<p>No authorization code was returned by OpenRouter.</p>' +
                        '</body></html>');
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        reject(new OpenRouterAuthError('No authorization code returned from callback.'));
                    }
                    return;
                }
                // Send friendly HTML response to user's browser
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<html><body style="font-family:sans-serif;padding:40px;background:#0d1117;color:#c9d1d9;text-align:center;">' +
                    '<h2 style="color:#2ea043;margin-bottom:12px;">Causyne Agent Connected Successfully</h2>' +
                    '<p style="font-size:16px;color:#8b949e;">Your OpenRouter account has been authorized. You can close this window and return to your terminal.</p>' +
                    '</body></html>');
                // Perform token exchange
                const apiKey = await exchangeCodeForApiKey(code, pkce.codeVerifier, fetchFn);
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    resolve({ apiKey });
                }
            }
            catch (err) {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    reject(err);
                }
            }
        });
        server.on('error', (err) => {
            if (!resolved) {
                resolved = true;
                cleanup();
                reject(new OpenRouterAuthError(`Loopback server failed to bind: ${err.message}`));
            }
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                cleanup();
                reject(new OpenRouterAuthError('Failed to retrieve loopback server port.'));
                return;
            }
            const callbackUrl = `http://127.0.0.1:${addr.port}/callback`;
            const authUrl = buildAuthorizationUrl(callbackUrl, pkce.codeChallenge, pkce.state);
            if (options.onUrlReady) {
                options.onUrlReady(authUrl);
            }
            if (openBrowser) {
                openWithNativeOS(authUrl).catch(() => {
                    // If browser opening fails, user can copy URL manually
                });
            }
            timeoutTimer = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    reject(new OpenRouterAuthError(`Authorization timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
                }
            }, timeoutMs);
        });
    });
}
/**
 * Mask an API key for safe display in logs and status screens.
 */
export function maskApiKey(key) {
    const clean = (key || '').trim();
    if (!clean)
        return 'none';
    if (clean.length <= 8)
        return '********';
    return `${clean.slice(0, 7)}...${clean.slice(-4)}`;
}
/**
 * Save user OpenRouter key into local encrypted configuration vault.
 */
export function saveOpenRouterKey(apiKey, options = {}) {
    const cleanKey = (apiKey || '').trim();
    if (!cleanKey) {
        throw new OpenRouterAuthError('Cannot save an empty OpenRouter API key.');
    }
    const store = options.store || { loadConfig, saveConfig };
    const currentConfig = store.loadConfig() || {};
    const providerKeys = {
        ...(currentConfig.providerKeys && typeof currentConfig.providerKeys === 'object' ? currentConfig.providerKeys : {})
    };
    providerKeys['openrouter'] = cleanKey;
    currentConfig.providerKeys = providerKeys;
    if (options.dataCollection) {
        currentConfig.openrouterDataCollection = options.dataCollection;
    }
    else if (!currentConfig.openrouterDataCollection) {
        currentConfig.openrouterDataCollection = 'deny';
    }
    if (options.setAsActive) {
        currentConfig.provider = 'openrouter';
        currentConfig.model = OPENROUTER_FREE_MODEL;
        currentConfig.apiKey = cleanKey;
    }
    store.saveConfig(currentConfig);
    return currentConfig;
}
/**
 * Disconnect OpenRouter credentials from local vault.
 */
export function disconnectOpenRouter(store = { loadConfig, saveConfig }) {
    const currentConfig = store.loadConfig() || {};
    const providerKeys = {
        ...(currentConfig.providerKeys && typeof currentConfig.providerKeys === 'object' ? currentConfig.providerKeys : {})
    };
    delete providerKeys['openrouter'];
    currentConfig.providerKeys = providerKeys;
    if (currentConfig.provider === 'openrouter') {
        currentConfig.provider = 'deepseek';
        currentConfig.model = 'deepseek-chat';
        currentConfig.apiKey = providerKeys['deepseek'] || '';
    }
    store.saveConfig(currentConfig);
    return currentConfig;
}
/**
 * Retrieve live OpenRouter connection and privacy status.
 */
export function getOpenRouterStatus(cfg) {
    const config = cfg || loadConfig() || {};
    const vaultKey = config.providerKeys?.openrouter || (config.provider === 'openrouter' ? config.apiKey : '');
    const envKey = process.env.OPENROUTER_API_KEY;
    const connectedKey = vaultKey || envKey || '';
    const isConnected = Boolean(connectedKey);
    const isActive = config.provider === 'openrouter';
    const currentModel = isActive ? (config.model || OPENROUTER_FREE_MODEL) : OPENROUTER_FREE_MODEL;
    const dataCollection = config.openrouterDataCollection === 'allow' ? 'allow' : 'deny';
    return {
        connected: isConnected,
        active: isActive,
        model: currentModel,
        dataCollection,
        maskedKey: isConnected ? maskApiKey(connectedKey) : undefined,
        keySource: vaultKey ? 'vault' : (envKey ? 'environment' : undefined)
    };
}
/**
 * Update user's OpenRouter data collection preference.
 */
export function setOpenRouterDataCollection(preference, store = { loadConfig, saveConfig }) {
    const config = store.loadConfig() || {};
    config.openrouterDataCollection = preference;
    store.saveConfig(config);
    return config;
}
