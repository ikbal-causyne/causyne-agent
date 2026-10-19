import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { LLMProvider } from './base.js';

// Models that support server-side tool search (defer_loading + tool_reference
// expansion). On these, Causyne hands Anthropic the complete 69-tool catalogue
// and lets the API keep deferred schemas out of the context window entirely —
// full capability, none of the token cost. Older models fall back to the
// client-side progressive disclosure in src/toolPacks.js.
const TOOL_SEARCH_MODELS = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5'
];

// Sampling parameters (temperature / top_p / top_k) were removed from these
// models and now return a 400. Sending temperature unconditionally meant every
// request on the current frontier line-up failed outright — the very models
// listed in TOOL_SEARCH_MODELS above. Depth is controlled with effort instead.
const NO_SAMPLING_MODELS = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5'
];

// Models that accept an operator instruction as a `system` entry inside
// messages[] rather than only in the top-level system block. Keeping a
// mid-conversation nudge in sequence preserves both its meaning and the cached
// prefix; hoisting it to the front changed when the model thought it applied.
const MID_CONVERSATION_SYSTEM_MODELS = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5',
  'claude-opus-4-8'
];

// Models that take adaptive thinking. On these, `budget_tokens` is REJECTED
// with a 400 — the fixed-budget parameter many agents still send was removed,
// and depth is controlled with `output_config.effort` instead.
//
// Two of these behave differently on omission, which is the whole reason this
// list exists: Claude Opus 5 and Fable 5 think by default, but Opus 4.8/4.7,
// Sonnet 5 and the 4.6 pair run with NO thinking unless `{type:'adaptive'}` is
// sent explicitly. Causyne was sending nothing, so on those models the single
// largest lever on frontier-model quality was simply switched off — directly
// which prevents the configured model from using its intended reasoning mode.
const ADAPTIVE_THINKING_MODELS = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6'
];

// Models that think by default, so adaptive need not be requested. Sending it
// anyway is harmless; sending {type:'disabled'} to them is what changes
// behaviour, and on Fable 5 that is a 400.
const THINKS_BY_DEFAULT_MODELS = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5'
];

// Models that reject any explicit thinking configuration at all.
const THINKING_ALWAYS_ON_MODELS = [
  'claude-fable-5',
  'claude-mythos-5'
];

// `output_config.effort`. Opus 4.5 accepts only low/medium/high; the adaptive
// family adds xhigh and max. Sonnet 4.5 and Haiku 4.5 reject effort outright.
const EFFORT_MODELS = [...ADAPTIVE_THINKING_MODELS, 'claude-opus-4-5'];
const LIMITED_EFFORT_MODELS = ['claude-opus-4-5', 'claude-opus-4-6', 'claude-sonnet-4-6'];
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

function modelMatches(model, list) {
  const normalized = (model || '').toLowerCase();
  return list.some(supported => normalized.startsWith(supported));
}

export class AnthropicProvider extends LLMProvider {
  constructor(config) {
    super(config);
    this.baseUrl = 'https://api.anthropic.com/v1/messages';
    this.model = canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['anthropic']);
    this.visionModels = ['*'];
    // Anthropic reads images on every model but accepts no audio input at all.
    this.audioModels = [];
    this.imagePayloadFormat = 'anthropic';
    this.enableToolSearch = config.enableToolSearch !== false;
    this.enableCaching = config.enablePromptCaching !== false;
    // Agent tasks routinely run far longer than the 5-minute default cache
    // lifetime. Re-writing a ~5,000-token prefix at 1.25x every time the window
    // lapses costs more than writing it once at 2.0x with a 1-hour lifetime, so
    // the extended TTL is the cheaper default for this workload.
    this.cacheTtl = config.promptCacheTtl || '1h';

