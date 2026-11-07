import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { determineToolScope } from '../src/smartToolsUse.js';
import { isWebIntent } from '../src/toolPacks.js';
import { AgentLoop } from '../src/agentLoop.js';
import { coldObserver } from '../src/observer/coldObserver.js';

test('Archetype Sizing for 3D City and Game Simulation Tasks', () => {
  const prompts = [
    'nyc-3d',
    'create 3d city simulator in nyc-3d',
    'build city simulation in nyc-3d',
    'buatkan city simulation 3d di folder nyc-3d',
    '3d city simulation',
    'interactive webgl simulation',
    'nyc-ride-simulator',
    'build 3d ride simulator in nyc-ride-simulator',
    'NYC Ultra-Realistic 3D Ride Simulator'
  ];

  for (const prompt of prompts) {
    const scope = determineToolScope(prompt);
    assert.equal(scope.archetype, 'game_development', `Prompt "${prompt}" must resolve to game_development archetype`);
  }
});

test('AgentLoop resolves archetype correctly when userPrompt is set without currentTaskPrompt', () => {
  const loop = new AgentLoop({
    provider: 'ollama',
    model: 'mock'
  });

  loop.userPrompt = 'build 3d city simulation in nyc-3d';
  assert.ok(!loop.currentTaskPrompt);

  const promptForArchetype = (loop.currentTaskPrompt || loop.userPrompt || '').trim();
  const archetype = determineToolScope(promptForArchetype).archetype;
  assert.equal(archetype, 'game_development');
});

test('Typo three.js prompts ("usingthree.js") and 3D CAD viewer prompts match web intent and web_engineering archetype', () => {
  const prompt = 'make 3d burger cad style view usingthree.js';
  assert.equal(isWebIntent(prompt), true);
  assert.equal(determineToolScope(prompt).archetype, 'web_engineering');
});

test('AgentLoop.hasWebSurfaceArtifacts detects HTML/CSS surfaces without false-positiving on plain JS/TS files', () => {
  const loop = new AgentLoop(null, 'test-web-surface', 'build a viewer');
  assert.equal(loop.hasWebSurfaceArtifacts(), false);

  loop.recordWebArtifact('server.js');
  assert.equal(loop.hasWebSurfaceArtifacts(), false);

  loop.recordWebArtifact('index.html');
  assert.equal(loop.hasWebSurfaceArtifacts(), true);
});

test('AgentLoop rejects dead claimed localhost server URLs and verifies once the server responds', async () => {
  let serverReady = false;
  const server = http.createServer((_req, res) => {
    if (!serverReady) {
      res.socket?.destroy();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body>OK</body></html>');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;

  try {
    const events: any[] = [];
    const loop = new AgentLoop(
      {
        readyState: 1,
        send: (payload: string) => {
          events.push(JSON.parse(payload));
        }
      },
      'test-dead-localhost-gate',
      'serve my static status page'
    );
    let turn = 0;
    const model = {
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async () => {
        turn++;
        if (turn === 1) {
          coldObserver.recordToolOutcome('test-dead-localhost-gate', 'sysRunBg', {
            command: `python3 -m http.server ${address.port}`
          }, { success: true });
          loop.stepsCompleted = 1;
          return {
            content: `The status page is running at ${url}.`,
            toolCalls: [],
            usage: { promptTokens: 20, completionTokens: 10 }
          };
        }
        serverReady = true;
        coldObserver.recordToolOutcome('test-dead-localhost-gate', 'sysRunBg', {
          command: `nohup python3 -m http.server ${address.port} </dev/null >/dev/null 2>&1 &`
        }, { success: true });
        loop.stepsCompleted = 2;
        return {
          content: `Restarted cleanly with detached stdio. The application is running at ${url}.`,
          toolCalls: [],
          usage: { promptTokens: 20, completionTokens: 10 }
        };
      }
    };
    loop.initializeProvider = () => model as never;
    loop.llm = model as never;

    await loop.run();
    assert.equal(turn, 2, 'AgentLoop must reject the first turn when the claimed localhost URL drops the connection');
    assert.ok(
      loop.messages.some((m: any) => m.role === 'system' && String(m.content).includes('[LOCAL SERVER VERIFICATION FAILED]')),
      'AgentLoop must inject [LOCAL SERVER VERIFICATION FAILED] directive when localhost check fails'
    );
    assert.ok(events.some((e) => e.type === 'task_complete'), 'Task must complete once the localhost URL responds HTTP 200');
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
