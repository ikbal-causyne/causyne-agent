import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { DeepSeekProvider } from '../src/providers/deepseek.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { GeminiProvider } from '../src/providers/gemini.js';
import { OllamaProvider } from '../src/providers/ollama.js';
import { buildGeminiStreamUrl } from '../src/providers/byokStream.js';

function makeStreamResponse(chunks: string[], contentType = 'text/event-stream; charset=utf-8'): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': contentType }
  });
}

async function withMockFetch<T>(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return await handler(url, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('Sector 6B — BYOK Real-Time SSE & NDJSON Streaming', () => {
  test('OpenAI-compatible & DeepSeek SSE streams content, reasoning, incremental tool_calls, and usage', async () => {
    const fakeKey = ['stream', 'oai', 'fixture', '101'].join('-');
    const chunksReceived: string[] = [];
    const reasoningReceived: string[] = [];
    let capturedBody: Record<string, unknown> | null = null;

    await withMockFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return makeStreamResponse([
        'data: {"choices":[{"index":0,"delta":{"reasoning_content":"Think "}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"reasoning_content":"step 1"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"content":"Hello "}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"content":"world!"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"fs_","arguments":"{\\"pa"}}]}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"read","arguments":"th\\":\\"a.ts\\"}"}}]}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":42,"completion_tokens":18}}\n\n',
        'data: [DONE]\n\n'
      ]);
    }, async () => {
      const provider = new DeepSeekProvider({ apiKey: fakeKey, model: 'deepseek-reasoner' });
      const res = await provider.chat([{ role: 'user', content: 'hi' }], {
        onChunk: (d: string) => chunksReceived.push(d),
        onReasoningChunk: (r: string) => reasoningReceived.push(r)
      });

      assert.equal(capturedBody?.stream, true);
      assert.deepEqual(chunksReceived, ['Hello ', 'world!']);
      assert.deepEqual(reasoningReceived, ['Think ', 'step 1']);
      assert.equal(res.content, 'Hello world!');
      assert.equal(res.reasoningContent, 'Think step 1');
      assert.equal(res.toolCalls?.length, 1);
      assert.equal(res.toolCalls?.[0]?.function.name, 'fs_read');
      assert.equal(res.toolCalls?.[0]?.function.arguments, '{"path":"a.ts"}');
      assert.equal(res.usage?.promptTokens, 42);
      assert.equal(res.usage?.completionTokens, 18);
    });
  });

  test('OpenAI-compatible degrades gracefully when an upstream proxy returns JSON instead of SSE', async () => {
    const fakeKey = ['stream', 'fallback', 'fixture', '102'].join('-');
    const chunks: string[] = [];

    await withMockFetch(async () => new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'JSON fallback reply' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }), async () => {
      const provider = new OpenAICompatibleProvider({
        apiKey: fakeKey,
        baseUrl: 'https://api.example.test/v1/chat/completions',
        model: 'gpt-4o'
      });
      const res = await provider.chat([{ role: 'user', content: 'hi' }], {
        onChunk: (d: string) => chunks.push(d)
      });
      assert.equal(res.content, 'JSON fallback reply');
      assert.deepEqual(chunks, ['JSON fallback reply']);
    });
  });

  test('Anthropic SSE streams thinking (with signature), text, tool_use JSON deltas, and cache-aware usage', async () => {
    const fakeKey = ['stream', 'anth', 'fixture', '202'].join('-');
    const textChunks: string[] = [];
    const thinkChunks: string[] = [];

    await withMockFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body || '{}'));
      assert.equal(body.stream, true);
      return makeStreamResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":50,"cache_creation_input_tokens":20,"output_tokens":1}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan "}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"now."}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_abc123"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Done"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_9","name":"fs_read","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\\"README.md\\"}"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":33}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      ]);
    }, async () => {
      const provider = new AnthropicProvider({ apiKey: fakeKey, model: 'claude-sonnet-4-6' });
      const res = await provider.chat([{ role: 'user', content: 'read readme' }], {
        onChunk: (d: string) => textChunks.push(d),
        onReasoningChunk: (r: string) => thinkChunks.push(r)
      });

      assert.deepEqual(thinkChunks, ['Plan ', 'now.']);
      assert.deepEqual(textChunks, ['Done']);
      assert.equal(res.content, 'Done');
      assert.equal(res.reasoningContent, 'Plan now.');
      assert.equal(res.thinkingBlocks?.[0]?.signature, 'sig_abc123', 'thinking signature must survive SSE assembly');
      assert.equal(res.toolCalls?.length, 1);
      assert.equal(res.toolCalls?.[0]?.function.name, 'fs_read');
      assert.equal(res.toolCalls?.[0]?.function.arguments, '{"path":"README.md"}');
      assert.equal(res.usage?.promptTokens, 170);
      assert.equal(res.usage?.cachedPromptTokens, 50);
      assert.equal(res.usage?.cacheWriteTokens, 20);
      assert.equal(res.usage?.completionTokens, 33);
    });
  });

  test('Gemini SSE streams thought/text/functionCall via :streamGenerateContent?alt=sse with x-goog-api-key header only', async () => {
    const fakeKey = ['stream', 'gem', 'fixture', '303'].join('-');
    const textChunks: string[] = [];
    const thinkChunks: string[] = [];
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};

    assert.equal(
      buildGeminiStreamUrl('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent'),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse'
    );

    await withMockFetch(async (url, init) => {
      capturedUrl = url;
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return makeStreamResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"Reasoning...","thought":true}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"Answer "}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"part 2"},{"functionCall":{"name":"fs_list","args":{"path":"."}}}]}}],"usageMetadata":{"promptTokenCount":80,"candidatesTokenCount":25,"totalTokenCount":105}}\n\n'
      ]);
    }, async () => {
      const provider = new GeminiProvider({ apiKey: fakeKey, model: 'gemini-2.5-pro' });
      const res = await provider.chat([{ role: 'user', content: 'list' }], {
        onChunk: (d: string) => textChunks.push(d),
        onReasoningChunk: (r: string) => thinkChunks.push(r)
      });

      assert.match(capturedUrl, /:streamGenerateContent\?alt=sse$/);
      assert.ok(!capturedUrl.includes(fakeKey), 'API key must NEVER appear in Gemini streaming URL');
      assert.equal(capturedHeaders['x-goog-api-key'], fakeKey);
      assert.deepEqual(thinkChunks, ['Reasoning...']);
      assert.deepEqual(textChunks, ['Answer ', 'part 2']);
      assert.equal(res.content, 'Answer part 2');
      assert.equal(res.reasoningContent, 'Reasoning...');
      assert.equal(res.toolCalls?.length, 1);
      assert.equal(res.toolCalls?.[0]?.function.name, 'fs_list');
      assert.equal(res.usage?.promptTokens, 80);
      assert.equal(res.usage?.completionTokens, 25);
    });
  });

  test('Ollama NDJSON streams thinking, content, tool calls, and token counts', async () => {
    const textChunks: string[] = [];
    const thinkChunks: string[] = [];

    await withMockFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body || '{}'));
      assert.equal(body.stream, true);
      return makeStreamResponse([
        '{"message":{"role":"assistant","thinking":"Local thought"},"done":false}\n',
        '{"message":{"role":"assistant","content":"Hi "},"done":false}\n',
        '{"message":{"role":"assistant","content":"local!","tool_calls":[{"function":{"name":"fs_list","arguments":{"path":"."}}}]},"done":true,"prompt_eval_count":30,"eval_count":12}\n'
      ], 'application/x-ndjson');
    }, async () => {
      const provider = new OllamaProvider({ model: 'qwen3:8b' });
      const res = await provider.chat([{ role: 'user', content: 'hi' }], {
        onChunk: (d: string) => textChunks.push(d),
        onReasoningChunk: (r: string) => thinkChunks.push(r)
      });

      assert.deepEqual(thinkChunks, ['Local thought']);
      assert.deepEqual(textChunks, ['Hi ', 'local!']);
      assert.equal(res.content, 'Hi local!');
      assert.equal(res.reasoningContent, 'Local thought');
      assert.equal(res.toolCalls?.length, 1);
      assert.equal(res.toolCalls?.[0]?.function.name, 'fs_list');
      assert.equal(res.usage?.promptTokens, 30);
      assert.equal(res.usage?.completionTokens, 12);
    });
  });

  test('SSE error frames redact provider API keys and strip ANSI escapes', async () => {
    const secret = ['secret', 'stream', 'token', '99999'].join('-');

    await withMockFetch(async () => makeStreamResponse([
      `data: {"error":{"message":"\\u001b[31mRejected key ${secret}\\u001b[0m"}}\n\n`
    ]), async () => {
      const provider = new OpenAICompatibleProvider({
        apiKey: secret,
        baseUrl: 'https://api.example.test/v1/chat/completions',
        model: 'gpt-4o'
      });
      await assert.rejects(
        provider.chat([{ role: 'user', content: 'hi' }], { onChunk: () => {} }),
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          assert.ok(!msg.includes(secret), 'stream error must redact secret');
          assert.doesNotMatch(msg, /\x1b/);
          assert.match(msg, /\[REDACTED\]/);
          return true;
        }
      );
    });
  });
});