    // 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'off'. Unset means: let the
    // API pick its own default depth, and still turn thinking ON for the models
    // where omission would silently disable it.
    this.reasoningEffort = config.reasoningEffort || null;
    // Surface the reasoning summary to the user. Off by default — it is extra
    // output tokens on every turn, and this project runs on the user's own key.
    this.showReasoning = config.showReasoning === true;
    // Only consulted for pre-adaptive models.
    this.reasoningBudgetTokens = config.reasoningBudgetTokens || null;
  }

  cacheControl() {
    return this.cacheTtl === '5m'
      ? { type: 'ephemeral' }
      : { type: 'ephemeral', ttl: this.cacheTtl };
  }

  supportsToolSearch() {
    if (!this.enableToolSearch) return false;
    return modelMatches(this.model, TOOL_SEARCH_MODELS);
  }

  /** True when this model rejects temperature / top_p / top_k with a 400. */
  rejectsSamplingParameters() {
    return modelMatches(this.model, NO_SAMPLING_MODELS);
  }

  /** True when this model takes `thinking: {type:'adaptive'}`. */
  supportsAdaptiveThinking() {
    return modelMatches(this.model, ADAPTIVE_THINKING_MODELS);
  }

  /**
   * Resolve the configured reasoning effort to something this model accepts.
   * Returns null when effort must not be sent at all.
   */
  resolveEffort() {
    if (!modelMatches(this.model, EFFORT_MODELS)) return null;
    const requested = String(this.reasoningEffort || '').toLowerCase();
    if (!EFFORT_LEVELS.includes(requested)) return null;
    if (modelMatches(this.model, LIMITED_EFFORT_MODELS) && (requested === 'xhigh' || requested === 'max')) {
      // These models stop at 'high'; asking for more is a 400, so clamp rather
      // than fail the whole request over a preference.
      return 'high';
    }
    return requested;
  }

  /**
   * The `thinking` parameter for this model, or null to omit it.
   *
   * Omission is meaningful and model-dependent, which is why this is a method
   * and not a constant: on Fable 5 any explicit value is a 400; on Opus 5
   * omitting still thinks; on Opus 4.8/4.7 and the Sonnets omitting means no
   * thinking at all.
   */
  buildThinking() {
    if (modelMatches(this.model, THINKING_ALWAYS_ON_MODELS)) return null;

    if (this.reasoningEffort === 'off') {
      // Only meaningful where thinking would otherwise be on. Note the Opus 5
      // caveat: disabling is accepted only at effort 'high' or below.
      if (!modelMatches(this.model, THINKS_BY_DEFAULT_MODELS)) return null;
      const effort = this.resolveEffort();
      if (effort === 'xhigh' || effort === 'max') return null;
      return { type: 'disabled' };
    }

    if (this.supportsAdaptiveThinking()) {
      const thinking = { type: 'adaptive' };
      
      // long silence instead of the agent's reasoning.
      if (this.showReasoning) thinking.display = 'summarized';
      return thinking;
    }

    // Pre-adaptive models still use a fixed budget. It must be below max_tokens
    // and at least 1024, or the request errors.
    if (this.reasoningBudgetTokens) {
      return { type: 'enabled', budget_tokens: this.reasoningBudgetTokens };
    }
    return null;
  }

  /** True when a mid-conversation operator instruction may stay in sequence. */
  supportsMidConversationSystem() {
    return modelMatches(this.model, MID_CONVERSATION_SYSTEM_MODELS);
  }

  async chat(messages, options = {}) {
    // Anthropic separates the system prompt from the message list.
    const systemBlocks = [];
    const anthropicMessages = [];

    // Anthropic accepts at most 4 cache_control breakpoints per request. The
    // agent loop anchors up to three stable system blocks and one is reserved
    // for the last tool, so system anchors are capped at 3 here — an extra
    // anchor added upstream can never push the request over the limit (a 400).
    const MAX_SYSTEM_CACHE_BREAKPOINTS = 3;
    let systemCacheBreakpoints = 0;

    const allowInlineSystem = this.supportsMidConversationSystem();

    for (const msg of messages) {
      if (msg.role === 'system') {
        // The leading system stack is the prompt itself and always belongs in
        // the top-level `system` field. A system message that arrives *after*
        // the conversation has started is an operator nudge; hoisting it to the
        // front moved it out of the sequence it was meant to apply to. On models
        // that accept it, keep it in place — it must follow a user turn and sit
        // last, which is exactly where the agent loop emits it.
        const isMidConversation = anthropicMessages.length > 0;
        const lastEmitted = anthropicMessages[anthropicMessages.length - 1];
        if (isMidConversation && allowInlineSystem && lastEmitted?.role === 'user') {
          anthropicMessages.push({ role: 'system', content: String(msg.content) });
          continue;
        }

        const block = { type: 'text', text: String(msg.content) };
        // Stable system blocks are cache anchors; everything volatile is ordered
        // after them by the agent loop, which is what makes the prefix cacheable.
        // Capped so the reserved tool breakpoint always fits within Anthropic's 4.
        if (msg.cacheAnchor && this.enableCaching && systemCacheBreakpoints < MAX_SYSTEM_CACHE_BREAKPOINTS) {
          block.cache_control = this.cacheControl();
          systemCacheBreakpoints++;
        }
        systemBlocks.push(block);
      } else if (msg.role === 'tool') {
        // Translate OpenAI tool response → Anthropic tool_result block
        const toolResultBlock = {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: msg.content
        };
        // Anthropic requires consecutive tool_results to be grouped into a single 'user' message
        const lastMsg = anthropicMessages[anthropicMessages.length - 1];
        if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content) && lastMsg.content[0]?.type === 'tool_result') {
          lastMsg.content.push(toolResultBlock);
        } else {
          anthropicMessages.push({ role: 'user', content: [toolResultBlock] });
        }
      } else if (msg.role === 'assistant' && msg.tool_calls) {
        // Translate OpenAI assistant tool_calls → Anthropic tool_use content blocks
        const contentBlocks = [];
        // Thinking blocks must be echoed back UNCHANGED and FIRST when the turn
        // they belong to carries tool_use. Dropping them is what breaks a
        // thinking-enabled tool loop; other models ignore them silently, so
        // replaying them is safe in every direction.
        if (Array.isArray(msg.thinking_blocks)) {
          contentBlocks.push(...msg.thinking_blocks);
        }
        if (msg.content) {
          contentBlocks.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          contentBlocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : (tc.function.arguments || {})
          });
        }
        anthropicMessages.push({ role: 'assistant', content: contentBlocks });
      } else {
        // These are the loop's own bookkeeping. The API rejects unknown message
        // properties, so every one of them has to be stripped here.
        const { cacheAnchor, thinking_blocks, reasoning_content, ...clean } = msg;
        anthropicMessages.push(clean);
      }
    }

    const payload = {
      model: this.model,
      system: systemBlocks,
      messages: anthropicMessages,
      // 4096 truncated long tool-heavy turns mid-thought and forced a retry.
      max_tokens: options.maxTokens || 16000
    };

    if (!this.rejectsSamplingParameters()) {
      payload.temperature = options.temperature || 0.1;
    }

    const thinking = this.buildThinking();
    if (thinking) payload.thinking = thinking;

    const effort = this.resolveEffort();
    // effort lives inside output_config, not at the top level.
    if (effort) payload.output_config = { ...(payload.output_config || {}), effort };

    if (options.tools && options.tools.length > 0) {
      const useToolSearch = this.supportsToolSearch();
      const coreToolCount = Number.isInteger(options.coreToolCount) ? options.coreToolCount : options.tools.length;

      const converted = options.tools.map((t, index) => {
        const toolObj = t.function ? t.function : t;
        const tool = {
          name: toolObj.name,
          description: toolObj.description || '',
          input_schema: toolObj.parameters || toolObj.input_schema || { type: 'object', properties: {} }
        };
        // Beyond the core toolset, let the API hold schemas server-side and
        // surface them only when Claude searches for them.
        if (useToolSearch && index >= coreToolCount) {
          tool.defer_loading = true;
        }
        return tool;
      });

      if (useToolSearch) {
        payload.tools = [
          { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
          ...converted
        ];
      } else {
        payload.tools = converted;
      }

      // Cache breakpoint on the last non-deferred tool. A deferred tool cannot
      // also carry cache_control — the API rejects that combination.
      if (this.enableCaching) {
        const anchorIndex = useToolSearch
          ? Math.min(coreToolCount, payload.tools.length - 1)
          : payload.tools.length - 1;
        const anchor = payload.tools[anchorIndex];
        if (anchor && !anchor.defer_loading && !anchor.type) {
          anchor.cache_control = this.cacheControl();
        }
      }
    }

    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Anthropic API Error (${response.status}): ${errorData}`);
    }

    const data = await response.json();

    // Extract text content and tool calls
    let content = '';
    let toolCalls = [];
    const thinkingBlocks = [];
    let reasoningContent = '';

    for (const block of data.content) {
      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        // Kept verbatim for the echo above. The readable summary, when the user
        // asked for one, is surfaced separately.
        thinkingBlocks.push(block);
        if (typeof block.thinking === 'string') reasoningContent += block.thinking;
      } else if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input)
          }
        });
      }
      // server_tool_use and tool_search_tool_result blocks are handled entirely
      // by the API: the discovered tools are expanded before Claude sees them,
      // and we must never return a tool_result for a srvtoolu_ id.
    }

    return {
      content: content.trim(),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
      reasoningContent: reasoningContent.trim() || undefined,
      usage: {
        // Cache reads are billed at 0.1x and cache writes at 1.25x, so they are
        // reported separately for the token tracker to price correctly.
        promptTokens:
          (data.usage?.input_tokens || 0) +
          (data.usage?.cache_read_input_tokens || 0) +
          (data.usage?.cache_creation_input_tokens || 0),
        completionTokens: data.usage?.output_tokens || 0,
        cachedPromptTokens: data.usage?.cache_read_input_tokens || 0,
        // A 1-hour cache write is billed at 2.0x, a 5-minute one at 1.25x.
        cacheWriteMultiplier: this.cacheTtl === '5m' ? 1.25 : 2.0,
        cacheWriteTokens: data.usage?.cache_creation_input_tokens || 0
      }
    };
  }
}
