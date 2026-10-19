// Sovereign Context Manager
//
// Previously the agent loop computed a sliding window as a per-iteration *view*
// while `this.messages` grew forever: across a long task the array, the
// chat_history.json on disk, and the JSON.stringify cost of every save all grew
// without bound. This module owns the whole context lifecycle instead:
//
//   1. Tool-result decay — old tool outputs collapse into one-line stubs, the
//      client-side equivalent of Anthropic's clear_tool_uses context editing.
//   2. Window construction — character-pool budget, newest first.
//   3. Real compaction — amputated messages are physically replaced by a single
//      summary message, so the array stops growing.
//   4. Sequence sanitising — guarantees valid tool_call / tool_result pairing.

import { buildDecayPointer } from './outputStore.js';

/**
 * Characters per token, for display only.
 *
 * The pools below are already annotated with their token equivalents at this
 * ratio (120000 chars = "~30k tokens"), so anything that shows a token figure
 * derived from a character budget must use the SAME divisor or the two numbers
 * on screen will disagree with each other. Never used for billing — providers
 * report real counts and those are what tokenTracker records.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * How many characters of a tool's result may enter the context, per tool.
 *
 * Every tool shared ONE 32,000-character allowance, which treats a source file
 * and a build log as equally worth reading. They are not: `fs_read` returns
 * what the task asked for, while a failing compile can emit thirty thousand
 * characters of the same warning. The dense tool and the chatty one paid the
 * same, so the chatty one crowded out the window.
 *
 * NOTHING IS LOST BY LOWERING A CAP. `outputStore.spillToolResult()` writes the
 * COMPLETE result to disk first and the notice that replaces it names the path,
 * so a tighter cap moves bytes out of the window and behind a bounded read — it
 * never destroys them. That is what makes these numbers safe to tune.
 *
 * @type {Record<string, number>}
 */
export const RESULT_CAPS = {
  // Content the task actually asked for. Unchanged.
  fs_read: 32000,
  code_search_ast: 32000,
  MultiEdit: 32000,

  // Command output. Low information density, high volume, and the conclusion is
  // almost always in the first and last few lines.
  sysRun: 12000,
  sysRunBg: 12000,
  terminal_persistent_shell: 12000,

  // Fetched pages are mostly navigation, boilerplate and scripts.
  web_fetch: 12000,
  web_search: 12000,

  // A listing this long is a signal to narrow the query, not to read further.
  fs_list: 8000,
  fs_find: 8000,
  fs_search: 12000
};

/** The allowance for a tool with no entry of its own. */
export const DEFAULT_RESULT_CAP = 32000;

/**
 * @param   {string} tool
 * @returns {number} characters of this tool's result allowed into the window
 */
export function resultCapFor(tool) {
  const cap = RESULT_CAPS[String(tool || '')];
  return Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_RESULT_CAP;
}


export const CHAR_POOLS = {
  super_max: 400000, // ~100k tokens
  max: 240000,       // ~60k tokens
  premium: 180000,   // ~45k tokens — the middle rung now buys a real context
                     // bump over fast, not just the right to run (monetization
                     // Move 3 / Gap #2 in docs/AGENT_MONETIZATION.md).
  default: 120000    // ~30k tokens (fast / starter / free)
};

export function resolveCharPool(tier, override) {
  if (override && Number.isFinite(override) && override > 0) return override;
  if (tier === 'super_max') return CHAR_POOLS.super_max;
  if (tier === 'max') return CHAR_POOLS.max;
  if (tier === 'premium' || tier === 'premium_annual') return CHAR_POOLS.premium;
  return CHAR_POOLS.default;
}

function contentLength(content) {
  if (typeof content === 'string') return content.length;
  if (content == null) return 0;
  return JSON.stringify(content).length;
}

export function measureMessages(messages) {
  let total = 0;
  for (const msg of messages) total += contentLength(msg.content);
  return total;
}

// ---------------------------------------------------------------------------
// Tool-result decay
// ---------------------------------------------------------------------------

const DECAY_MARKER = '[decayed]';

