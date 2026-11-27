import { escapeHtmlAttr, getCausyneFaviconSvg } from './ui/brandMark.js';
import { renderSidebarHtml } from './ui/sidebarTemplate.js';
import { renderWorkspaceHtml } from './ui/workspaceTemplate.js';
import { renderStudioHtml } from './ui/studioTemplate.js';
import { renderModalsHtml } from './ui/modalsTemplate.js';
import { SKYBRIDGE_STYLESHEET_URLS } from './server/staticAssets.js';
export { getCausyneFaviconSvg };
export function renderSkybridgeHtml(options) {
    const nonce = escapeHtmlAttr(options.cspNonce);
    const titleWs = escapeHtmlAttr(options.workspaceName || 'Workspace');
    const ver = escapeHtmlAttr(options.version || '0.0.0');
    const styleLinks = SKYBRIDGE_STYLESHEET_URLS
        .map((href) => `<link rel="stylesheet" href="${href}">`)
        .join('\n');
    return [
        '<!DOCTYPE html>',
        '<html lang="en" data-theme="dark">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        `<title>Causyne · ${titleWs}</title>`,
        '<link rel="icon" type="image/svg+xml" href="/favicon.svg">',
        styleLinks,
        '</head>',
        '<body>',
        '<div id="aria-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>',
        '<div id="aria-alert" class="sr-only" role="alert" aria-live="assertive" aria-atomic="true"></div>',
        '<div id="app" class="app">',
        renderSidebarHtml(titleWs, ver),
        renderWorkspaceHtml(),
        renderStudioHtml(),
        '</div>',
        renderModalsHtml(),
        `<script type="module" nonce="${nonce}" src="/assets/client/main.js"></script>`,
        '</body>',
        '</html>'
    ].join('\n');
}
