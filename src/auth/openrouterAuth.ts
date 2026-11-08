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
      path.resolve(currentDir, '../../src/assets/logo.png'),
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

const CAUSYNE_LOGO_SVG = [
  '<svg class="brand-logo" viewBox="312 272 628 695" width="34" height="34" role="img" aria-label="Causyne Logo">',
  '<title>Causyne</title>',
  '<path fill="#fff" fill-rule="evenodd" d="M619 957C596 952 563 933 555 919C549 90',
  '8 543 905 530 905C526 905 520 905 517 905C511 905 498 902 492 899C487 896 433 86',
  '3 396 841C345 811 332 798 325 767C321 752 321 713 325 708C332 699 333 688 328 67',
  '6C321 661 322 662 322 574C322 494 322 494 325 485C332 464 351 444 367 442C380 44',
  '1 387 433 391 418C394 401 403 390 422 380C427 377 453 362 479 348C505 334 540 31',
  '4 558 304C575 295 591 286 593 286C609 280 623 280 637 283C657 288 691 310 696 32',
  '2C702 334 716 339 730 335C739 332 754 335 766 342C775 347 834 382 866 401C905 42',
  '4 918 438 925 465C929 478 929 566 925 570C919 579 919 589 925 602C932 617 932 61',
  '8 932 689C932 752 932 752 930 761C923 787 902 807 881 808C869 808 861 815 857 82',
  '7C851 845 846 850 815 867C805 873 781 886 762 897C657 956 657 956 643 958C634 95',
  '9 627 959 619 957ZM651 945C658 942 676 932 756 887C776 876 800 863 810 857C832 8',
  '45 835 843 839 838C845 831 849 818 847 813C843 796 865 783 879 794C890 802 913 7',
  '82 919 758C921 751 921 747 921 689C921 613 921 613 908 596C898 584 901 566 914 5',
  '63C917 563 917 563 917 518C916 464 915 459 900 440C891 428 891 428 800 374C744 3',
  '42 739 340 720 350C701 360 687 352 687 330C687 324 679 316 660 305C640 294 636 2',
  '93 620 293C603 292 600 294 563 314C545 324 510 344 484 358C458 372 432 387 427 3',
  '90C405 402 399 413 403 432C406 447 393 459 378 455C367 452 361 454 350 464C332 4',
  '83 332 481 332 575C332 668 332 664 345 682C354 696 350 712 337 715L333 715L333 7',
  '36C334 764 337 775 347 790C358 806 356 805 462 867C512 897 516 899 534 891C545 8',
  '86 553 887 560 893C564 897 567 905 565 910C564 916 571 923 590 934C615 948 632 9',
  '51 651 945Z"/>',
  '<g fill="#fff" stroke="#fff" stroke-width="9.0" stroke-linejoin="round">',
  '<path fill-rule="evenodd" d="M620 949C599 944 566 924 563 915C562 908 564 904 61',
  '2 859C656 816 657 815 684 786C712 754 715 750 725 723C740 681 745 670 751 659C75',
  '4 652 757 646 758 646C760 646 768 659 788 696C795 708 808 731 818 748C848 801 85',
  '1 809 849 821C846 837 841 842 811 859C801 865 777 878 758 889C677 934 659 944 65',
  '2 947C643 950 628 951 620 949ZM510 895C500 893 504 895 400 833C351 804 340 793 3',
  '33 765C331 756 330 716 332 714C332 713 337 715 345 718C371 728 400 735 468 747C5',
  '09 754 516 754 602 754C666 754 678 754 678 755C678 758 661 775 575 859C538 895 5',
  '29 900 510 895ZM881 798C877 796 870 788 865 779C856 764 822 704 797 660C784 638 ',
  '769 612 763 601C721 531 710 510 711 510C712 509 727 511 734 513C742 516 812 541 ',
  '830 547C886 569 916 592 922 619C924 631 924 749 921 759C916 781 893 803 881 798Z',
  'M462 720C392 706 390 706 374 700C348 691 337 681 332 661C329 648 330 498 333 487',
  'C340 468 358 451 371 451C376 451 385 459 392 471C394 475 407 498 422 522C436 547',
  ' 454 578 462 592C471 607 488 637 502 659C539 723 543 729 543 730C543 734 529 732',
  ' 462 720ZM488 585C479 571 477 568 428 484C422 472 415 460 412 456C392 422 396 40',
  '4 426 388C431 385 457 370 483 356C509 342 544 322 562 312C599 291 602 290 620 29',
  '1C637 291 641 292 661 303C691 320 695 328 682 344C676 352 671 356 612 418C592 43',
  '8 568 463 559 473C551 484 541 495 538 499C530 507 526 516 520 536C511 567 499 59',
  '7 496 597C496 597 492 592 488 585Z"/>',
  '<path d="M908 559C885 543 853 528 797 508C741 489 744 489 650 489C589 489 580 48',
  '9 580 488C580 486 642 422 687 376C720 343 728 339 749 345C756 347 775 357 861 40',
  '8C898 430 908 441 916 466C919 474 920 565 918 565C917 565 913 562 908 559Z"/>',
  '</g>',
  '<path fill="#3a3f47" fill-rule="evenodd" d="M620 949C599 944 566 924 563 915C562',
  ' 908 564 904 612 859C656 816 657 815 684 786C712 754 715 750 725 723C740 681 745',
  ' 670 751 659C754 652 757 646 758 646C760 646 768 659 788 696C795 708 808 731 818',
  ' 748C848 801 851 809 849 821C846 837 841 842 811 859C801 865 777 878 758 889C677',
  ' 934 659 944 652 947C643 950 628 951 620 949ZM510 895C500 893 504 895 400 833C35',
  '1 804 340 793 333 765C331 756 330 716 332 714C332 713 337 715 345 718C371 728 40',
  '0 735 468 747C509 754 516 754 602 754C666 754 678 754 678 755C678 758 661 775 57',
  '5 859C538 895 529 900 510 895ZM881 798C877 796 870 788 865 779C856 764 822 704 7',
  '97 660C784 638 769 612 763 601C721 531 710 510 711 510C712 509 727 511 734 513C7',
  '42 516 812 541 830 547C886 569 916 592 922 619C924 631 924 749 921 759C916 781 8',
  '93 803 881 798ZM462 720C392 706 390 706 374 700C348 691 337 681 332 661C329 648 ',
  '330 498 333 487C340 468 358 451 371 451C376 451 385 459 392 471C394 475 407 498 ',
  '422 522C436 547 454 578 462 592C471 607 488 637 502 659C539 723 543 729 543 730C',
  '543 734 529 732 462 720ZM488 585C479 571 477 568 428 484C422 472 415 460 412 456',
  'C392 422 396 404 426 388C431 385 457 370 483 356C509 342 544 322 562 312C599 291',
  ' 602 290 620 291C637 291 641 292 661 303C691 320 695 328 682 344C676 352 671 356',
  ' 612 418C592 438 568 463 559 473C551 484 541 495 538 499C530 507 526 516 520 536',
  'C511 567 499 597 496 597C496 597 492 592 488 585Z"/>',
  '<path fill="#b6e06f" d="M908 559C885 543 853 528 797 508C741 489 744 489 650 489',
  'C589 489 580 489 580 488C580 486 642 422 687 376C720 343 728 339 749 345C756 347',
  ' 775 357 861 408C898 430 908 441 916 466C919 474 920 565 918 565C917 565 913 562',
  ' 908 559Z"/>',
  '</svg>'
].join('\n');