function summariseToolResult(msg) {
  const raw = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  const sizeKb = (raw.length / 1024).toFixed(1);

  // Keep the success/error verdict — that is the part the model still reasons
  // about ten steps later. The payload is what it never re-reads.
  let verdict = '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      verdict = parsed.success === false
        ? ` failed: ${String(parsed.error || '').slice(0, 160)}`
        : ' succeeded';
    }
  } catch (e) {
    verdict = '';
  }

  // When the agent loop spilled this result to disk, send the model to the file
  // instead of telling it to re-run. A re-run costs a full tool execution and
  // puts another full-size payload back in the window; a targeted read of the
  // spill costs a few hundred tokens. See src/outputStore.js.
  const pointer = buildDecayPointer({ path: msg.spillPath });
  const fallback = ' Re-run the tool or read the specific file/lines again if you still need it.';

  return `${DECAY_MARKER} ${msg.name || 'tool'}${verdict}. Output (${sizeKb} KB) was cleared to protect the context window.${pointer || fallback}`;
}


export function decayToolResults(messages, options = {}) {
  const keepRecent = Number.isInteger(options.keepRecent) ? options.keepRecent : 8;
  const minChars = Number.isInteger(options.minChars) ? options.minChars : 600;
  const keepMediaRecent = Number.isInteger(options.keepMediaRecent) ? options.keepMediaRecent : 2;

  let reclaimed = 0;
  let toolsSeen = 0;
  let mediaSeen = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    if (msg.role === 'tool') {
      toolsSeen++;
      if (toolsSeen <= keepRecent) continue;
      const original = contentLength(msg.content);
      if (original < minChars) continue;
      if (typeof msg.content === 'string' && msg.content.startsWith(DECAY_MARKER)) continue;

      msg.content = summariseToolResult(msg);
      reclaimed += original - msg.content.length;
      continue;
    }

    
    if (Array.isArray(msg.content)) {
      const hasMedia = msg.content.some(
        block => block && (block.type === 'image' || block.type === 'image_url' || block.type === 'input_audio')
      );
      if (!hasMedia) continue;

      mediaSeen++;
      if (mediaSeen <= keepMediaRecent) continue;

      const original = contentLength(msg.content);
      const captions = msg.content
        .filter(block => block && block.type === 'text' && block.text)
        .map(block => block.text)
        .join(' ');

      msg.content = `${DECAY_MARKER} media attachment cleared to protect the context window. ${captions}`.trim();
      reclaimed += original - msg.content.length;
    }
  }

  return reclaimed;
}

// ---------------------------------------------------------------------------
// Window construction
// ---------------------------------------------------------------------------

/**
 * Walk backward from the newest message accumulating until the character pool
 * is exhausted.
 *
 * @returns {{ window: Array, splitIndex: number }} splitIndex is the index of
 *          the newest message that did NOT fit, or -1 when everything fit.
 */
export function buildWindow(messages, maxCharPool) {
  const window = [];
  let characterCount = 0;
  let splitIndex = -1;

  for (let i = messages.length - 1; i >= 0; i--) {
    const length = contentLength(messages[i].content);
    if (characterCount + length > maxCharPool) {
      splitIndex = i;
      break;
    }
    characterCount += length;
    window.unshift(messages[i]);
  }

  // NEVER RETURN AN EMPTY WINDOW.
  //
  // The loop above breaks on the FIRST message that does not fit, so a single
  // message larger than the whole pool produced a window of length zero. The
  // agent loop then skipped its root anchor (it is guarded on
  // `slidingWindow.length > 0`) and sent the provider nothing but system
  // blocks — which is the 400 "`messages` must contain at least one message
  // with role `user` or `tool`" that killed a 340,000-token Blender run at
  // step 13. A long traceback in a big conversation is all it takes.
  //
  // Keeping the last message truncated is strictly better than sending none:
  // the model loses detail, where before it lost the entire turn.
  if (window.length === 0 && messages.length > 0) {
    const last = messages[messages.length - 1];
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content ?? '');
    window.push({
      ...last,
      content: text.length > maxCharPool
        ? text.slice(0, Math.max(0, maxCharPool - 80)) + '\n[truncated: this single message exceeded the whole context budget]'
        : text
    });
    splitIndex = messages.length - 1;
  }

  // A window that opens on tool results is broken: the assistant message that
  // called them was amputated.
  while (window.length > 1 && window[0].role === 'tool') {
    window.shift();
  }

  const last = window[window.length - 1];
  if (last && last.role === 'assistant' && last.tool_calls && last.tool_calls.length > 0) {
    delete last.tool_calls;
  }

  return { window, splitIndex };
}

