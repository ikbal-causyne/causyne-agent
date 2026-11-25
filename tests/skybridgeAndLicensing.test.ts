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
