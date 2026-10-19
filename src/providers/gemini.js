import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider, mimeTypeForAudioFormat } from './base.js';

// Gemini's FunctionDeclaration schema is an OpenAPI subset, and it is strict in
// two ways that matter here:
//   1. `additionalProperties` is not part of the subset.
//   2. An OBJECT that declares no properties is rejected.
// Crucially, one bad declaration fails the *entire* request — so a single
// free-form object anywhere in the 69-tool catalogue takes every tool down with
// it. `web_fetch.headers` is exactly that shape and web_fetch is a CORE tool,
// which meant Gemini could not complete step one of any task at all.
//
// Rather than delete those parameters and lose the capability, free-form maps
// travel as JSON strings and are decoded again on the way back, so the tool
// still receives a real object. The paths that were rewritten are recorded per
// tool so the decode knows exactly where to look.

const FREE_FORM_NOTE = ' Pass this as a JSON object encoded in a string, for example {"key":"value"}.';

function isEmptyObjectSchema(schema) {
  return schema
    && schema.type === 'object'
    && (!schema.properties || Object.keys(schema.properties).length === 0);
}

/**
 * Rewrite one JSON Schema into Gemini's subset.
 *
 * @param {object} schema     The source schema.
 * @param {Array}  path       Segments walked so far; '[]' denotes array items.
 * @param {Array}  rewritten  Collects the paths converted to JSON strings.
 * @returns {object} A schema Gemini will accept.
 */
function adaptSchemaForGemini(schema, path, rewritten) {
  if (Array.isArray(schema)) {
    return schema.map(entry => adaptSchemaForGemini(entry, path, rewritten));
  }
  if (schema === null || typeof schema !== 'object') {
    return schema;
  }

  const adapted = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties') continue;

    if (key === 'properties' && value && typeof value === 'object') {
      const properties = {};
      for (const [name, child] of Object.entries(value)) {
        const childPath = [...path, name];
        if (isEmptyObjectSchema(child)) {
          rewritten.push(childPath);
          properties[name] = {
            type: 'string',
            description: (child.description || 'Free-form object.') + FREE_FORM_NOTE
          };
        } else {
          properties[name] = adaptSchemaForGemini(child, childPath, rewritten);
        }
      }
      adapted.properties = properties;
      continue;
    }

    if (key === 'items') {
      adapted.items = adaptSchemaForGemini(value, [...path, '[]'], rewritten);
      continue;
    }

    adapted[key] = adaptSchemaForGemini(value, path, rewritten);
  }

  return adapted;
}

/** Walk a decoded argument object and JSON.parse the fields that were stringified. */
function decodeFreeFormArgs(args, paths) {
  if (!args || paths.length === 0) return args;

  for (const path of paths) {
    applyAtPath(args, path, value => {
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value);
      } catch (e) {
        // The model sent something that is not JSON. Hand it through untouched
        // rather than destroying the argument.
        return value;
      }
    });
  }

  return args;
}

function applyAtPath(node, path, transform) {
  if (node === null || typeof node !== 'object') return;

  const [head, ...rest] = path;

  if (head === '[]') {
    if (!Array.isArray(node)) return;
    for (const entry of node) applyAtPath(entry, rest, transform);
    return;
  }

  if (rest.length === 0) {
    if (head in node) node[head] = transform(node[head]);
    return;
  }

  applyAtPath(node[head], rest, transform);
}

/**
 * Translate Gemini's `usageMetadata` into the OpenAI-shaped object that
 * `LLMProvider.normalizeUsage()` consumes, so every provider ends up on one
 * normalisation path instead of Gemini hand-rolling its own.
 *
 * TWO BUGS THIS FIXES, both in the cost the user is shown:
 *
 * 1. `cachedContentTokenCount` was dropped entirely. Gemini caches implicitly
 *    on a stable prefix, so the cache WAS working and `calculateCost()` IS
 *    cache-aware — it was simply fed a zero, and every cached token was
 *    displayed at the full input rate instead of 0.5x. Overstating the bill is
 *    how a user concludes Causyne is expensive and goes direct instead.
 *
 * 2. `thoughtsTokenCount` was dropped, and thinking tokens ARE billed as
 *    output ("Response pricing is the sum of output tokens and thinking
 *    tokens"). That understated the bill — the worse direction, because the
 *    real invoice then exceeds what Causyne promised.
 *
 * WHY `totalTokenCount` IS THE ANCHOR: whether `thoughtsTokenCount` is already
 * folded into `candidatesTokenCount` DIFFERS BY BACKEND — it is on the Gemini
 * API and is not on Vertex AI, and reports exist of the Gemini API behaving
 * both ways across model versions. Deriving completion as `total - prompt` is
 * correct under either convention; adding thoughts to candidates is correct
 * under only one and double-counts under the other. The sum is used only when
 * the total is missing or incoherent, where overstating is the safer error.
 *
 * @param   {object} usageMetadata  Gemini's usage block, possibly undefined.
 * @returns {object}                OpenAI-shaped usage for normalizeUsage().
 */
export function geminiUsageToOpenAIShape(usageMetadata) {
  const prompt = usageMetadata?.promptTokenCount || 0;
  const candidates = usageMetadata?.candidatesTokenCount || 0;
  const thoughts = usageMetadata?.thoughtsTokenCount || 0;
  const total = usageMetadata?.totalTokenCount || 0;

  const completion = total > prompt ? total - prompt : candidates + thoughts;

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    // normalizeUsage() clamps this to prompt_tokens, which also protects
    // against a backend that reports the cached count OUTSIDE the prompt total.
    prompt_tokens_details: { cached_tokens: usageMetadata?.cachedContentTokenCount || 0 }
  };
}

