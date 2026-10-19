// What happens when the model cannot be reached.
//
// The reported behaviour: two red `network_error: fetch failed` lines, the
// status still reading "Thinking", 27 seconds elapsed and climbing. Underneath,
// the loop was treating every connection failure as "transient" and retrying
// immediately — no backoff, no ceiling — so a sleeping laptop or a mistyped
// base URL produced up to the whole step budget of attempts against a dead
// endpoint. From the outside that is indistinguishable from working.
//
// For a product aimed at a very large number of people this is the single most
// common failure there is, so it has to be bounded and it has to say something
// the user can act on.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { explainNetworkError, AgentLoop } from '../src/agentLoop.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const failure = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

describe('a connection failure explains itself', () => {
  test('"fetch failed" is replaced by the actual reason', () => {
    const text = explainNetworkError(failure('ENOTFOUND'), { provider: 'Gemini' });
    assert.ok(!/^fetch failed/.test(text));
    assert.match(text, /could not be resolved/i, 'the cause is in error.cause and was being discarded');
  });

  test('each cause gets its own diagnosis and its own advice', () => {
    const cases = {
      ENOTFOUND: /resolved/i,
      ECONNREFUSED: /accepted the connection/i,
      UND_ERR_CONNECT_TIMEOUT: /timed out/i,
      DEPTH_ZERO_SELF_SIGNED_CERT: /proxy may be intercepting/i,
      ENETUNREACH: /no route/i
    };
    for (const [code, pattern] of Object.entries(cases)) {
      assert.match(explainNetworkError(failure(code), {}), pattern, `${code} was not diagnosed`);
    }
  });

  test('it names the provider and the host so the user knows what to check', () => {
    const text = explainNetworkError(failure('ENOTFOUND'), {
      provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1'
    });
    assert.match(text, /openai-compatible/);
    assert.match(text, /api\.example\.com/);
  });

  test('SECURITY: the endpoint is a host, never a URL', () => {
    // Several adapters carry the key in the query string — the Gemini one
    // builds `...:generateContent?key=${apiKey}`. Echoing a URL into an error
    // message, a log or a phone notification would publish the user's key.
    const text = explainNetworkError(failure('ENOTFOUND'), {
      provider: 'Gemini', baseUrl: 'https://host.example/v1?key=SUPERSECRETKEY123'
    });
    assert.ok(!text.includes('SUPERSECRETKEY123'), 'an API key must never reach an error message');
    assert.ok(!text.includes('?'), 'no query string may survive into the text');
  });

  test('the Gemini adapter really does put the key in the URL', () => {
    // If this ever stops being true the guard above is still correct, but the
    // reason for it should be re-read rather than assumed.
    const adapter = fs.readFileSync(path.join(repoRoot, 'src', 'providers', 'gemini.js'), 'utf8');
    assert.match(adapter, /key=\$\{this\.apiKey\}/,
      'the host-only rule exists because of this line');
  });

  test('an unknown cause still produces something usable', () => {
    const text = explainNetworkError(failure('SOMETHING_NEW'), {});
    assert.match(text, /SOMETHING_NEW/, 'an unrecognised code must still be reported, not swallowed');
    assert.match(text, /retry|check/i);
  });

  test('a malformed base URL does not throw', () => {
    assert.doesNotThrow(() => explainNetworkError(failure('ENOTFOUND'), { baseUrl: 'not a url' }));
    assert.doesNotThrow(() => explainNetworkError(new Error('x'), {}));
  });
});

describe('retries are bounded', () => {
  const loop = fs.readFileSync(path.join(repoRoot, 'src', 'agentLoop.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

  test('there is a ceiling, and it is small', () => {
    assert.ok(Number.isInteger(AgentLoop.MAX_CONSECUTIVE_FAILURES));
    assert.ok(AgentLoop.MAX_CONSECUTIVE_FAILURES >= 2 && AgentLoop.MAX_CONSECUTIVE_FAILURES <= 5,
      'high enough to ride out a blip, low enough to report a dead endpoint in seconds');
  });

  test('the loop stops once the ceiling is reached', () => {
    assert.match(loop, /consecutiveFailures\s*>=\s*AgentLoop\.MAX_CONSECUTIVE_FAILURES/,
      'without this it retries until the step budget is gone');
    const region = loop.slice(loop.indexOf('consecutiveFailures >= AgentLoop.MAX_CONSECUTIVE_FAILURES'));
    assert.match(region.slice(0, 900), /break;/, 'reaching the ceiling must end the loop');
  });

  test('it backs off between attempts', () => {
    assert.match(loop, /await this\.backoff\(/,
      'retrying as fast as the loop can spin turns a blip into a burst of failures');
  });

  test('the backoff is interruptible', async () => {
    // Without the abort listener, esc during a wait would sit out the full
    // delay before anything responded.
    const stub = Object.create(AgentLoop.prototype);
    stub.abortController = new AbortController();
    const started = Date.now();
    const waiting = stub.backoff(4);
    stub.abortController.abort();
    await waiting;
    assert.ok(Date.now() - started < 500, 'aborting must cut the wait short');
  });

  test('the counter resets after a successful call', () => {
    assert.match(loop, /this\.consecutiveFailures = 0;/,
      'one failure at step 2 and another at step 200 are not consecutive');
  });

  test('a network failure does not push a system message per attempt', () => {
    // The model cannot fix DNS. A message per attempt grows the context and
    // the bill for nothing.
    const region = loop.slice(loop.indexOf('const isNetwork ='));
    assert.match(region.slice(0, 2500), /if \(!isNetwork\) \{[\s\S]*?SYSTEM ERROR RECOVERED/,
      'the recovery message must be limited to errors the model can act on');
  });
});

describe('the transcript is not a telemetry feed', () => {
  const loop = fs.readFileSync(path.join(repoRoot, 'src', 'agentLoop.js'), 'utf8');

  test('internal sizing and classifier output stay behind the debug flag', () => {
    // Invoking a skill printed three lines of internals before anything
    // happened: the task-shape guess, the tier, the step budget and the context
    // size. Neither reference shows any of it.
    for (const internal of [
      'task shape:', 'capability packs pre-warmed', 'context decay reclaimed',
      'compacted ', 'prompt cache hit', 'unlocked capability pack', 'char context'
    ]) {
      const index = loop.indexOf(internal);
      if (index === -1) continue;
      const line = loop.slice(loop.lastIndexOf('\n', index) + 1, loop.indexOf('\n', index));
      assert.ok(!/this\.notice\(/.test(line),
        `"${internal}" is internal telemetry and must go to debugLog, not the transcript`);
    }
  });

  test('what the user genuinely needs to know is still shown', () => {
    assert.match(loop, /this\.notice\(`saved attached document to/,
      'a file written on the user\'s behalf is not telemetry — they must be told');
  });
});