/**
 * Render a professional branded HTML response page for OpenRouter OAuth callbacks
 * following the exact visual style, typography, and design language of causyne.com.
 */
export function renderAuthPage(options: RenderAuthPageOptions): string {
  const isSuccess = options.status === 'success';

  const badgeHtml = isSuccess
    ? '<div class="panel-badge success">' +
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>' +
      '<span>Connected Successfully</span></div>'
    : '<div class="panel-badge error">' +
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>' +
      '<span>Authorization Failed</span></div>';

  const title = options.title || (isSuccess ? 'OpenRouter Account Authorized' : 'Authorization Error');
  const defaultMsg = isSuccess
    ? 'Your OpenRouter account is now authorized and connected to Causyne Agent. You can close this window and return to your terminal.'
    : 'The authorization flow could not be completed.';
  const message = options.message || defaultMsg;

  const contentBox = isSuccess
    ? '<div class="meta-box">' +
      '<div class="meta-row" style="margin-bottom:8px;">' +
      '<span class="meta-label">Provider</span>' +
      '<span class="meta-val">OpenRouter</span>' +
      '</div>' +
      '<div class="meta-row" style="margin-bottom:8px;">' +
      '<span class="meta-label">Active Model</span>' +
      `<span class="meta-val lime">${options.model || OPENROUTER_FREE_MODEL}</span>` +
      '</div>' +
      '<div class="meta-row" style="margin-bottom:8px;">' +
      '<span class="meta-label">Routing Tier</span>' +
      '<span class="meta-val" style="color:#9da697;">Community Free Inference (Zero Cost)</span>' +
      '</div>' +
      '<div class="meta-row">' +
      '<span class="meta-label">Protocol</span>' +
      '<span class="meta-val" style="color:#9da697;">OAuth 2.0 PKCE (S256)</span>' +
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
    ? '<button id="return-btn" class="btn-primary" onclick="returnToTerminal()">' +
      'Return to Terminal</button>' +
      '<div id="return-hint" class="return-hint">' +
      'Authentication complete. You can close this browser tab (⌘W / Ctrl+W) and switch back to your terminal.' +
      '</div>'
    : '<button class="btn-secondary" onclick="window.close()">' +
      'Close Window</button>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Causyne Agent Connected Successfully</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Exo+2:ital,wght@0,400;0,600;0,700;0,800;1,400&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #141714;
      --bg-subtle: #191c19;
      --charcoal: #202421;
      --lime: #B5D66A;
      --lime-bright: #9df028;
      --text-primary: #e4e8e0;
      --text-secondary: #9da697;
      --text-dim: #60685b;
      --border: rgba(255, 255, 255, 0.07);
      --font-display: 'Exo 2', system-ui, -apple-system, sans-serif;
      --font-mono: 'JetBrains Mono', 'SF Mono', Menlo, Monaco, Consolas, monospace;
      --max-w: 1100px;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text-primary);
      font-family: var(--font-mono);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 0 32px;
      -webkit-font-smoothing: antialiased;
    }
    .page {
      max-width: var(--max-w);
      width: 100%;
      margin: 0 auto;
    }
    .site-header {
      padding: 40px 0 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 14px;
      text-decoration: none;
    }
    .brand-logo {
      width: 36px;
      height: 36px;
      flex-shrink: 0;
    }
    .brand-wordmark {
      font-family: var(--font-display);
      font-size: 1.15rem;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--text-primary);
    }
    .site-nav {
      display: inline-flex;
      align-items: center;
      gap: 10px;
    }
    .nav-link {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 14px;
      font-family: var(--font-mono);
      font-size: 0.82rem;
      font-weight: 500;
      color: var(--text-secondary);
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      border-radius: 4px;
      text-decoration: none;
      transition: all 0.18s ease;
      line-height: 1;
    }
    .nav-link:hover {
      color: var(--text-primary);
      border-color: rgba(255, 255, 255, 0.22);
      background: rgba(255, 255, 255, 0.06);
    }
    .nav-icon { display: block; }
    .nav-icon.github-icon { color: var(--text-primary); }
    .nav-icon.npm-icon { color: #ea2039; }

    .content {
      padding: 60px 0 72px;
    }
    .hero-grid {
      display: grid;
      grid-template-columns: 1.1fr 1fr;
      gap: 56px;
      align-items: start;
    }
    @media (max-width: 860px) {
      .hero-grid { grid-template-columns: 1fr; gap: 36px; }
      body { padding: 0 20px; }
    }
    .hero-title {
      font-family: var(--font-display);
      font-size: 2.35rem;
      font-weight: 700;
      line-height: 1.18;
      letter-spacing: -0.02em;
      color: var(--text-primary);
      margin-bottom: 20px;
    }
    .hero-lead {
      font-family: var(--font-mono);
      font-size: 0.95rem;
      line-height: 1.76;
      color: var(--text-secondary);
      margin-bottom: 28px;
    }
    .hero-slogan {
      font-family: var(--font-mono);
      font-size: 0.82rem;
      color: var(--text-dim);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .hero-slogan::before {
      content: '';
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--lime);
    }

    .autonomy-panel {
      background: var(--charcoal);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 32px 28px;
    }
    .panel-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      border-radius: 4px;
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 20px;
    }
    .panel-badge.success {
      background: rgba(157, 240, 40, 0.12);
      border: 1px solid rgba(157, 240, 40, 0.35);
      color: #9df028;
    }
    .panel-badge.error {
      background: rgba(239, 83, 80, 0.12);
      border: 1px solid rgba(239, 83, 80, 0.35);
      color: #ef5350;
    }
    .panel-heading {
      font-family: var(--font-display);
      font-size: 1.25rem;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 10px;
      letter-spacing: -0.01em;
    }
    .panel-message {
      font-family: var(--font-mono);
      font-size: 0.85rem;
      line-height: 1.68;
      color: var(--text-secondary);
      margin-bottom: 22px;
    }
    .meta-box {
      background: var(--bg-subtle);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px 18px;
      margin-bottom: 24px;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.8;
      color: var(--text-primary);
    }
    .meta-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .meta-label { color: var(--text-secondary); }
    .meta-val { color: var(--text-primary); font-weight: 500; }
    .meta-val.lime { color: var(--lime-bright); font-weight: 600; }

    .btn-primary {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      background: var(--lime-bright);
      color: #141714;
      border: none;
      padding: 13px 24px;
      border-radius: 4px;
      font-size: 13px;
      font-weight: 700;
      font-family: var(--font-mono);
      letter-spacing: 0.5px;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    .btn-primary:hover {
      background: #c8e682;
    }
    .btn-secondary {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      background: var(--charcoal);
      color: var(--text-primary);
      border: 1px solid rgba(255, 255, 255, 0.15);
      padding: 12px 22px;
      border-radius: 4px;
      font-size: 13px;
      font-weight: 600;
      font-family: var(--font-mono);
      cursor: pointer;
    }
    .btn-secondary:hover {
      border-color: rgba(255, 255, 255, 0.3);
    }
    .return-hint {
      font-family: var(--font-mono);
      font-size: 11.5px;
      color: var(--text-dim);
      margin-top: 14px;
      line-height: 1.6;
      text-align: center;
    }

    .site-footer {
      padding: 28px 0 36px;
      border-top: 1px solid var(--border);
      font-family: var(--font-mono);
      font-size: 0.8rem;
      color: var(--text-dim);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .site-footer a {
      color: var(--text-dim);
      text-decoration: none;
    }
    .site-footer a:hover {
      color: var(--lime);
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
  <div class="page">
    <header class="site-header">
      <div class="brand">
        ${CAUSYNE_LOGO_SVG}
        <span class="brand-wordmark">CAUSYNE <span style="color:#9df028;">AGENT</span></span>
      </div>
      <nav class="site-nav" aria-label="Project links">
        <a href="https://github.com/ikbal-causyne/causyne-agent" class="nav-link" target="_blank" rel="noopener noreferrer" title="Causyne Agent on GitHub">
          <svg class="nav-icon github-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path fill="currentColor" d="M8 0C3.58 0 0 3.64 0 8.13c0 3.59 2.29 6.64 5.47 7.71.4.08.55-.18.55-.39 0-.19-.01-.83-.01-1.5-2.01.38-2.53-.5-2.69-.96-.09-.23-.48-.96-.82-1.15-.28-.15-.68-.53-.01-.54.63-.01 1.08.59 1.23.83.72 1.23 1.87.88 2.33.67.07-.53.28-.88.51-1.08-1.78-.21-3.64-.91-3.64-4.02 0-.89.31-1.62.82-2.19-.08-.2-.36-1.04.08-2.16 0 0 .67-.22 2.2.84A7.44 7.44 0 0 1 8 3.88c.68 0 1.36.09 2 .28 1.53-1.06 2.2-.84 2.2-.84.44 1.12.16 1.96.08 2.16.51.57.82 1.3.82 2.19 0 3.12-1.87 3.81-3.65 4.02.29.25.54.74.54 1.51 0 1.09-.01 1.97-.01 2.25 0 .21.15.47.55.39A8.09 8.09 0 0 0 16 8.13C16 3.64 12.42 0 8 0Z"/>
          </svg>
          <span>GitHub</span>
        </a>
        <a href="https://www.npmjs.com/package/@causyne/agent" class="nav-link" target="_blank" rel="noopener noreferrer" title="Causyne Agent on npm">
          <svg class="nav-icon npm-icon" viewBox="0 0 780 250" width="34" height="11" aria-hidden="true">
            <path fill="currentColor" d="M240,250h100v-50h100V0H240V250z M340,50h50v100h-50V50z M480,0v200h100V50h50v150h50V50h50v150h50V0H480z M0,200h100V50h50v150h50V0H0V200z"/>
          </svg>
        </a>
      </nav>
    </header>

    <main class="content">
      <div class="hero-grid">
        <div>
          <h1 class="hero-title">${isSuccess ? 'Account connected.' : 'Authorization error.'}</h1>
          <p class="hero-lead">
            ${isSuccess
              ? 'OpenRouter Free inference endpoint is now authorized for Causyne Agent. You can close this browser tab and return to your terminal session.'
              : (options.message || 'The authorization flow could not be completed.')}
          </p>
          <div class="hero-slogan">
            <span>Causyne Agent · Agentic AI Harness · From intention to meaningful progress.</span>
          </div>
        </div>

        <aside class="autonomy-panel" aria-label="Authorization details">
          ${badgeHtml}
          <div class="panel-heading">${title}</div>
          <p class="panel-message">${message}</p>
          ${contentBox}
          ${actionButton}
        </aside>
      </div>
    </main>

    <footer class="site-footer">
      <span>Causyne Agent is in development.</span>
      <a href="https://causyne.com" target="_blank" rel="noopener noreferrer">causyne.com</a>
    </footer>
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

        // Perform token exchange first before confirming success to the browser
        try {
          const apiKey = await exchangeCodeForApiKey(code, pkce.codeVerifier, fetchFn);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            renderAuthPage({
              status: 'success',
              model: OPENROUTER_FREE_MODEL
            })
          );
          if (!resolved) {
            resolved = true;
            setTimeout(cleanup, 1200);
            resolve({ apiKey });
          }
        } catch (exchangeErr: any) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            renderAuthPage({
              status: 'error',
              title: 'OpenRouter Token Exchange Failed',
              errorDetail: exchangeErr?.message || 'Could not complete token exchange with OpenRouter.'
            })
          );
          if (!resolved) {
            resolved = true;
            cleanup();
            reject(exchangeErr);
          }
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