/**
 * Physically replace the amputated range with a single summary message so the
 * live array stops growing. Index 0 (the root anchor / original user intent) is
 * never compacted away.
 *
 * @returns {number} number of messages removed
 */
export function compactInPlace(messages, splitIndex, summaryText) {
  const start = 1;
  const end = splitIndex;
  if (end < start) return 0;

  const removed = end - start + 1;
  const summary = {
    role: 'user',
    content: `[COMPACTED CONTEXT SUMMARY — ${removed} earlier messages were condensed to protect the context window]\n${summaryText}`
  };

  messages.splice(start, removed, summary);
  return removed - 1;
}

/** Cheap deterministic summary used when no LLM condenser is configured. */
export function describeDroppedMessages(dropped) {
  const toolCalls = new Map();
  let userTurns = 0;

  for (const msg of dropped) {
    if (msg.role === 'tool' && msg.name) {
      toolCalls.set(msg.name, (toolCalls.get(msg.name) || 0) + 1);
    } else if (msg.role === 'user') {
      userTurns++;
    }
  }

  const tools = [...toolCalls.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, count]) => `${name}x${count}`)
    .join(', ');

  const parts = [];
  if (userTurns > 0) parts.push(`${userTurns} earlier user turn(s)`);
  if (tools) parts.push(`tools used: ${tools}`);
  return parts.length > 0
    ? parts.join('. ') + '. Re-read files or re-run tools if you need those details again.'
    : 'Earlier exchange omitted.';
}

// ---------------------------------------------------------------------------
// Sequence sanitising
// ---------------------------------------------------------------------------

/**
 * Guarantee 100% valid tool-call sequences: every assistant message carrying
 * tool_calls must be immediately followed by matching tool results, and no
 * orphan tool message may survive.
 */
export function sanitizeSequences(messages) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const foundToolIds = new Set();
      let followingResults = 0;
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        if (messages[j].tool_call_id) foundToolIds.add(messages[j].tool_call_id);
        followingResults++;
        j++;
      }

      // Id matching is the correct pairing, but a provider that returns tool
      // calls without ids would match nothing and have its entire turn erased.
      // When no result carries an id and the counts line up, the results can
      // only be for these calls — pair them positionally instead of discarding
      // a turn the model genuinely took.
      const canPairPositionally =
        foundToolIds.size === 0 && followingResults === msg.tool_calls.length;

      if (!canPairPositionally) {
        msg.tool_calls = msg.tool_calls.filter(tc => foundToolIds.has(tc.id));
      }

      if (msg.tool_calls.length === 0) {
        delete msg.tool_calls;
        if (!msg.content || typeof msg.content !== 'string' || msg.content.trim() === '') {
          msg.content = '[Action initiated and completed]';
        }
      }
    }
  }

  let validToolBlock = false;
  const clean = [];
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      validToolBlock = true;
      clean.push(msg);
    } else if (msg.role === 'tool') {
      if (validToolBlock) clean.push(msg);
      // otherwise drop the orphan rather than let the provider 400
    } else {
      validToolBlock = false;
      clean.push(msg);
    }
  }

  return clean;
}

// ---------------------------------------------------------------------------
// 5-Stage Progressive Compaction (Claude Code Architecture / Research Section E)
// ---------------------------------------------------------------------------

/** Stage 1: Budget Reduction triggered when raw context exceeds 70% capacity */
export const STAGE1_BUDGET_THRESHOLD = 0.70;

/** Stage 2: Snip triggered when any single tool response exceeds 15,000 tokens ≈ 60,000 chars */
export const STAGE2_SNIP_CHARS = 60000;
export const STAGE2_SNIP_HEAD = 20000;
export const STAGE2_SNIP_TAIL = 10000;

/** Stage 4: Context Collapse triggered when active context exceeds 85% capacity */
export const STAGE4_COLLAPSE_THRESHOLD = 0.85;

/**
 * Stage 2: Snip oversized tool responses.
 *
 * Walks conversation history and truncates any single tool output exceeding
 * 15,000 tokens (60,000 chars) down to head + tail with an informative marker.
 * This prevents massive build logs, package listings, or grep dumps from
 * crowding out the active context window.
 *
 * @param   {Array} messages
 * @param   {Object} [options]
 * @returns {{ snippedCount: number, reclaimedChars: number }}
 */
