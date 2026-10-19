// Offline request capture for provider conformance tests.
//
// Every provider adapter talks to its API through globalThis.fetch. Swapping in a
// stub lets the suite assert on the exact bytes each adapter would put on the wire
// without a network call, an API key, or a cent of spend.

/**
 * Install a fetch stub for the duration of one assertion.
 *
 * @param {object} cannedResponse  Parsed JSON body the adapter should receive back.
 * @returns {{requests: Array, restore: Function}}
 */
export function captureFetch(cannedResponse) {
  const original = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, init = {}) => {
    let body = null;
    if (init.body) {
      try {
        body = JSON.parse(init.body);
      } catch (e) {
        body = init.body;
      }
    }
    requests.push({ url: String(url), headers: init.headers || {}, body });

    return {
      ok: true,
      status: 200,
      json: async () => cannedResponse,
      text: async () => JSON.stringify(cannedResponse)
    };
  };

  return {
    requests,
    restore() {
      globalThis.fetch = original;
    }
  };
}

/**
 * Run one provider.chat() against the stub and hand back the captured payload.
 *
 * @param {object} provider        An LLMProvider instance.
 * @param {object} cannedResponse  Provider-shaped response body.
 * @param {Array}  messages        Messages to send.
 * @param {object} options         chat() options (tools, temperature, ...).
 */
export async function callAndCapture(provider, cannedResponse, messages, options = {}) {
  const capture = captureFetch(cannedResponse);
  try {
    const result = await provider.chat(messages, options);
    return { payload: capture.requests[0]?.body, request: capture.requests[0], result };
  } finally {
    capture.restore();
  }
}

// ---------------------------------------------------------------------------
// Canned responses, one per wire format. Each carries a single tool call so the
// round-trip assertion has something to follow through the pipeline.
// ---------------------------------------------------------------------------

export const CANNED = {
  openai: {
    choices: [{
      message: {
        content: 'Reading the file now.',
        tool_calls: [{
          id: 'call_abc123',
          type: 'function',
          function: { name: 'fs_read', arguments: '{"path":"/tmp/causyne-conformance.txt"}' }
        }]
      }
    }],
    usage: { prompt_tokens: 100, completion_tokens: 20 }
  },

  anthropic: {
    content: [
      { type: 'text', text: 'Reading the file now.' },
      {
        type: 'tool_use',
        id: 'toolu_abc123',
        name: 'fs_read',
        input: { path: '/tmp/causyne-conformance.txt' }
      }
    ],
    usage: { input_tokens: 100, output_tokens: 20 }
  },

  gemini: {
    candidates: [{
      content: {
        parts: [
          { text: 'Reading the file now.' },
          { functionCall: { name: 'fs_read', args: { path: '/tmp/causyne-conformance.txt' } } }
        ]
      }
    }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 }
  },

  // Ollama omits the tool-call id entirely — that omission is the defect the
  // round-trip assertion exists to catch.
  ollama: {
    message: {
      content: 'Reading the file now.',
      tool_calls: [{
        function: { name: 'fs_read', arguments: { path: '/tmp/causyne-conformance.txt' } }
      }]
    },
    prompt_eval_count: 100,
    eval_count: 20
  }
};
