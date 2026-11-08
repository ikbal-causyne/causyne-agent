/**
 * Causyne Agent — OpenRouter Free Authentication & OAuth PKCE Flow
 *
 * Implements the official OpenRouter OAuth PKCE authorization with S256,
 * loopback callback server on ephemeral 127.0.0.1 port, headless/manual fallback,
 * and secure credential storage in Causyne's encrypted configuration vault.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { loadConfig, saveConfig } from '../config.js';
import { openWithNativeOS } from '../tools/desktopOpen.js';

export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
export const OPENROUTER_TOKEN_EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';
export const OPENROUTER_FREE_MODEL = 'openrouter/free';

export interface PkceCodes {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  state: string;
}

export interface OpenRouterStatus {
  connected: boolean;
  active: boolean;
  model: string;
  dataCollection: 'deny' | 'allow';
  maskedKey?: string | undefined;
  keySource?: 'vault' | 'environment' | undefined;
}

export class OpenRouterAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterAuthError';
  }
}

/**
 * Generate cryptographically secure PKCE verifier, S256 challenge, and CSRF state token.
 */
export function generatePkceCodes(): PkceCodes {
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
export function buildAuthorizationUrl(callbackUrl: string, codeChallenge: string, state: string): string {
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
export async function exchangeCodeForApiKey(
  code: string,
  codeVerifier: string,
  fetchFn: typeof fetch = fetch
): Promise<string> {
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

  let response: Response;
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
  } catch (err: any) {
    throw new OpenRouterAuthError(`Failed to reach OpenRouter token exchange: ${err?.message || err}`);
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new OpenRouterAuthError(
      `OpenRouter token exchange failed (HTTP ${response.status}): ${errorBody || 'Invalid code or verifier'}`
    );
  }

  const data = (await response.json().catch(() => null)) as { key?: string } | null;
  const apiKey = data?.key?.trim();
  if (!apiKey) {
    throw new OpenRouterAuthError('OpenRouter response did not contain an API key.');
  }

  return apiKey;
}

/**
 * Retrieve the Causyne Agent emblem logo encoded as Base64.
 */
export function getLogoBuffer(): Buffer | null {
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(currentDir, '../assets/logo.png'),
      path.resolve(currentDir, '../../assets/logo.png'),
      path.resolve(currentDir, '../../../public/assets/logo-200.png'),
      path.resolve(process.cwd(), 'src/assets/logo.png'),
      path.resolve(process.cwd(), 'assets/logo.png')
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate);
      }
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

/**
 * Retrieve the Causyne Agent emblem logo encoded as Base64.
 */
export function getLogoBase64(): string {
  const buf = getLogoBuffer();
  return buf ? buf.toString('base64') : '';
}

export interface RenderAuthPageOptions {
  status: 'success' | 'error';
  title?: string | undefined;
  message?: string | undefined;
  errorDetail?: string | undefined;
  model?: string | undefined;
}

/**
 * Render a professional branded HTML response page for OpenRouter OAuth callbacks
 * following the exact visual style and design language of causyne.com.
 */