test('Ollama NDJSON reports provider errors instead of returning partial success', async () => {
  await withMockFetch(async () => makeStreamResponse([
    '{"message":{"content":"partial"},"done":false}\n',
    '{"error":"model unavailable"}\n'
  ], 'application/x-ndjson'), async () => {
    const provider = new OllamaProvider({ model: 'qwen3:8b' });
    await assert.rejects(provider.chat([{ role: 'user', content: 'hi' }], {
      onChunk: () => {}
    }), /model unavailable/);
  });
});

test('Ollama NDJSON propagates application callback failures', async () => {
  await withMockFetch(async () => makeStreamResponse([
    '{"message":{"content":"partial"},"done":false}\n'
  ], 'application/x-ndjson'), async () => {
    const provider = new OllamaProvider({ model: 'qwen3:8b' });
    await assert.rejects(provider.chat([{ role: 'user', content: 'hi' }], {
      onChunk: () => { throw new Error('callback fixture failure'); }
    }), /callback fixture failure/);
  });
});

test('SSE accepts bare CR and split CRLF event delimiters', async () => {
  const chunks: string[] = [];
  await withMockFetch(async () => makeStreamResponse([
    'data: {"choices":[{"delta":{"content":"A"}}]}\r\r',
    'data: {"choices":[{"delta":{"content":"B"}}]}\r',
    '\n\r',
    '\ndata: [DONE]\r\r'
  ]), async () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: 'fixture-key', baseUrl: 'https://api.example.test/v1/chat/completions', model: 'gpt-4o'
    });
    const result = await provider.chat([{ role: 'user', content: 'hi' }], {
      onChunk: (delta: string) => chunks.push(delta)
    });
    assert.deepEqual(chunks, ['A', 'B']);
    assert.equal(result.content, 'AB');
  });
});
