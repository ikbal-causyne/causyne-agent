import type http from 'node:http';
import { auditLog } from '../../auditLog.js';
import {
  causyneBrowser,
  expandSearchMacro,
  type BrowserEnginePreference,
  type LiveBrowserInteraction
} from '../../browser/causyneBrowser.js';
import {
  discoverLocalCdpTabs,
  importExplicitUserBrowserData,
  syncLocalCdpTabToCausyne
} from '../skybridgeBrowserBridge.js';
import {
  handleBrowserMcpRpc,
  type JsonRpcMessage
} from '../skybridgeBrowserMcp.js';
import { readJsonBody, sendJson } from './security.js';
import type { SkybridgeContext } from './types.js';

const ALLOWED_INPUT_KINDS = new Set([
  'click', 'dblclick', 'contextmenu', 'mousedown', 'mousemove', 'mouseup', 'wheel', 'type', 'key', 'paste'
]);

export async function handleBrowserRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsedUrl: URL,
  ctx: SkybridgeContext
): Promise<boolean> {
  const pathname = parsedUrl.pathname;
  const { workspaceRoot, version } = ctx;

  if (req.method === 'GET' && pathname === '/api/mcp/browser') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Use POST for Streamable HTTP MCP JSON-RPC requests.' }));
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/mcp/browser') {
    const body = await readJsonBody(req) as JsonRpcMessage;
    const reply = await handleBrowserMcpRpc(body, {
      workspaceRoot,
      version,
      onActivity: (activity) => {
        if (activity.phase === 'start') {
          ctx.setBrowserControlOwner('agent');
          ctx.setBrowserAgentActivity({
            active: true,
            tool: activity.tool,
            detail: activity.detail,
            updatedAt: Date.now()
          });
        } else {
          ctx.setBrowserAgentActivity({ active: false, tool: '', detail: '', updatedAt: Date.now() });
        }
        ctx.broadcastBrowserNotice({
          type: 'agent_activity',
          controlOwner: ctx.getBrowserControlOwner(),
          agentActivity: ctx.getBrowserAgentActivity()
        });
      }
    });
    if (reply === null) {
      res.statusCode = 202;
      res.end();
      return true;
    }
    sendJson(res, 200, reply);
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/browser/state') {
    const ensure = parsedUrl.searchParams.get('ensure') === '1';
    const browser = causyneBrowser({ workspace: workspaceRoot });
    const frame = await browser.captureLiveFrame({ ensureStarted: ensure });
    sendJson(res, 200, {
      ok: true,
      controlOwner: ctx.getBrowserControlOwner(),
      agentActivity: ctx.getBrowserAgentActivity(),
      computerUsePolicy: 'tiered-approval',
      ...frame
    });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/browser/stream') {
    const browser = causyneBrowser({ workspace: workspaceRoot });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    const writeStreamLine = (payload: Record<string, unknown>): void => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(`${JSON.stringify(payload)}\n`);
      } catch {
        // Stream closed mid-write.
      }
    };
    const unsub = browser.subscribeLiveStream((ev) => {
      writeStreamLine({
        ...ev,
        controlOwner: ctx.getBrowserControlOwner(),
        agentActivity: ctx.getBrowserAgentActivity(),
        computerUsePolicy: 'tiered-approval'
      });
    });
    ctx.browserStreamClients.add(writeStreamLine);
    writeStreamLine({
      type: 'agent_activity',
      controlOwner: ctx.getBrowserControlOwner(),
      agentActivity: ctx.getBrowserAgentActivity(),
      computerUsePolicy: 'tiered-approval'
    });
    const keepAlive = setInterval(() => {
      writeStreamLine({ type: 'ping', ts: Date.now() });
    }, 15_000);
    keepAlive.unref?.();
    const cleanup = (): void => {
      clearInterval(keepAlive);
      ctx.browserStreamClients.delete(writeStreamLine);
      unsub();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/browser/input') {
    const body = await readJsonBody(req);
    const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
    if (!ALLOWED_INPUT_KINDS.has(kind)) {
      sendJson(res, 400, { error: 'Unsupported live browser input kind.' });
      return true;
    }
    ctx.setBrowserControlOwner('human');
    const browser = causyneBrowser({ workspace: workspaceRoot });
    const result = await browser.dispatchLiveInput({
      kind: kind as LiveBrowserInteraction['kind'],
      x: typeof body.x === 'number' ? body.x : undefined,
      y: typeof body.y === 'number' ? body.y : undefined,
      deltaX: typeof body.deltaX === 'number' ? body.deltaX : undefined,
      deltaY: typeof body.deltaY === 'number' ? body.deltaY : undefined,
      text: typeof body.text === 'string' ? body.text : undefined,
      key: typeof body.key === 'string' ? body.key : undefined,
      button: body.button === 'right' || body.button === 'middle' ? body.button : 'left',
      skipFrame: true
    });
    sendJson(res, 200, { ok: result.ok, controlOwner: ctx.getBrowserControlOwner() });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/browser/action') {
    const body = await readJsonBody(req);
    const action = typeof body.action === 'string' ? body.action.trim() : '';
    const browser = causyneBrowser({ workspace: workspaceRoot });

    if (action === 'setMode') {
      ctx.setBrowserControlOwner('human');
      const rawPref = typeof body.enginePreference === 'string' ? body.enginePreference.trim() : '';
      const enginePreference: BrowserEnginePreference | undefined = rawPref === 'camoufox'
        || rawPref === 'chromium'
        || rawPref === 'auto'
        ? rawPref
        : undefined;
      const frame = await browser.setDisplayMode({
        visible: typeof body.visible === 'boolean' ? body.visible : undefined,
        enginePreference,
        ensureStarted: body.ensureStarted === true
      });
      auditLog.log({
        event: 'skybridge_browser_mode_switch',
        visible: frame.visible,
        engine: frame.engine,
        enginePreference: frame.enginePreference
      });
      ctx.broadcastBrowserNotice({
        type: 'meta',
        controlOwner: ctx.getBrowserControlOwner(),
        agentActivity: ctx.getBrowserAgentActivity(),
        ...frame
      });
      sendJson(res, 200, {
        ok: true,
        controlOwner: ctx.getBrowserControlOwner(),
        agentActivity: ctx.getBrowserAgentActivity(),
        ...frame
      });
      return true;
    }
    if (action === 'takeControl') {
      ctx.setBrowserControlOwner('human');
      ctx.setBrowserAgentActivity({ active: false, tool: '', detail: '', updatedAt: Date.now() });
      const frame = await browser.captureLiveFrame({ ensureStarted: false });
      ctx.broadcastBrowserNotice({
        type: 'agent_activity',
        controlOwner: ctx.getBrowserControlOwner(),
        agentActivity: ctx.getBrowserAgentActivity()
      });
      sendJson(res, 200, {
        ok: true,
        controlOwner: ctx.getBrowserControlOwner(),
        agentActivity: ctx.getBrowserAgentActivity(),
        ...frame
      });
      return true;
    }
    if (action === 'handToAgent') {
      ctx.setBrowserControlOwner('agent');
      const frame = await browser.captureLiveFrame({ ensureStarted: false });
      ctx.broadcastBrowserNotice({
        type: 'agent_activity',
        controlOwner: ctx.getBrowserControlOwner(),
        agentActivity: ctx.getBrowserAgentActivity()
      });
      sendJson(res, 200, {
        ok: true,
        controlOwner: ctx.getBrowserControlOwner(),
        agentActivity: ctx.getBrowserAgentActivity(),
        ...frame
      });
      return true;
    }
    if (action === 'start') {
      ctx.setBrowserControlOwner('human');
      let frame = await browser.captureLiveFrame({ ensureStarted: true });
      const reqW = Number(body.width);
      const reqH = Number(body.height);
      if (frame.active && Number.isFinite(reqW) && Number.isFinite(reqH) && reqW >= 320 && reqH >= 240) {
        const width = Math.max(320, Math.min(2560, Math.round(reqW)));
        const height = Math.max(240, Math.min(1440, Math.round(reqH)));
        try {
          await browser.run([{ type: 'viewport', width, height }], { workspace: workspaceRoot });
          frame = await browser.captureLiveFrame({ ensureStarted: false });
        } catch {
          // Keep started frame if viewport resize raced with close.
        }
      }
      sendJson(res, 200, { ok: true, controlOwner: ctx.getBrowserControlOwner(), ...frame });
      return true;
    }
    if (action === 'close') {
      const frame = await browser.closeLiveSession();
      ctx.broadcastBrowserNotice({
        type: 'closed',
        controlOwner: ctx.getBrowserControlOwner(),
        ...frame
      });
      sendJson(res, 200, { ok: true, controlOwner: ctx.getBrowserControlOwner(), ...frame });
      return true;
    }
    if (action === 'goto' || action === 'newTab') {
      ctx.setBrowserControlOwner('human');
      let rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
      if (rawUrl.startsWith('@')) {
        const idx = rawUrl.indexOf(' ');
        const macro = idx === -1 ? rawUrl : rawUrl.slice(0, idx);
        const q = idx === -1 ? '' : rawUrl.slice(idx + 1).trim();
        const expanded = expandSearchMacro(macro, q);
        if (!expanded) {
          sendJson(res, 400, { error: 'Unsupported browser search macro.' });
          return true;
        }
        rawUrl = expanded;
      } else if (rawUrl && !/^https?:\/\//i.test(rawUrl)) {
        rawUrl = rawUrl.includes('.') || rawUrl.startsWith('localhost')
          ? `https://${rawUrl}`
          : (expandSearchMacro('@duckduckgo_search', rawUrl) || `https://duckduckgo.com/?q=${encodeURIComponent(rawUrl)}`);
      }
      const actions: Array<{ type: 'viewport'; width: number; height: number } | { type: 'newTab'; url?: string } | { type: 'goto'; url: string }> = [
        action === 'newTab'
          ? { type: 'newTab', ...(rawUrl ? { url: rawUrl } : {}) }
          : { type: 'goto', url: rawUrl || 'about:blank' }
      ];
      const reqW = Number(body.width);
      const reqH = Number(body.height);
      if (Number.isFinite(reqW) && Number.isFinite(reqH) && reqW >= 320 && reqH >= 240) {
        actions.push({
          type: 'viewport',
          width: Math.max(320, Math.min(2560, Math.round(reqW))),
          height: Math.max(240, Math.min(1440, Math.round(reqH)))
        });
      }
      await browser.run(actions, { workspace: workspaceRoot });
      const frame = await browser.captureLiveFrame({ ensureStarted: true });
      sendJson(res, 200, { ok: true, controlOwner: ctx.getBrowserControlOwner(), ...frame });
      return true;
    }
    if (action === 'back' || action === 'forward' || action === 'reload') {
      ctx.setBrowserControlOwner('human');
      await browser.run([{ type: action }], { workspace: workspaceRoot });
      const frame = await browser.captureLiveFrame({ ensureStarted: true });
      sendJson(res, 200, { ok: true, controlOwner: ctx.getBrowserControlOwner(), ...frame });
      return true;
    }
    if (action === 'switchTab' && typeof body.tabId === 'string' && body.tabId.trim()) {
      ctx.setBrowserControlOwner('human');
      await browser.run([{ type: 'switchTab', tabId: body.tabId.trim() }], { workspace: workspaceRoot });
      const frame = await browser.captureLiveFrame({ ensureStarted: true });
      sendJson(res, 200, { ok: true, controlOwner: ctx.getBrowserControlOwner(), ...frame });
      return true;
    }
    if (action === 'closeTab' && typeof body.tabId === 'string' && body.tabId.trim()) {
      ctx.setBrowserControlOwner('human');
      const frame = await browser.closeLiveTab(body.tabId.trim());
      if (!frame.active) {
        ctx.broadcastBrowserNotice({
          type: 'closed',
          controlOwner: ctx.getBrowserControlOwner(),
          ...frame
        });
      }
      sendJson(res, 200, { ok: true, controlOwner: ctx.getBrowserControlOwner(), ...frame });
      return true;
    }
    if (action === 'viewport') {
      const pre = await browser.captureLiveFrame({ ensureStarted: false });
      if (!pre.active) {
        sendJson(res, 200, { ok: true, controlOwner: ctx.getBrowserControlOwner(), ...pre });
        return true;
      }
      const width = Math.max(320, Math.min(2560, Math.round(Number(body.width) || 1280)));
      const height = Math.max(240, Math.min(1440, Math.round(Number(body.height) || 800)));
      try {
        await browser.run([{ type: 'viewport', width, height }], { workspace: workspaceRoot });
      } catch {
        // Browser closed concurrently during resize; return current closed state cleanly.
      }
      const frame = await browser.captureLiveFrame({ ensureStarted: false });
      sendJson(res, 200, { ok: true, controlOwner: ctx.getBrowserControlOwner(), ...frame });
      return true;
    }
    if (action === 'snapshot') {
      const snap = await browser.snapshot(0);
      const frame = await browser.captureLiveFrame({ ensureStarted: true });
      sendJson(res, 200, {
        ok: true,
        controlOwner: ctx.getBrowserControlOwner(),
        snapshot: snap.text,
        refsCount: snap.refsCount,
        ...frame
      });
      return true;
    }
    if (ALLOWED_INPUT_KINDS.has(action)) {
      ctx.setBrowserControlOwner('human');
      const frame = await browser.interactAt({
        kind: action as LiveBrowserInteraction['kind'],
        x: typeof body.x === 'number' ? body.x : undefined,
        y: typeof body.y === 'number' ? body.y : undefined,
        deltaX: typeof body.deltaX === 'number' ? body.deltaX : undefined,
        deltaY: typeof body.deltaY === 'number' ? body.deltaY : undefined,
        text: typeof body.text === 'string' ? body.text : undefined,
        key: typeof body.key === 'string' ? body.key : undefined,
        button: body.button === 'right' || body.button === 'middle' ? body.button : 'left'
      });
      sendJson(res, 200, {
        ok: true,
        controlOwner: ctx.getBrowserControlOwner(),
        agentActivity: ctx.getBrowserAgentActivity(),
        ...frame
      });
      return true;
    }
    sendJson(res, 400, { error: 'Unsupported shared browser action.' });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/browser/cdp/tabs') {
    const portParam = parsedUrl.searchParams.get('port') || '9222';
    const discovered = await discoverLocalCdpTabs(portParam);
    sendJson(res, 200, {
      ok: true,
      port: discovered.port,
      tabs: discovered.tabs.map((t) => ({ id: t.id, title: t.title, url: t.url }))
    });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/browser/cdp/sync') {
    const body = await readJsonBody(req);
    const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : '';
    if (!targetId) {
      sendJson(res, 400, { error: 'targetId is required to sync a local browser tab.' });
      return true;
    }
    const synced = await syncLocalCdpTabToCausyne({
      workspaceRoot,
      port: body.port ?? 9222,
      targetId,
      includeCookies: body.includeCookies === true
    });
    ctx.setBrowserControlOwner('human');
    auditLog.log({
      event: 'skybridge_browser_cdp_sync',
      importedCookies: synced.importedCookies
    });
    sendJson(res, 200, {
      ok: true,
      controlOwner: ctx.getBrowserControlOwner(),
      syncedUrl: synced.syncedUrl,
      importedCookies: synced.importedCookies,
      ...synced.frame
    });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/browser/import') {
    const body = await readJsonBody(req);
    const rawText = typeof body.rawText === 'string' ? body.rawText : '';
    const summary = await importExplicitUserBrowserData({
      workspaceRoot,
      rawText,
      openFirstUrl: body.openFirstUrl !== false
    });
    const frame = await causyneBrowser({ workspace: workspaceRoot }).captureLiveFrame({ ensureStarted: false });
    auditLog.log({
      event: 'skybridge_browser_import',
      importedCookies: summary.importedCookies,
      urlsCount: summary.importedUrls.length
    });
    sendJson(res, 200, {
      ok: true,
      controlOwner: ctx.getBrowserControlOwner(),
      ...summary,
      ...frame
    });
    return true;
  }

  return false;
}