export function renderAuthPage(options: RenderAuthPageOptions): string {
  const isSuccess = options.status === 'success';
  const base64Logo = getLogoBase64();
  const logoSrc = base64Logo ? `data:image/png;base64,${base64Logo}` : '/logo.png';

  const badgeHtml = isSuccess
    ? '<div style="display:inline-flex;align-items:center;gap:6px;' +
      'background:rgba(157,240,40,0.12);border:1px solid rgba(157,240,40,0.35);color:#9df028;' +
      'padding:5px 14px;border-radius:4px;font-size:12px;font-family:\'SF Mono\',Menlo,monospace;font-weight:600;margin-bottom:20px;">' +
      '✓ Connected Successfully</div>'
    : '<div style="display:inline-flex;align-items:center;gap:6px;' +
      'background:rgba(239,83,80,0.12);border:1px solid rgba(239,83,80,0.35);color:#ef5350;' +
      'padding:5px 14px;border-radius:4px;font-size:12px;font-family:\'SF Mono\',Menlo,monospace;font-weight:600;margin-bottom:20px;">' +
      '✕ Authorization Failed</div>';

  const title = options.title || (isSuccess ? 'OpenRouter Account Authorized' : 'Authorization Error');
  const defaultMsg = isSuccess
    ? 'Your OpenRouter account is now authorized and connected to Causyne Agent. You can close this window and return to your terminal.'
    : 'The authorization flow could not be completed.';
  const message = options.message || defaultMsg;

  const contentBox = isSuccess
    ? '<div style="background:#191c19;border:1px solid rgba(255,255,255,0.07);' +
      'border-radius:6px;padding:14px 18px;margin-bottom:24px;text-align:left;font-family:\'SF Mono\',Menlo,Monaco,Consolas,monospace;' +
      'font-size:12px;line-height:1.7;color:#e4e8e0;">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:6px;">' +
      '<span style="color:#9da697;">Provider</span>' +
      '<span style="color:#e4e8e0;font-weight:600;">OpenRouter</span>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:6px;">' +
      '<span style="color:#9da697;">Active Model</span>' +
      `<span style="color:#9df028;font-weight:600;">${options.model || OPENROUTER_FREE_MODEL}</span>` +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;">' +
      '<span style="color:#9da697;">Privacy Guard</span>' +
      '<span style="color:#9da697;">provider.data_collection = &quot;deny&quot;</span>' +
      '</div>' +
      '</div>'
    : '<div style="background:#191c19;border:1px solid rgba(239,83,80,0.25);' +
      'border-radius:6px;padding:14px;color:#fca5a5;font-size:13px;line-height:1.6;margin-bottom:20px;' +
      `text-align:left;font-family:\'SF Mono\',Menlo,monospace;">${options.errorDetail || 'An unexpected error occurred during authorization.'}</div>` +
      '<div style="background:#191c19;border:1px solid rgba(255,255,255,0.07);' +
      'border-radius:6px;padding:16px;margin-bottom:24px;text-align:left;font-size:13px;">' +
      '<div style="color:#e4e8e0;font-weight:600;margin-bottom:8px;">Recommended Solutions:</div>' +
      '<ol style="color:#9da697;line-height:1.6;margin:0;padding-left:18px;">' +
      '<li>Return to your terminal and select OpenRouter in the FREE tab to retry.</li>' +
      '<li>Or obtain a free API key at <a href="https://openrouter.ai/keys" target="_blank" ' +
      'style="color:#9df028;text-decoration:none;">openrouter.ai/keys</a> and connect directly via:</li>' +
      '</ol>' +
      '<pre style="background:#141714;color:#9df028;padding:10px 14px;border-radius:4px;font-family:\'SF Mono\',Menlo,monospace;' +
      'font-size:12px;margin-top:10px;border:1px solid rgba(255,255,255,0.07);overflow-x:auto;">causyne config set providerKeys.openrouter &lt;your-key&gt;</pre>' +
      '</div>';

  const actionButton = isSuccess
    ? '<button id="return-btn" onclick="returnToTerminal()" style="background:#9df028;color:#141714;border:none;' +
      'padding:11px 26px;border-radius:4px;font-size:13px;font-weight:700;cursor:pointer;' +
      'font-family:\'SF Mono\',Menlo,monospace;letter-spacing:0.5px;transition:background 0.15s ease;">' +
      'Return to Terminal</button>' +
      '<div id="return-hint" style="font-size:12px;color:#60685b;margin-top:14px;line-height:1.5;">' +
      'Authentication complete. You can close this browser tab (⌘W / Ctrl+W) and switch back to your terminal.' +
      '</div>'
    : '<button onclick="window.close()" style="background:#202421;color:#e4e8e0;border:1px solid rgba(255,255,255,0.15);' +
      'padding:10px 22px;border-radius:4px;font-size:13px;font-weight:600;cursor:pointer;' +
      'font-family:\'SF Mono\',Menlo,monospace;">' +
      'Close Window</button>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Causyne Agent Connected Successfully</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background-color: #141714;
      color: #e4e8e0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .container {
      max-width: 500px;
      width: 100%;
      text-align: center;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
      margin-bottom: 24px;
    }
    .logo {
      width: 40px;
      height: 40px;
      object-fit: contain;
    }
    .brand-title {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 20px;
      font-weight: 800;
      letter-spacing: 1.5px;
      color: #e4e8e0;
      line-height: 1.2;
      text-align: left;
    }
    .brand-subtitle {
      font-family: 'SF Mono', SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      color: #9da697;
      letter-spacing: 0.5px;
      margin-top: 2px;
      text-align: left;
    }
    .brand-slogan {
      font-family: 'SF Mono', SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      color: #60685b;
      margin-top: 1px;
      text-align: left;
    }
    .card {
      background: #202421;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px;
      padding: 32px 28px;
    }
    h1 {
      color: #e4e8e0;
      font-size: 19px;
      font-weight: 700;
      margin-bottom: 10px;
      letter-spacing: -0.2px;
    }
    p {
      color: #9da697;
      font-size: 13px;
      line-height: 1.6;
      margin-bottom: 22px;
    }
  </style>
  <script>
    function returnToTerminal() {
      try {
        window.open('', '_self', '');
        window.close();
      } catch (e) {}
      var btn = document.getElementById('return-btn');
      if (btn) {
        btn.textContent = '✓ Ready! Switch to Terminal';
        btn.style.background = '#8ea954';
      }
      var hint = document.getElementById('return-hint');
      if (hint) {
        hint.innerHTML = '<span style="color:#B5D66A;font-weight:600;">Authentication complete!</span> Switch back to your terminal window (Cmd+Tab / Alt+Tab). You can close this tab (Cmd+W / Ctrl+W).';
      }
    }
  </script>