export class GeminiProvider extends LLMProvider {
  constructor(config) {
    super(config);
    this.model = canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['gemini']);
    this.baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    // Every Gemini model from 1.5 onward accepts image input.
    this.visionModels = ['gemini-'];
    this.imagePayloadFormat = 'gemini';
    // Gemini takes audio the same way it takes images — inlineData with a real
    // MIME type — across the whole gemini- family, and accepts m4a/aac natively,
    
    // smaller than WAV, so it clears the transport ceiling far more often.
    this.audioModels = ['gemini-'];
    this.audioPayloadFormat = 'gemini';
  }

  async chat(messages, options = {}) {
    messages = this.prepareMessages(messages);
    // Map OpenAI messages to Gemini contents.
    // System blocks ACCUMULATE. Assigning instead of appending meant that with
    // the agent's three-block system stack only the last block survived: the
    // core SYSTEM_PROMPT, the capability-pack catalogue and every playbook were
    // silently discarded on every single Gemini request.
    const systemParts = [];
    const contents = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        const text = typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content);
        if (text) systemParts.push({ text });
        continue;
      }

      const role = msg.role === 'assistant' ? 'model' : 'user';

      if (msg.tool_calls) {
        // The assistant's own words travel with its calls. Dropping the text
        // meant the model's stated reasoning never re-entered the history.
        const parts = [];
        if (msg.content) parts.push({ text: String(msg.content) });
        for (const tc of msg.tool_calls) {
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments || '{}')
                : (tc.function.arguments || {})
            }
          });
        }
        contents.push({ role, parts });
      } else if (msg.role === 'tool') {
        // Add tool response
        contents.push({
          role: 'user', // Gemini expects tool responses to come from 'user' or 'function'
          parts: [{
            functionResponse: {
              name: msg.name,
              response: { result: msg.content }
            }
          }]
        });
      } else {
        if (Array.isArray(msg.content)) {
          const mappedParts = msg.content.map(part => {
            if (part.type === 'text') return { text: part.text };
            if (part.type === 'image_url') {
              const b64 = part.image_url.url.split('base64,')[1];
              const mime = part.image_url.url.split(';')[0].replace('data:', '');
              return { inlineData: { mimeType: mime, data: b64 } };
            }
            // Anthropic-shaped image block. Without this branch it fell through
            // to the empty-text default and the image vanished silently.
            if (part.type === 'image' && part.source?.type === 'base64') {
              return { inlineData: { mimeType: part.source.media_type, data: part.source.data } };
            }
            // Audio normalised by prepareMessages already arrives as inlineData;
            // this branch covers an input_audio block replayed from history that
            // predates the normaliser. The MIME type is derived from the clip's
            // real container instead of the old hardcoded audio/mp4, which
            
            if (part.type === 'input_audio') {
              return {
                inlineData: {
                  mimeType: mimeTypeForAudioFormat(part.input_audio?.format),
                  data: part.input_audio?.data
                }
              };
            }
            if (part.inlineData) return part;
            return { text: '' };
          });
          contents.push({ role, parts: mappedParts });
        } else {
          contents.push({ role, parts: [{ text: msg.content }] });
        }
      }
    }

    const payload = {
      contents,
      generationConfig: {
        temperature: options.temperature || 0.1,
      }
    };

    if (systemParts.length > 0) {
      payload.systemInstruction = { parts: systemParts };
    }

    // Map tools. freeFormPaths remembers which arguments were stringified so the
    // response handler can turn them back into objects.
    const freeFormPaths = new Map();

    if (options.tools && options.tools.length > 0) {
      payload.tools = [{
        functionDeclarations: options.tools.map(t => {
          const toolObj = t.function ? t.function : t;
          const declaration = {
            name: toolObj.name,
            description: toolObj.description || ''
          };

          const source = toolObj.parameters || toolObj.input_schema;
          // A tool that takes no arguments must omit `parameters` entirely —
          // an OBJECT with empty properties is rejected outright.
          if (source && !isEmptyObjectSchema(source)) {
            const rewritten = [];
            declaration.parameters = adaptSchemaForGemini(source, [], rewritten);
            if (rewritten.length > 0) freeFormPaths.set(toolObj.name, rewritten);
          }

          return declaration;
        })
      }];
    }

    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Gemini API Error (${response.status}): ${errorData}`);
    }

    const data = await response.json();

    const firstCandidate = data.candidates?.[0];
    if (!firstCandidate) {
      throw new Error('No candidate returned from Gemini');
    }

    let content = '';
    let toolCalls = [];

    for (const part of firstCandidate.content.parts) {
      if (part.text) {
        content += part.text;
      } else if (part.functionCall) {
        const args = decodeFreeFormArgs(
          part.functionCall.args || {},
          freeFormPaths.get(part.functionCall.name) || []
        );
        toolCalls.push({
          id: `call_${Math.random().toString(36).substr(2, 9)}`,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(args)
          }
        });
      }
    }

    return {
      content: content.trim(),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: this.normalizeUsage(geminiUsageToOpenAIShape(data.usageMetadata))
    };
  }
}
