import fs from 'node:fs';
import type http from 'node:http';
import { fileURLToPath } from 'node:url';

interface StaticAssetEntry {
  readonly filePath: string;
  readonly contentType: string;
}

export const SKYBRIDGE_STYLESHEET_URLS: readonly string[] = [
  '/assets/styles/tokens.css',
  '/assets/styles/shell.css',
  '/assets/styles/thread.css',
  '/assets/styles/agent.css',
  '/assets/styles/composer.css',
  '/assets/styles/studio.css',
  '/assets/styles/overlays.css'
];

export const SKYBRIDGE_CLIENT_MODULE_FILES: readonly string[] = [
  'types.js',
  'dom.js',
  'state.js',
  'validators.js',
  'markdown.js',
  'streamSmoother.js',
  'turnView.js',
  'studioLayout.js',
  'studioShell.js',
  'studioStart.js',
  'filesAndCanvas.js',
  'diffPanel.js',
  'browserPanel.js',
  'terminalPanel.js',
  'cliPanel.js',
  'gameLauncherUi.js',
  'modelPicker.js',
  'permissionPresetsUi.js',
  'settingsModal.js',
  'sessions.js',
  'chatStream.js',
  'composer.js',
  'main.js'
];

const STATIC_ASSET_MAP: ReadonlyMap<string, StaticAssetEntry> = (() => {
  const map = new Map<string, StaticAssetEntry>();
  const styleFiles = [
    'tokens.css',
    'shell.css',
    'thread.css',
    'agent.css',
    'composer.css',
    'studio.css',
    'overlays.css'
  ] as const;

  for (const name of styleFiles) {
    map.set(`/assets/styles/${name}`, {
      filePath: fileURLToPath(new URL(`../styles/${name}`, import.meta.url)),
      contentType: 'text/css; charset=utf-8'
    });
  }

  for (const name of SKYBRIDGE_CLIENT_MODULE_FILES) {
    map.set(`/assets/client/${name}`, {
      filePath: fileURLToPath(new URL(`../client/${name}`, import.meta.url)),
      contentType: 'text/javascript; charset=utf-8'
    });
  }

  return map;
})();

export function serveStaticAsset(pathname: string, res: http.ServerResponse): boolean {
  const entry = STATIC_ASSET_MAP.get(pathname);
  if (!entry) return false;
  try {
    const content = fs.readFileSync(entry.filePath);
    res.statusCode = 200;
    res.setHeader('Content-Type', entry.contentType);
    res.setHeader('Cache-Control', 'no-cache');
    res.end(content);
    return true;
  } catch {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Static asset unavailable.' }));
    return true;
  }
}