</head>
<body>
  <div class="container">
    <div class="header">
      <img src="${logoSrc}" alt="Causyne Agent Logo" class="logo" />
      <div>
        <div class="brand-title">CAUSYNE <span style="color:#9df028;">AGENT</span></div>
        <div class="brand-subtitle">Agentic AI Harness</div>
        <div class="brand-slogan">From intention to meaningful progress.</div>
      </div>
    </div>
    <div class="card">
      ${badgeHtml}
      <h1>${title}</h1>
      <p>${message}</p>
      ${contentBox}
      ${actionButton}
    </div>
  </div>
</body>
</html>`;
}

/**
 * Start loopback HTTP server on 127.0.0.1 to receive the OAuth redirect code.
 */
export async function startLoopbackAuth(options: {
  timeoutMs?: number;
  openBrowser?: boolean;
  fetchFn?: typeof fetch;
  onUrlReady?: (url: string) => void;
} = {}): Promise<{ apiKey: string }> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const openBrowser = options.openBrowser ?? true;
  const fetchFn = options.fetchFn ?? fetch;

  const pkce = generatePkceCodes();

  return new Promise<{ apiKey: string }>((resolve, reject) => {
    let resolved = false;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      try {
        server.close();
      } catch {
        // Ignore close errors
      }
    };

    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

        if (reqUrl.pathname === '/logo.png') {
          const logoBuf = getLogoBuffer();
          if (logoBuf) {
            res.writeHead(200, {
              'Content-Type': 'image/png',
              'Content-Length': logoBuf.length,
              'Cache-Control': 'public, max-age=3600'
            });
            res.end(logoBuf);
            return;
          }
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }

        if (reqUrl.pathname !== '/callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }

        const code = reqUrl.searchParams.get('code');
        const state = reqUrl.searchParams.get('state');

        if (!state || state !== pkce.state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            renderAuthPage({
              status: 'error',
              title: 'Authorization Error: State Mismatch',
              errorDetail: 'The received CSRF verification state did not match the active session. This can happen if the authorization request timed out or was tampered with.'
            })
          );
          if (!resolved) {
            resolved = true;
            cleanup();
            reject(new OpenRouterAuthError('State mismatch detected during OpenRouter callback.'));
          }
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            renderAuthPage({
              status: 'error',
              title: 'Authorization Failed',
              errorDetail: 'No authorization code was returned by OpenRouter.'
            })
          );
          if (!resolved) {
            resolved = true;
            cleanup();
            reject(new OpenRouterAuthError('No authorization code returned from callback.'));
          }
          return;
        }

        // Send friendly HTML response to user's browser
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          renderAuthPage({
            status: 'success',
            model: OPENROUTER_FREE_MODEL
          })
        );

        // Perform token exchange
        const apiKey = await exchangeCodeForApiKey(code, pkce.codeVerifier, fetchFn);

        if (!resolved) {
          resolved = true;
          setTimeout(cleanup, 1200);
          resolve({ apiKey });
        }
      } catch (err: any) {
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
export function maskApiKey(key: string): string {
  const clean = (key || '').trim();
  if (!clean) return 'none';
  if (clean.length <= 8) return '********';
  return `${clean.slice(0, 7)}...${clean.slice(-4)}`;
}

/**
 * Save user OpenRouter key into local encrypted configuration vault.
 */
export function saveOpenRouterKey(
  apiKey: string,
  options: {
    dataCollection?: 'deny' | 'allow';
    setAsActive?: boolean;
    store?: { loadConfig(): any; saveConfig(cfg: any): void };
  } = {}
): Record<string, any> {
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
  } else if (!currentConfig.openrouterDataCollection) {
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
export function disconnectOpenRouter(
  store: { loadConfig(): any; saveConfig(cfg: any): void } = { loadConfig, saveConfig }
): Record<string, any> {
  const currentConfig = store.loadConfig() || {};
  const providerKeys = {
    ...(currentConfig.providerKeys && typeof currentConfig.providerKeys === 'object' ? currentConfig.providerKeys : {})
  };

  delete providerKeys['openrouter'];
  currentConfig.providerKeys = providerKeys;

  if (process.env.OPENROUTER_API_KEY) {
    delete process.env.OPENROUTER_API_KEY;
  }

  if (currentConfig.provider === 'openrouter') {
    if (providerKeys['deepseek']) {
      currentConfig.provider = 'deepseek';
      currentConfig.model = 'deepseek-chat';
      currentConfig.apiKey = providerKeys['deepseek'];
    } else if (providerKeys['anthropic']) {
      currentConfig.provider = 'anthropic';
      currentConfig.model = 'claude-3-7-sonnet';
      currentConfig.apiKey = providerKeys['anthropic'];
    } else if (providerKeys['openai']) {
      currentConfig.provider = 'openai';
      currentConfig.model = 'gpt-4o';
      currentConfig.apiKey = providerKeys['openai'];
    } else {
      currentConfig.provider = 'antigravity';
      currentConfig.model = 'Gemini 3.8 Flash (Low)';
      currentConfig.apiKey = '';
    }
  }

  store.saveConfig(currentConfig);
  return currentConfig;
}

/**
 * Retrieve live OpenRouter connection and privacy status.
 */
export function getOpenRouterStatus(cfg?: Record<string, any>): OpenRouterStatus {
  const config = cfg || loadConfig() || {};
  const vaultKey = config.providerKeys?.openrouter || (config.provider === 'openrouter' ? config.apiKey : '');
  const envKey = process.env.OPENROUTER_API_KEY;

  const connectedKey = vaultKey || envKey || '';
  const isConnected = Boolean(connectedKey);
  const isActive = config.provider === 'openrouter';
  const currentModel = isActive ? (config.model || OPENROUTER_FREE_MODEL) : OPENROUTER_FREE_MODEL;
  const dataCollection: 'deny' | 'allow' = config.openrouterDataCollection === 'allow' ? 'allow' : 'deny';

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
export function setOpenRouterDataCollection(
  preference: 'deny' | 'allow',
  store: { loadConfig(): any; saveConfig(cfg: any): void } = { loadConfig, saveConfig }
): Record<string, any> {
  const config = store.loadConfig() || {};
  config.openrouterDataCollection = preference;
  store.saveConfig(config);
  return config;
}