export function snipOversizedToolOutputs(messages, options = {}) {
  const threshold = options.threshold || STAGE2_SNIP_CHARS;
  const headChars = options.headChars || STAGE2_SNIP_HEAD;
  const tailChars = options.tailChars || STAGE2_SNIP_TAIL;

  let snippedCount = 0;
  let reclaimedChars = 0;

  for (const msg of messages) {
    if (msg.role !== 'tool' && !msg.tool_call_id) continue;
    if (typeof msg.content !== 'string') continue;

    const len = msg.content.length;
    if (len > threshold) {
      const removed = len - (headChars + tailChars);
      const head = msg.content.slice(0, headChars);
      const tail = msg.content.slice(-tailChars);
      const pointer = msg.spillPath ? ` Full output preserved at: ${msg.spillPath}.` : '';

      msg.content = `${head}\n\n[... ✂️ SNIPPED ${removed.toLocaleString()} CHARS (${Math.round(removed / CHARS_PER_TOKEN).toLocaleString()} TOKENS) TO PREVENT CONTEXT OVERFLOW.${pointer} Use targeted file reads to inspect specific sections ...] \n\n${tail}`;

      snippedCount++;
      reclaimedChars += (len - msg.content.length);
    }
  }

  return { snippedCount, reclaimedChars };
}

/**
 * Stage 3: Microcompact text.
 * Strips redundant whitespace and collapses multiple blank lines to keep prompts
 * tight without altering semantic content.
 *
 * @param   {string} text
 * @returns {string}
 */
export function microcompactText(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
}

/**
 * Progressive Compaction Pipeline (Stages 1 through 4).
 * Evaluated before model calls to guarantee memory stability.
 *
 * @param   {Array} messages
 * @param   {number} maxCharPool
 * @param   {Object} [options]
 * @returns {{
 *   totalReclaimed: number,
 *   stagesFired: string[],
 *   finalChars: number,
 *   finalRatio: number
 * }}
 */
export function applyProgressiveCompaction(messages, maxCharPool, options = {}) {
  let totalReclaimed = 0;
  const stagesFired = [];

  // Stage 2: Snip oversized tool outputs (>15K tokens / 60K chars)
  const snipRes = snipOversizedToolOutputs(messages, options.snipOptions);
  if (snipRes.snippedCount > 0) {
    totalReclaimed += snipRes.reclaimedChars;
    stagesFired.push(`snip:${snipRes.snippedCount}_tools`);
  }

  let currentChars = measureMessages(messages);
  const ratio = maxCharPool > 0 ? currentChars / maxCharPool : 0;

  // Stage 1: Budget Reduction (>70% of character pool)
  if (ratio >= STAGE1_BUDGET_THRESHOLD) {
    stagesFired.push(`budget_reduction:${(ratio * 100).toFixed(0)}%`);
    for (const msg of messages) {
      if (msg.role === 'tool' && typeof msg.content === 'string') {
        const origLen = msg.content.length;
        msg.content = microcompactText(msg.content);
        totalReclaimed += (origLen - msg.content.length);
      }
    }
    const decayReclaimed = decayToolResults(messages, {
      keepRecent: options.budgetKeepRecent ?? 4,
      minChars: 300
    });
    totalReclaimed += decayReclaimed;
  }

  // Stage 4: Context Collapse (>85% of character pool)
  currentChars = measureMessages(messages);
  const updatedRatio = maxCharPool > 0 ? currentChars / maxCharPool : 0;
  if (updatedRatio >= STAGE4_COLLAPSE_THRESHOLD) {
    stagesFired.push(`context_collapse:${(updatedRatio * 100).toFixed(0)}%`);
    const collapseReclaimed = decayToolResults(messages, {
      keepRecent: options.collapseKeepRecent ?? 2,
      minChars: 200,
      keepMediaRecent: 0
    });
    totalReclaimed += collapseReclaimed;
  }

  return {
    totalReclaimed,
    stagesFired,
    finalChars: measureMessages(messages),
    finalRatio: maxCharPool > 0 ? measureMessages(messages) / maxCharPool : 0
  };
}
