import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  EntitlementClient,
  EntitlementAccessError
} from '../src/licensing/entitlements.js';
import {
  LICENSE_CHECKOUT_ALLOWED_HOST_SUFFIXES,
  isAllowedCheckoutHost
} from '../src/licensing/policy.js';
import {
  isAllowedSkybridgeHost,
  isAllowedSkybridgeOrigin,
  startSkybridgeServer
} from '../src/web/skybridgeServer.js';
import {
  extractExplicitBookmarkUrls,
  parseValidatedCdpPort
} from '../src/web/skybridgeBrowserBridge.js';
import {
  CAUSYNE_BROWSER_MCP_NAME,
  CAUSYNE_BROWSER_MCP_TOOLS,
  handleBrowserMcpRpc
} from '../src/web/skybridgeBrowserMcp.js';
import { buildSharedBrowserAwarenessPrompt } from '../src/agentLoop.js';
import {
  formatByokProbeReport,
  runZeroSpendByokProbe
} from '../src/verification/byokSmokeProbe.js';
import { AuditLog } from '../src/auditLog.js';

function rawHttpRequest(options: {
  port: number;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: options.port,
        method: options.method || 'GET',
        path: options.path,
        headers: options.headers || {}
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('Paddle/Dodo Checkout Allowlist, Local Skybridge Security & $0 BYOK Probe', () => {
  test('licensing checkout allowlist permits Paddle, Dodo Payments, and causyne.com while blocking lookalikes and retired hosts', async () => {
    assert.deepEqual(
      [...LICENSE_CHECKOUT_ALLOWED_HOST_SUFFIXES],
      ['paddle.com', 'dodopayments.com', 'causyne.com']
    );

    assert.equal(isAllowedCheckoutHost('checkout.paddle.com'), true);
    assert.equal(isAllowedCheckoutHost('buy.paddle.com'), true);
    assert.equal(isAllowedCheckoutHost('checkout.dodopayments.com'), true);
    assert.equal(isAllowedCheckoutHost('causyne.com'), true);
    assert.equal(isAllowedCheckoutHost('evil-paddle.com'), false);
    assert.equal(isAllowedCheckoutHost('causyne.lemonsqueezy.com'), false);

    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-paddle-lic-'));
    const installationId = '40404040-4040-4040-8040-404040404040';
    let nextCheckoutUrl = 'https://checkout.paddle.com/pay/txn_test_123';
    const fetchFn = (async (url: any) => {
      const p = new URL(String(url)).pathname;
      if (p === '/v1/installations') return Response.json({ installationId }, { status: 201 });
      if (p === '/v1/checkout') return Response.json({ url: nextCheckoutUrl }, { status: 200 });
      return Response.json({}, { status: 404 });
    }) as typeof fetch;

    try {
      const client = new EntitlementClient({ apiBase: 'https://license.causyne.com', stateRoot, fetchFn });
      const paddleRes = await client.checkout('monthly');
      assert.equal(paddleRes.url, 'https://checkout.paddle.com/pay/txn_test_123');

      nextCheckoutUrl = 'https://checkout.dodopayments.com/session/sess_abc';
      const dodoRes = await client.checkout('annual');
      assert.equal(dodoRes.url, nextCheckoutUrl);

      nextCheckoutUrl = 'https://evil-paddle.com/phish';
      await assert.rejects(() => client.checkout('monthly'), (err: unknown) => {
        return err instanceof EntitlementAccessError && err.code === 'BAD_CHECKOUT_URL';
      });

      nextCheckoutUrl = 'http://checkout.paddle.com/insecure';
      await assert.rejects(() => client.checkout('monthly'), (err: unknown) => {
        return err instanceof EntitlementAccessError && err.code === 'BAD_CHECKOUT_URL';
      });
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  test('Skybridge enforces DNS-rebinding Host check, Origin/PNA CORS, Bearer auth, workspace boundary lock, idoc write, and streaming approvals', async () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-skybridge-ws-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-skybridge-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'OUTSIDE_SECRET', 'utf8');
    fs.writeFileSync(path.join(tmpWs, '.causyneignore'), 'blocked.secret\n', 'utf8');
    fs.writeFileSync(path.join(tmpWs, 'README.md'), '# Local Project\n', 'utf8');
    try {
      fs.symlinkSync(outsideFile, path.join(tmpWs, 'escape-link.txt'));
    } catch {
      // Symlink creation may be restricted on some Windows environments
    }

    let pendingResolve: ((approved: boolean) => void) | null = null;
    const handle = await startSkybridgeServer({
      workspaceRoot: tmpWs,
      port: 0,
      loopFactory: (sink, _taskId, prompt) => ({
        async run() {
          sink.send(JSON.stringify({ type: 'agent_chunk', delta: `Working on: ${prompt}` }));
          sink.send(JSON.stringify({ type: 'approval_request', toolCallId: 'tc_sky_1', tool: 'fs_write' }));
          const approved = await new Promise<boolean>((resolve) => { pendingResolve = resolve; });
          sink.send(JSON.stringify({ type: 'agent_chunk', delta: approved ? ' [APPROVED]' : ' [DENIED]' }));
        },
        resolveApproval(toolCallId, approved) {
          if (toolCallId === 'tc_sky_1' && pendingResolve) {
            const fn = pendingResolve;
            pendingResolve = null;
            fn(approved);
          }
        }
      })
    });

    try {
      assert.equal(isAllowedSkybridgeHost(`127.0.0.1:${handle.port}`, handle.port), true);
      assert.equal(isAllowedSkybridgeHost(`evil.example:${handle.port}`, handle.port), false);
      assert.equal(isAllowedSkybridgeOrigin('https://causyne.com', handle.port), true);
      assert.equal(isAllowedSkybridgeOrigin('https://evil.example', handle.port), false);

      // 1. DNS Rebinding defense (spoofed Host header -> 403)
      const rebind = await rawHttpRequest({
        port: handle.port,
        path: '/api/health',
        headers: { Host: `attacker-rebind.example:${handle.port}`, Authorization: `Bearer ${handle.token}` }
      });
      assert.equal(rebind.status, 403);

      // 2. Malicious Origin rejection -> 403
      const badOrigin = await rawHttpRequest({
        port: handle.port,
        path: '/api/health',
        headers: {
          Host: `127.0.0.1:${handle.port}`,
          Origin: 'https://evil.example',
          Authorization: `Bearer ${handle.token}`
        }
      });
      assert.equal(badOrigin.status, 403);

      // 3. Chrome Private Network Access (PNA) preflight for https://causyne.com -> 204 with exact headers
      const pna = await rawHttpRequest({
        port: handle.port,
        method: 'OPTIONS',
        path: '/api/health',
        headers: {
          Host: `127.0.0.1:${handle.port}`,
          Origin: 'https://causyne.com',
          'Access-Control-Request-Private-Network': 'true'
        }
      });
      assert.equal(pna.status, 204);
      assert.equal(pna.headers['access-control-allow-origin'], 'https://causyne.com');
      assert.equal(pna.headers['access-control-allow-private-network'], 'true');

      // 4. Missing/wrong Bearer token -> 401
      const unauth = await rawHttpRequest({
        port: handle.port,
        path: '/api/health',
        headers: { Host: `127.0.0.1:${handle.port}` }
      });
      assert.equal(unauth.status, 401);

      // 5. Local HTML UI carries strict CSP nonce + anti-framing headers + zero innerHTML
      const htmlRes = await rawHttpRequest({
        port: handle.port,
        path: '/',
        headers: { Host: `127.0.0.1:${handle.port}` }
      });
      assert.equal(htmlRes.status, 200);
      assert.match(String(htmlRes.headers['content-security-policy'] || ''), /script-src 'self' 'nonce-/);
      assert.equal(htmlRes.headers['x-frame-options'], 'DENY');
      assert.equal(htmlRes.body.includes('innerHTML'), false);

      // 6. Authenticated health + workspace file boundary checks (traversal, symlink, .causyneignore)
      const authHeaders = {
        Host: `127.0.0.1:${handle.port}`,
        Authorization: `Bearer ${handle.token}`
      };
      const health = await rawHttpRequest({ port: handle.port, path: '/api/health', headers: authHeaders });
      assert.equal(health.status, 200);
      assert.equal(JSON.parse(health.body).ok, true);

      const traversal = await rawHttpRequest({
        port: handle.port,
        path: '/api/file?path=..%2F..%2Fetc%2Fpasswd',
        headers: authHeaders
      });
      assert.equal(traversal.status, 403);

      if (fs.existsSync(path.join(tmpWs, 'escape-link.txt'))) {
        const symlinkEscape = await rawHttpRequest({
          port: handle.port,
          path: '/api/file?path=escape-link.txt',
          headers: authHeaders
        });
        assert.equal(symlinkEscape.status, 403);
      }

      const ignoredWrite = await rawHttpRequest({
        port: handle.port,
        method: 'POST',
        path: '/api/file',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'blocked.secret', content: 'nope' })
      });
      assert.equal(ignoredWrite.status, 403);

      // 7. Create a real local idoc file inside workspace, read it back, and verify audit log
      const writeRes = await rawHttpRequest({
        port: handle.port,
        method: 'POST',
        path: '/api/file',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'docs/plan.idoc.md', content: '# Causyne idoc\nVerified locally.\n' })
      });
      assert.equal(writeRes.status, 200);
      assert.equal(fs.readFileSync(path.join(tmpWs, 'docs', 'plan.idoc.md'), 'utf8'), '# Causyne idoc\nVerified locally.\n');

      const readRes = await rawHttpRequest({
        port: handle.port,
        path: '/api/file?path=docs%2Fplan.idoc.md',
        headers: authHeaders
      });
      assert.equal(readRes.status, 200);
      assert.equal(JSON.parse(readRes.body).content, '# Causyne idoc\nVerified locally.\n');

      const audit = new AuditLog();
      assert.ok(audit.getRecentLogs(20).some((e) => e.event === 'skybridge_file_write' && e.path === 'docs/plan.idoc.md'));

      // 8. Real NDJSON streaming chat + interactive approval resolution
      const chatPromise = rawHttpRequest({
        port: handle.port,
        method: 'POST',
        path: '/api/chat',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'create idoc', mode: 'B' })
      });

      // Wait briefly for the mock loop to register its approval waiter, then approve via /api/approve
      for (let i = 0; i < 40 && !pendingResolve; i++) {
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.ok(pendingResolve, 'expected active approval waiter');
      const approveRes = await rawHttpRequest({
        port: handle.port,
        method: 'POST',
        path: '/api/approve',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolCallId: 'tc_sky_1', approved: true })
      });
      assert.equal(approveRes.status, 200);

      const chatRes = await chatPromise;
      assert.equal(chatRes.status, 200);
      const frames = chatRes.body.trim().split('\n').map((l) => JSON.parse(l));
      assert.ok(frames.some((f) => f.type === 'agent_chunk' && String(f.delta).includes('[APPROVED]')));
      assert.ok(frames.some((f) => f.type === 'done'));

      // 9. Session lifecycle APIs (create, list, read, rename, delete) locked to workspace
      const createSess = await rawHttpRequest({
        port: handle.port,
        method: 'POST',
        path: '/api/sessions',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Web GUI Session' })
      });
      assert.equal(createSess.status, 201);
      const createdId = JSON.parse(createSess.body).session.id;
      assert.match(createdId, /^s_/);

      const listSess = await rawHttpRequest({ port: handle.port, path: '/api/sessions', headers: authHeaders });
      assert.equal(listSess.status, 200);
      assert.ok(JSON.parse(listSess.body).sessions.some((s: any) => s.id === createdId));

      const renameSess = await rawHttpRequest({
        port: handle.port,
        method: 'PATCH',
        path: `/api/sessions/${encodeURIComponent(createdId)}`,
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Renamed Web Session' })
      });
      assert.equal(renameSess.status, 200);

      const readSess = await rawHttpRequest({
        port: handle.port,
        path: `/api/sessions/${encodeURIComponent(createdId)}`,
        headers: authHeaders
      });
      assert.equal(readSess.status, 200);
      assert.equal(JSON.parse(readSess.body).session.title, 'Renamed Web Session');

      const delSess = await rawHttpRequest({
        port: handle.port,
        method: 'DELETE',
        path: `/api/sessions/${encodeURIComponent(createdId)}`,
        headers: authHeaders
      });
      assert.equal(delSess.status, 200);

      // 10. Models & Diff APIs (never leaks API keys, handles non-git workspaces cleanly)
      const modelsRes = await rawHttpRequest({ port: handle.port, path: '/api/models', headers: authHeaders });
      assert.equal(modelsRes.status, 200);
      const modelsBody = JSON.parse(modelsRes.body);
      assert.equal(modelsBody.ok, true);
      assert.ok(Array.isArray(modelsBody.groups) && modelsBody.groups.length > 0);
      assert.equal(modelsRes.body.includes('apiKey'), false);

      const diffRes = await rawHttpRequest({ port: handle.port, path: '/api/diff', headers: authHeaders });
      assert.equal(diffRes.status, 200);
      assert.equal(JSON.parse(diffRes.body).ok, true);
      assert.equal(JSON.parse(diffRes.body).isGitRepo, false);

      // 11. Full Causyne CLI Mirror APIs (/api/commands, /api/command, /api/cli/overview)
      const cmdsRes = await rawHttpRequest({ port: handle.port, path: '/api/commands', headers: authHeaders });
      assert.equal(cmdsRes.status, 200);
      const cmdsBody = JSON.parse(cmdsRes.body);
      assert.ok(Array.isArray(cmdsBody.commands) && cmdsBody.commands.length >= 30);
      assert.ok(cmdsBody.commands.some((c: any) => c.name === 'doctor'));
      assert.ok(cmdsBody.commands.some((c: any) => c.name === 'checkpoints'));

      const verCmd = await rawHttpRequest({
        port: handle.port,
        method: 'POST',
        path: '/api/command',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '/version' })
      });
      assert.equal(verCmd.status, 200);
      assert.equal(JSON.parse(verCmd.body).ok, true);

      const exitCmd = await rawHttpRequest({
        port: handle.port,
        method: 'POST',
        path: '/api/command',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '/exit' })
      });
      assert.equal(exitCmd.status, 200);
      assert.match(JSON.parse(exitCmd.body).output, /Ctrl\+C/);

      const cliOverview = await rawHttpRequest({ port: handle.port, path: '/api/cli/overview', headers: authHeaders });
      assert.equal(cliOverview.status, 200);
      assert.ok(JSON.parse(cliOverview.body).commandsCount >= 30);

      // 12. Shared Agent + Human Browser state & ownership handoff + zero-malware bridge validators
      const bState = await rawHttpRequest({ port: handle.port, path: '/api/browser/state', headers: authHeaders });
      assert.equal(bState.status, 200);
      assert.equal(JSON.parse(bState.body).controlOwner, 'human');

      const handToAgent = await rawHttpRequest({
        port: handle.port,
        method: 'POST',
        path: '/api/browser/action',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'handToAgent' })
      });
      assert.equal(handToAgent.status, 200);
      assert.equal(JSON.parse(handToAgent.body).controlOwner, 'agent');

      // 13. Native Window mode switch, live input validation & authenticated NDJSON screencast stream
      const setNative = await rawHttpRequest({
        port: handle.port,
        method: 'POST',
        path: '/api/browser/action',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setMode', visible: true, enginePreference: 'chromium', ensureStarted: false })
      });
      assert.equal(setNative.status, 200);
      const setNativeBody = JSON.parse(setNative.body);
      assert.equal(setNativeBody.visible, true);
      assert.equal(setNativeBody.enginePreference, 'chromium');
      assert.equal(typeof setNativeBody.enginesAvailable?.chromium, 'boolean');

      const resetEmbedded = await rawHttpRequest({
        port: handle.port,
        method: 'POST',
        path: '/api/browser/action',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setMode', visible: false, enginePreference: 'auto', ensureStarted: false })
      });
      assert.equal(resetEmbedded.status, 200);
      assert.equal(JSON.parse(resetEmbedded.body).visible, false);

      const badInput = await rawHttpRequest({
        port: handle.port,
        method: 'POST',
        path: '/api/browser/input',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'unsupported_kind' })
      });
      assert.equal(badInput.status, 400);

      const streamAbort = new AbortController();
      const streamRes = await fetch(`${handle.origin}/api/browser/stream`, {
        headers: authHeaders,
        signal: streamAbort.signal
      });
      assert.equal(streamRes.status, 200);
      const streamReader = streamRes.body!.getReader();
      const firstChunk = await streamReader.read();
      streamAbort.abort();
      await streamReader.cancel().catch(() => {});
      const firstLines = new TextDecoder().decode(firstChunk.value || new Uint8Array()).trim().split('\n');
      assert.ok(firstLines.length >= 1);
      const firstEvent = JSON.parse(firstLines[0]!);
      assert.ok(firstEvent.type === 'meta' || firstEvent.type === 'agent_activity');
      assert.equal(firstEvent.computerUsePolicy, 'tiered-approval');

      assert.equal(parseValidatedCdpPort('9222'), 9222);
      assert.throws(() => parseValidatedCdpPort('80'));
      assert.deepEqual(
        extractExplicitBookmarkUrls('<DT><A HREF="https://causyne.com/">Causyne</A><A HREF="javascript:alert(1)">Bad</A>'),
        ['https://causyne.com/']
      );

      // Shared Browser Streamable HTTP MCP endpoint: auth, protocol handshake, tools/list, and safe tools/call
      const unauthMcp = await fetch(`${handle.origin}/api/mcp/browser`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      });
      assert.equal(unauthMcp.status, 401);

      const getMcp = await fetch(`${handle.origin}/api/mcp/browser`, {
        method: 'GET',
        headers: authHeaders
      });
      assert.equal(getMcp.status, 405);

      const initMcp = await fetch(`${handle.origin}/api/mcp/browser`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25' }
        })
      });
      assert.equal(initMcp.status, 200);
      const initBody = await initMcp.json() as any;
      assert.equal(initBody.result?.serverInfo?.name, CAUSYNE_BROWSER_MCP_NAME);
      assert.equal(initBody.result?.protocolVersion, '2025-11-25');

      const notifMcp = await fetch(`${handle.origin}/api/mcp/browser`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
      });
      assert.equal(notifMcp.status, 202);

      const listMcp = await fetch(`${handle.origin}/api/mcp/browser`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      });
      assert.equal(listMcp.status, 200);
      const listBody = await listMcp.json() as any;
      const toolNames = (listBody.result?.tools || []).map((t: any) => t.name);
      assert.deepEqual(toolNames, CAUSYNE_BROWSER_MCP_TOOLS.map((t) => t.name));
      assert.ok(toolNames.includes('browser_read_page'));
      assert.ok(toolNames.includes('browser_screenshot'));

      const tabsMcp = await fetch(`${handle.origin}/api/mcp/browser`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'browser_tabs', arguments: { ensureStarted: false } }
        })
      });
      assert.equal(tabsMcp.status, 200);
      const tabsBody = await tabsMcp.json() as any;
      assert.equal(tabsBody.result?.isError, undefined);
      assert.match(String(tabsBody.result?.content?.[0]?.text || ''), /"active":\s*false/);

      const badRpc = await handleBrowserMcpRpc(
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nonexistent_tool', arguments: {} } },
        { workspaceRoot: tmpWs, version: 'test' }
      );
      assert.equal((badRpc?.result as any)?.isError, true);

      // Shared browser awareness prompt renders both idle and active live-tab context cleanly
      const idlePrompt = buildSharedBrowserAwarenessPrompt({
        active: false,
        visible: false,
        engine: null,
        activeTabId: null,
        url: '',
        title: '',
        viewport: { width: 1280, height: 800 },
        tabs: []
      }, true);
      assert.match(idlePrompt, /SHARED WORKSPACE BROWSER \(IDLE/);
      assert.match(idlePrompt, /causyne-browser/);

      const livePrompt = buildSharedBrowserAwarenessPrompt({
        active: true,
        visible: false,
        engine: 'chromium',
        activeTabId: 'tab-1',
        url: 'https://www.youtube.com/watch?v=demo123',
        title: 'Demo Figure Skating Exhibition',
        viewport: { width: 1280, height: 800 },
        tabs: [{ tabId: 'tab-1', url: 'https://www.youtube.com/watch?v=demo123', title: 'Demo Figure Skating Exhibition', active: true }]
      }, true);
      assert.match(livePrompt, /SHARED WORKSPACE BROWSER \(LIVE/);
      assert.match(livePrompt, /Demo Figure Skating Exhibition/);
      assert.match(livePrompt, /browser_screenshot/);
      assert.match(livePrompt, /browser_read_page/);

      // Web client script folds nativeStep notices into step timeline and filters degenerate "true" probes
      const htmlCheck = await fetch(`${handle.origin}/`);
      const htmlSource = await htmlCheck.text();
      assert.match(htmlSource, /addNativeStep/);
      assert.match(htmlSource, /ev\.nativeStep === true/);
      assert.match(htmlSource, /ensureModelPickerShell/);

      // /api/models mirrors CLI live model chooser (ACP / BYOK / FREE tri-tab structure)
      const cliModelsRes = await fetch(`${handle.origin}/api/models`, { headers: authHeaders });
      assert.equal(cliModelsRes.status, 200);
      const cliModelsBody = await cliModelsRes.json() as any;
      assert.ok(['acp', 'byok', 'free'].includes(cliModelsBody.initialTab));
      assert.ok(Array.isArray(cliModelsBody.tabs?.acp));
      assert.ok(Array.isArray(cliModelsBody.tabs?.byok));
      assert.ok(Array.isArray(cliModelsBody.tabs?.free));
      assert.ok(cliModelsBody.tabs.byok.some((it: any) => typeof it.category === 'string' && it.category.startsWith('BYOK · ')));
      assert.ok(cliModelsBody.tabs.free.some((it: any) => it.label === 'openrouter/free'));

      // Panel resize must never hard-lock inline flexBasis (prevents close-after-stretch regression)
      assert.ok(!htmlSource.includes('studioRoot.style.flexBasis = nextW'), 'panel resize must use --studio-w CSS variable, not inline flexBasis');
      assert.match(htmlSource, /toggleStudioMaximize/);
      assert.match(htmlSource, /saveCurrentSessionWorkspace/);
      assert.match(htmlSource, /applySessionWorkspace/);

      // Per-session Changes (/api/diff?scope=session&sessionId=...) isolates files between Conversation A and Conversation B
      const sessARes = await fetch(`${handle.origin}/api/sessions`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Conversation A' })
      });
      assert.equal(sessARes.status, 201);
      const sessA = ((await sessARes.json()) as any).session;

      const sessBRes = await fetch(`${handle.origin}/api/sessions`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Conversation B' })
      });
      assert.equal(sessBRes.status, 201);
      const sessB = ((await sessBRes.json()) as any).session;

      await fetch(`${handle.origin}/api/file`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'alpha.txt', content: 'from A\n', sessionId: sessA.id })
      });
      await fetch(`${handle.origin}/api/file`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'beta.txt', content: 'from B\n', sessionId: sessB.id })
      });

      const diffARes = await fetch(`${handle.origin}/api/diff?scope=session&sessionId=${encodeURIComponent(sessA.id)}`, { headers: authHeaders });
      assert.equal(diffARes.status, 200);
      const diffA = await diffARes.json() as any;
      assert.deepEqual((diffA.files || []).map((f: any) => f.path), ['alpha.txt']);

      const diffBRes = await fetch(`${handle.origin}/api/diff?scope=session&sessionId=${encodeURIComponent(sessB.id)}`, { headers: authHeaders });
      assert.equal(diffBRes.status, 200);
      const diffB = await diffBRes.json() as any;
      assert.deepEqual((diffB.files || []).map((f: any) => f.path), ['beta.txt']);
    } finally {
      await handle.close();
      fs.rmSync(tmpWs, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('runZeroSpendByokProbe skips unconfigured keys, verifies configured $0 cloud keys, and redacts secrets on error', async () => {
    // 1. All unconfigured -> 0 tested, all skipped cleanly (never touches paid keys)
    const emptyReport = await runZeroSpendByokProbe({
      env: { OPENAI_API_KEY: 'paid-should-not-be-touched', ANTHROPIC_API_KEY: 'paid-ignored' },
      probeOllama: false
    });
    assert.equal(emptyReport.testedCount, 0);
    assert.equal(emptyReport.failedCount, 0);
    assert.equal(emptyReport.skippedCount, 5);

    // 2. Configured free cloud keys -> runs HTTP 200 + tool schema probe and redacts secret on failure
    const origFetch = globalThis.fetch;
    const secretGroqKey = 'test-groq-secret-value-999';
    try {
      globalThis.fetch = (async (url: any) => {
        const host = new URL(String(url)).hostname.toLowerCase();
        if (host === 'generativelanguage.googleapis.com') {
          return Response.json({
            candidates: [{ content: { parts: [{ text: 'OK' }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, totalTokenCount: 11 }
          });
        }
        if (host === 'api.groq.com') {
          return new Response(JSON.stringify({ error: { message: `Bad auth for ${secretGroqKey}` } }), {
            status: 401,
            headers: { 'content-type': 'application/json' }
          });
        }
        return Response.json({
          choices: [{ message: { role: 'assistant', content: 'OK' } }],
          usage: { prompt_tokens: 10, completion_tokens: 1 }
        });
      }) as typeof fetch;

      const report = await runZeroSpendByokProbe({
        env: {
          GEMINI_API_KEY: 'test-gemini-free-token-001',
          GROQ_API_KEY: secretGroqKey,
          MISTRAL_API_KEY: 'test-mistral-free-token-002'
        },
        probeOllama: false
      });

      assert.equal(report.testedCount, 3);
      assert.equal(report.passedCount, 2);
      assert.equal(report.failedCount, 1);

      const formatted = formatByokProbeReport(report);
      assert.match(formatted, /gemini-free/);
      assert.match(formatted, /mistral/);
      assert.ok(!formatted.includes(secretGroqKey), 'probe report must redact failed API key');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
