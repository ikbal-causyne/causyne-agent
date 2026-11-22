// Chat transcript renderer.
//
// This replaces a 50-line if/else chain inside LocalCLIConnection.send() that
// wrote raw escape codes inline. Every frame the agent loop emits now has a
// method here, and every byte that reaches the terminal goes through the theme
// (so it degrades) and through text.safeDisplay (so untrusted tool output
// cannot move the cursor or repaint the screen).
//
// Pure TypeScript over ./theme.js and ./text.js. No dependency, no shell.

import readline from 'readline';
import { compactSuccessfulToolResult } from './toolActivityPolicy.js';
import {
  paint, bold, dim, badge, GLYPHS, terminalWidth, HAS_COLOR, fileLink,
  safeLink, HAS_HYPERLINKS
} from './theme.js';
import {
  visibleWidth, truncate, wrap, wrapBlock, padEnd, safeDisplay, shortenHome
} from './text.js';
import { sessionBanner } from './banner.js';
import { describeTool } from './toolDisplay.js';
import { approvalDiff, type ApprovalDiffResult } from './diff.js';
import { StatusLine } from './statusLine.js';
import { barBlock } from './block.js';
import { composerWidth, openingRows, sessionRows } from './layout.js';
import { sessionComposerWidth } from './sessionSidebar.js';
import { chatProseWidth, wrappedChatRows } from './textLayout.js';
import { activityRows } from './activityLayout.js';
import { cleanToolOutputPreview, normalizeHistoricalToolResult, normalizeHistoricalExternalAction } from './toolOutputNormalizer.js';
import { formatMarkdownMath } from './markdownMath.js';
import { renderThinkingFrame } from './thinkingBox.js';
import { measureMessages, resolveCharPool } from '../contextManager.js';

export interface ChatFrame {
  kind: string;
  meta?: Record<string, any> | null;
}

export interface ChatTranscript {
  frames: ChatFrame[];
  surface?: any;
  append(options: Record<string, any>): unknown;
  replaceTail(options: Record<string, any>): unknown;
  clear?(): void;
  batch?(action: () => void): void;
}

export interface ChatRendererOptions {
  out?: any;
  width?: (() => number) | null;
  quietStatus?: boolean;
  onStatusChange?: ((status: string) => void) | null;
  transcript?: ChatTranscript | null;
  [key: string]: unknown;
}

// Bound the preview AFTER wrapping, not by source newlines: one 400 KB line of
// minified output would otherwise become thousands of rows and lock the
// terminal. (The failure openclaw's tool-execution component documents.)
const PREVIEW_LINES = 12;

// Cut the SOURCE before sanitising it, not after.
const PREVIEW_SOURCE_BUDGET = PREVIEW_LINES * 256;

// Column where the timing/status gutter starts, so tool rows line up.
const STATUS_GUTTER = 10;

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

function clampMarkdownIndent(raw: unknown, markerCols: number, targetWidth: number): string {
  const maxLead = Math.max(0, Math.min(Math.floor(targetWidth / 3), targetWidth - markerCols - 8));
  const rawCols = visibleWidth(String(raw || '').replace(/\t/g, '  '));
  return ' '.repeat(Math.min(rawCols, maxLead));
}

function renderMarkdown(text: unknown, width: number): string[] {
  const safeWidth = Number.isFinite(width) && width > 0 ? Math.max(12, Math.floor(width)) : 80;
  const lines: string[] = [];
  let inFence = false;

  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.replace(/\s+$/, '');

    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      const language = line.replace(/^\s*```/, '').trim();
      const maxLabel = Math.max(0, safeWidth - 8);
      const safeLang = language.length > maxLabel ? language.slice(0, maxLabel) : language;
      const trail = Math.max(0, safeWidth - 3 - (safeLang ? safeLang.length + 2 : 1));
      lines.push(dim(`${GLYPHS.hLine.repeat(3)}${safeLang ? ' ' + safeLang + ' ' : ' '}${GLYPHS.hLine.repeat(trail)}`));
      continue;
    }
    if (inFence) {
      for (const codeRow of wrapBlock('  ' + line, Math.max(8, safeWidth), { hang: 0 })) {
        lines.push(paint('accent', codeRow));
      }
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading && heading[2] !== undefined) {
      lines.push('');
      for (const headingRow of wrap(heading[2], Math.max(8, safeWidth))) {
        lines.push(bold(paint('ink', headingRow)));
      }
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      lines.push(dim(GLYPHS.hLine.repeat(Math.max(4, Math.min(safeWidth, 40)))));
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet && bullet[2] !== undefined) {
      const indent = clampMarkdownIndent(bullet[1], 4, safeWidth) + '  ';
      const wrapped = wrap(inline(bullet[2]), Math.max(8, safeWidth - indent.length - 2));
      wrapped.forEach((part, index) => {
        lines.push(index === 0 ? `${indent}${paint('muted', GLYPHS.bullet)} ${part}` : `${indent}  ${part}`);
      });
      continue;
    }

    const numbered = line.match(/^(\s*)(\d+\.)\s+(.*)$/);
    if (numbered && numbered[2] !== undefined && numbered[3] !== undefined) {
      const markerCols = visibleWidth(numbered[2]) + 1;
      const lead = clampMarkdownIndent(numbered[1], markerCols, safeWidth);
      const prefix = `${lead}${bold(numbered[2])} `;
      const indentCols = visibleWidth(lead) + markerCols;
      const indent = ' '.repeat(indentCols);
      const wrapped = wrap(inline(numbered[3]), Math.max(8, safeWidth - indentCols));
      wrapped.forEach((part, index) => {
        lines.push(index === 0 ? `${prefix}${part}` : `${indent}${part}`);
      });
      continue;
    }

    const quote = line.match(/^(\s*)>\s?(.*)$/);
    if (quote && quote[2] !== undefined) {
      const lead = clampMarkdownIndent(quote[1], 2, safeWidth);
      const indent = lead + paint('muted', '│ ');
      const wrapped = wrap(inline(quote[2]), Math.max(8, safeWidth - visibleWidth(lead) - 2));
      wrapped.forEach((part) => {
        lines.push(`${indent}${part}`);
      });
      continue;
    }

    if (/^\s*\|?(\s*:?-+:?\s*\|)+\s*$/.test(line)) {
      lines.push(dim('  ' + GLYPHS.hLine.repeat(Math.max(4, Math.min(safeWidth - 4, 48)))));
      continue;
    }

    const tableRow = line.match(/^\s*\|(.+)\|\s*$/);
    if (tableRow && tableRow[1] !== undefined) {
      const cells = tableRow[1].split('|').map(c => c.trim());
      for (const tableLine of wrapBlock('  ' + cells.join(' │ '), Math.max(8, safeWidth), { hang: 0 })) {
        lines.push(inline(tableLine));
      }
      continue;
    }

    const trimmed = line.trim();
    if (trimmed === '') { lines.push(''); continue; }
    if (trimmed === '[' || trimmed === ']') continue;
    for (const part of wrap(inline(line), safeWidth)) lines.push(part);
  }

  if (inFence) {
    lines.push(dim(`${GLYPHS.hLine.repeat(3)} unclosed code block ${GLYPHS.hLine.repeat(Math.max(0, safeWidth - 24))}`));
  }
  return lines;
}

// A bare URL, allowing one level of balanced parentheses so a link to
// `.../URL_(disambiguation)` is not cut at the first `)`.
const BARE_URL = /https?:\/\/[^\s<>()\[\]"'`]{1,1024}(?:\([^\s<>()\[\]"'`]{0,128}\)[^\s<>()\[\]"'`]{0,256}){0,4}/g;
const MD_LINK = /\[([^\]\n]{1,80})\]\(((?:https?|file):\/\/[^\s()]{1,1024}(?:\([^\s()]{0,128}\)[^\s()]{0,256}){0,4})\)/g;

const MAX_LINK_LABEL = 48;
const MAX_INLINE_FORMAT_CHARS = 16384;
const MAX_EXPAND_LINES = 2000;

/** Trailing sentence punctuation belongs to the sentence, not to the URL. */
function trimUrlPunctuation(url: string): string {
  let depth = 0;
  for (let index = 0; index < url.length; index++) {
    const character = url[index];
    if (character === '(') depth++;
    else if (character === ')') {
      if (depth === 0) return trimUrlPunctuation(url.slice(0, index));
      depth--;
    }
  }
  return url.replace(/[?!.,:;*_~]+$/u, '');
}

/** `https://docs.example.com/a/very/long/path?x=1` → `docs.example.com/a/…`. */
function compactUrlLabel(url: string): string {
  let label = url.replace(/^(?:https?|file):\/\//, '').replace(/\/$/, '');
  if (label.length > MAX_LINK_LABEL) label = label.slice(0, MAX_LINK_LABEL - 1) + GLYPHS.ellipsis;
  return label;
}

function inline(text: unknown): string {
  const stashed: string[] = [];
  const stash = (rendered: string): string => `\u0000${stashed.push(rendered) - 1}\u0000`;

  let out = String(text);
  if (out.length > MAX_INLINE_FORMAT_CHARS) return out;

  if (HAS_HYPERLINKS) {
    out = out.replace(MD_LINK, (whole: string, label: string, url: string) => {
      const target = trimUrlPunctuation(url);
      const shown = label.length > MAX_LINK_LABEL
        ? label.slice(0, MAX_LINK_LABEL - 1) + GLYPHS.ellipsis
        : label;
      const rendered = safeLink(paint('accent', shown), target);
      return rendered === paint('accent', shown) ? whole : stash(rendered);
    });
    out = out.replace(BARE_URL, (whole: string) => {
      const target = trimUrlPunctuation(whole);
      const tail = whole.slice(target.length);
      const rendered = safeLink(paint('accent', compactUrlLabel(target)), target);
      return rendered.includes('\x1b]8') ? stash(rendered) + tail : whole;
    });
  } else {
    out = out.replace(MD_LINK, (_whole: string, label: string, url: string) => {
      if (url.startsWith('file:')) return label;
      return `${label} (${url})`;
    });
  }

  out = out.replace(/`([^`]+)`/g, (_m: string, code: string) => stash(HAS_COLOR ? paint('accent', code) : code));
  out = formatMarkdownMath(out);
  out = HAS_COLOR
    ? out.replace(/\*\*\*([^*]+)\*\*\*/g, (_m: string, strong: string) => bold(paint('accent', strong)))
    : out.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  out = HAS_COLOR
    ? out.replace(/\*\*([^*]+)\*\*/g, (_m: string, strong: string) => bold(strong))
    : out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = HAS_COLOR
    ? out.replace(/(?<=^|[\s(])\*([^*\s](?:[^*]*[^*\s])?)\*(?=[\s).,!?]|$)/g, (_m: string, italic: string) => `\x1b[3m${italic}\x1b[23m`)
    : out.replace(/(?<=^|[\s(])\*([^*\s](?:[^*]*[^*\s])?)\*(?=[\s).,!?]|$)/g, '$1');
  out = HAS_COLOR
    ? out.replace(/(?<=^|[\s(])_([^\s_](?:[^_]*[^\s_])?)_(?=[\s).,!?]|$)/g, (_m: string, italic: string) => `\x1b[3m${italic}\x1b[23m`)
    : out.replace(/(?<=^|[\s(])_([^\s_](?:[^_]*[^\s_])?)_(?=[\s).,!?]|$)/g, '$1');
  out = out.replace(/~~([^~]+)~~/g, HAS_COLOR ? '\x1b[9m$1\x1b[29m' : '$1');

  if (stashed.length > 0) {
    out = out.replace(/\u0000(\d+)\u0000/g, (_m: string, index: string) => stashed[Number(index)] || '');
  }
  return out;
}

export class ChatRenderer {
  out: any;
  isTTY: boolean;
  stepCount: number;
  stepStartedAt: number | null;
  spinnerTimer: ReturnType<typeof setInterval> | null;
  spinnerIndex: number;
  currentStatus: string;
  pendingApprovals: Map<string, any>;
  latestPlan: any[];
  status: StatusLine;
  turnStartedAt: number | null;
  widthOf: (() => number) | null;
  quietStatus: boolean;
  onStatusChange: ((status: string) => void) | null;
  transcript: ChatTranscript | null;
  rowSink: string[] | null;
  forcedWidth: number;
  onBeforeWrite?: (() => void) | undefined;
  onAfterWrite?: (() => void) | undefined;
  onPlanChange?: ((plan: any[]) => string | void) | undefined;
  dialogWillAsk?: boolean;
  _activeAssistant?: boolean;
  _activeReasoning?: boolean;
  lastOutput?: { text: string; spillPath: string | null } | null;

  constructor(options: ChatRendererOptions = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    this.out = opts.out || process.stdout;
    this.isTTY = Boolean(this.out.isTTY);
    this.stepCount = 0;
    this.stepStartedAt = null;
    this.spinnerTimer = null;
    this.spinnerIndex = 0;
    this.currentStatus = '';
    this.pendingApprovals = new Map();
    this.latestPlan = [];
    this.status = new StatusLine();
    this.turnStartedAt = null;

    this.widthOf = typeof opts.width === 'function' ? opts.width : null;
    this.quietStatus = Boolean(opts.quietStatus);
    this.onStatusChange = opts.onStatusChange || null;

    this.transcript = opts.transcript || null;
    this.rowSink = null;
    this.forcedWidth = 0;
  }

  write(line = ''): void {
    if (this.rowSink) { this.rowSink.push(line); return; }

    if (this.transcript) {
      const text = String(line);
      this.transcript.append({ kind: 'notice', produce: () => text.split('\n') });
      return;
    }

    if (this.onBeforeWrite) this.onBeforeWrite();
    this.out.write(line + '\n');
    if (this.onAfterWrite) this.onAfterWrite();
  }

  frame(kind: string, produce: () => void, meta: Record<string, any> | null = null): void {
    if (kind !== 'assistant') this._activeAssistant = false;
    if (kind !== 'reasoning') this._activeReasoning = false;
    if (!this.transcript) { produce(); return; }
    this.transcript.append({
      kind,
      meta,
      produce: (width: number) => this.capture(width, produce)
    });
  }

  updateTailFrame(kind: string, produce: () => void, meta: Record<string, any> | null = null): void {
    if (!this.transcript) { produce(); return; }
    this.transcript.replaceTail({
      kind,
      meta,
      produce: (width: number) => this.capture(width, produce)
    });
  }

  capture(width: number, produce: () => void): string[] {
    const sink: string[] = [];
    const previousSink = this.rowSink;
    const previousWidth = this.forcedWidth;
    this.rowSink = sink;
    this.forcedWidth = width;
    try {
      produce();
    } finally {
      this.rowSink = previousSink;
      this.forcedWidth = previousWidth;
    }
    const maxAvailable = this.transcript?.surface?.composeAvailableWidth
      ? this.transcript.surface.composeAvailableWidth()
      : width;
    const availableWidth = Math.min(width, maxAvailable);
    return sessionRows(sink, availableWidth).rows;
  }

  width(): number {
    if (this.forcedWidth) return Math.max(40, this.forcedWidth);
    if (this.widthOf) return this.widthOf();
    const columns = this.out && this.out.columns;
    return Number.isFinite(columns) && columns > 0 ? Math.max(40, columns) : terminalWidth();
  }

  measure(): number {
    return this.transcript ? sessionComposerWidth(this.width()) : chatProseWidth(this.width());
  }

  sessionHeader(info: Record<string, any> = {}): number {
    this.status.setSession(info);

    this.frame('session', () => this.renderSessionHeader(info));
    return composerWidth(this.width());
  }

  renderSessionHeader(info: Record<string, any> = {}): void {
    const width = this.width();
    const rows = ['', ...sessionBanner(info, width, { height: this.out?.rows }), ''];

    const hints = [
      `${info.commandCount || 0} commands`, '/help', 'enter send',
      'alt+enter newline', 'ctrl+p palette', 'esc interrupt', 'exit to leave'
    ];
    const separator = `  ${GLYPHS.dot}  `;
    const kept = hints.slice();
    while (kept.length > 1 && visibleWidth(kept.join(separator)) > width - 1) kept.pop();
    rows.push(dim(kept.join(separator)), '');
    for (const row of openingRows(rows, width, Number(this.out?.rows))) this.write(row);
  }

  turnFooter(durationMs = 0): void {
    const model = this.status.model;
    const steps = this.stepCount;

    this.frame('turn', () => {
      const parts: string[] = [];
      if (model) parts.push(paint('ink', safeDisplay(model)));
      parts.push(`${steps} step${steps === 1 ? '' : 's'}`);
      if (durationMs > 0) parts.push(formatDuration(durationMs));

      const separator = dim(`  ${GLYPHS.dot}  `);
      this.write();
      this.write(`${paint('accent', GLYPHS.step)} ${dim(parts.join(separator))}`);
      this.write(dim(`  /usage for cost  ${GLYPHS.dot}  /undo to roll back`));
      this.write();
    }, { steps, durationMs });
  }

  resetTurn(): void {
    this.stepCount = 0;
    this.stepStartedAt = null;
    this.turnStartedAt = Date.now();
    this._activeAssistant = false;
    this._activeReasoning = false;
    this.status.reset();
  }

  startSpinner(message: unknown): void {
    this.stopSpinner();
    this.currentStatus = safeDisplay(String(message ?? ''));

    if (this.quietStatus) {
      if (this.onStatusChange) this.onStatusChange(this.currentStatus);
      return;
    }

    if (!this.isTTY) {
      this.write(paint('muted', this.status.renderStatic(this.currentStatus, this.width())));
      return;
    }

    const since = this.turnStartedAt || Date.now();

    this.spinnerTimer = setInterval(() => {
      try {
        readline.cursorTo(this.out, 0);
        const frame = GLYPHS.spinner[this.spinnerIndex % GLYPHS.spinner.length] ?? '*';
        if (this.out && typeof this.out.write === 'function') {
          this.out.write(this.status.render({
            message: this.currentStatus,
            elapsedMs: Date.now() - since,
            steps: this.stepCount,
            width: this.width() - 1,
            spinnerFrame: frame,
            tick: this.spinnerIndex
          }));
        }
        readline.clearLine(this.out, 1);
        this.spinnerIndex++;
      } catch {
        this.stopSpinner();
      }
    }, 125);
    this.spinnerTimer.unref?.();
  }

  stopSpinner(): void {
    if (this.quietStatus) {
      this.currentStatus = '';
      if (this.onStatusChange) this.onStatusChange('');
      return;
    }
    if (!this.spinnerTimer) return;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
    if (this.isTTY) {
      readline.clearLine(this.out, 0);
      readline.cursorTo(this.out, 0);
    }
  }

  renderUserMessage(content: unknown): void {
    const text = typeof content === 'string'
      ? content
      : (Array.isArray(content)
          ? content.map(p => (typeof p === 'string' ? p : (p && (p as { text?: string }).text) || '')).filter(Boolean).join('\n')
          : String(content || ''));
    if (!text.trim()) return;

    this.frame('user', () => {
      const measured = this.width();
      const maxCaptureWidth = Math.max(8, Math.min(
        measured,
        this.transcript?.surface?.composeAvailableWidth?.() ?? measured
      ) - 4);
      const preferred = this.transcript
        ? (this.transcript.surface?.composeWidth?.() ?? sessionComposerWidth(measured))
        : composerWidth(this.measure());
      const blockWidth = this.transcript
        ? Math.max(8, Math.min(preferred, maxCaptureWidth))
        : Math.max(8, preferred);
      const innerWidth = Math.max(8, blockWidth - visibleWidth(GLYPHS.barHeavy || GLYPHS.bar) - 1);
      const rows = barBlock(
        wrapBlock(safeDisplay(text), innerWidth, { hang: 0 }),
        { width: blockWidth, role: 'user', filled: true, surface: 'surfaceHi' }
      );
      this.write();
      for (const row of rows) {
        this.write(row);
      }
      this.write();
    }, { messageText: text });
  }

  renderAssistantMessage(content: unknown): void {
    const text = typeof content === 'string'
      ? content
      : (Array.isArray(content)
          ? content.map(p => (typeof p === 'string' ? p : (p && (p as { text?: string }).text) || '')).filter(Boolean).join('\n')
          : String(content || ''));
    if (!text.trim()) return;

    this.onAgentMessage({ content: text });
  }

  renderSessionDivider(info: Record<string, any> = {}): void {
    this.transcript?.surface?.setSessionInfo?.(info);
    this.frame('session', () => {
      const width = Math.max(12, this.measure());
      const rawTitle = safeDisplay((info && info.title) || 'Session');
      const count = (info && info.messagesCount) ?? 0;
      const rawCount = count > 0 ? ` (${count} message${count === 1 ? '' : 's'})` : '';
      const countText = visibleWidth(rawCount) <= Math.max(0, width - 10) ? rawCount : '';
      const title = truncate(rawTitle, Math.max(4, width - visibleWidth(countText) - 6), GLYPHS.ellipsis);
      const badgeText = `${title}${countText}`;
      const remaining = Math.max(2, width - visibleWidth(badgeText) - 2);
      const leftRule = Math.max(1, Math.floor(remaining / 2));
      const rightRule = Math.max(1, remaining - leftRule);
      this.write();
      this.write(`${paint('rule', GLYPHS.hLine.repeat(leftRule))} ${bold(paint('accent', title))}${dim(countText)} ${paint('rule', GLYPHS.hLine.repeat(rightRule))}`);
      this.write();
    });
  }

  clearTranscript(): void {
    this._activeAssistant = false;
    this._activeReasoning = false;
    this.lastOutput = null;
    if (this.transcript && typeof this.transcript.clear === 'function') {
      this.transcript.clear();
    }
  }

  renderSessionHistory(messages: any[] = [], sessionInfo: Record<string, any> | null = null): void {
    const safeMessages = Array.isArray(messages) ? messages : [];
    const renderContent = (): void => {
      this.transcript?.surface?.leaveHome?.(true);
      this.clearTranscript();
      this.latestPlan = [];
      this.onPlanChange?.([]);
      this.resetTurn();

      const info: Record<string, any> = sessionInfo ? { ...sessionInfo } : {};
      if (info.messagesCount === undefined || info.messagesCount === null) {
        info.messagesCount = safeMessages.filter(m => m && m.role !== 'system').length;
      }
      const measuredChars = measureMessages(safeMessages);
      this.status.contextChars = measuredChars;
      info.contextChars = measuredChars;

      if (info.title || info.id) {
        this.renderSessionDivider(info);
      }

      const toolResultsById = new Map<string, any>();
      for (const m of safeMessages) {
        if (m && m.role === 'tool' && m.tool_call_id) {
          toolResultsById.set(m.tool_call_id, m);
        }
      }

      const renderedToolMessages = new Set<any>();

      for (let i = 0; i < safeMessages.length; i++) {
        const msg = safeMessages[i];
        if (!msg) continue;
        const role = String(msg.role || '').toLowerCase();

        if (role === 'user') {
          this.resetTurn();
          this.renderUserMessage(msg.content);
        } else if (role === 'assistant') {
          const reasoning = typeof msg.reasoning_content === 'string'
            ? msg.reasoning_content.trim()
            : (Array.isArray(msg.thinking_blocks)
                ? msg.thinking_blocks.map((b: any) => (typeof b === 'string' ? b : b?.thinking || b?.text || '')).filter(Boolean).join('\n').trim()
                : '');
          if (reasoning) {
            const meta = {
              reasoning: true,
              done: true,
              streaming: false,
              collapsed: true,
              durationText: '',
              content: reasoning,
              scrollStart: 0
            };
            this.frame('reasoning', () => this.renderReasoning(meta.content, {
              streaming: false,
              durationText: '',
              collapsed: Boolean(meta.collapsed),
              startLine: 0
            }), meta);
          }

          if (Array.isArray(msg.external_actions) && msg.external_actions.length > 0) {
            for (const ext of msg.external_actions) {
              const { toolName, args, result } = normalizeHistoricalExternalAction(ext);
              this.onStepStart({ tool: toolName, args });
              this.onStepComplete({ tool: toolName, result, elapsed: '' });
            }
          }

          if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
            for (const call of msg.tool_calls) {
              if (!call || typeof call !== 'object') continue;
              const toolName = call.function?.name || call.name || 'tool';
              let args: Record<string, any> = {};
              try {
                args = typeof call.function?.arguments === 'string'
                  ? JSON.parse(call.function.arguments)
                  : (call.function?.arguments || {});
              } catch {
                args = {};
              }

              if (toolName === 'update_plan' && args && Array.isArray(args.plan)) {
                this.onAgentPlan({
                  plan: args.plan.filter(Boolean).map((item: any) => ({
                    ...item,
                    text: item.text || item.step || item.content || ''
                  }))
                });
              }

              const toolMsg = call.id ? toolResultsById.get(call.id) : null;
              if (toolMsg) {
                renderedToolMessages.add(toolMsg);
                const normalized = normalizeHistoricalToolResult(toolName, toolMsg);
                if (normalized.skipStep) {
                  continue;
                }
                if (toolName === 'update_plan' && Array.isArray(normalized.plan)) {
                  this.onAgentPlan({
                    plan: normalized.plan.filter(Boolean).map((item: any) => ({
                      ...item,
                      text: item.text || item.step || item.content || ''
                    }))
                  });
                }
                this.onStepStart({ tool: toolName, args });
                this.onStepComplete({ tool: toolName, result: normalized.result, elapsed: '' });
              } else {
                this.onStepStart({ tool: toolName, args });
              }
            }
          }

          const text = typeof msg.content === 'string'
            ? msg.content
            : (Array.isArray(msg.content)
                ? msg.content.map((p: any) => (typeof p === 'string' ? p : (p && p.text) || '')).filter(Boolean).join('\n')
                : (msg.content == null ? '' : String(msg.content)));
          const syntheticNoFinal = msg.causyne_synthetic_no_final === true
            || (text.trim() === 'No final response was provided.'
                && (!Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0));
          if (syntheticNoFinal) {
            const isLatestTurn = !safeMessages.slice(i + 1).some(next =>
              next && (next.role === 'assistant' || next.role === 'user'));
            if (isLatestTurn) {
              this.frame('notice', () => {
                this.write(`${paint('warn', GLYPHS.warnMark)} ${dim('Provider returned no final answer; task completion is unverified.')}`);
              }, { syntheticNoFinal: true });
            }
          } else if (text.trim()) {
            this.renderAssistantMessage(text);
          }
        } else if (role === 'tool') {
          if (!renderedToolMessages.has(msg)) {
            renderedToolMessages.add(msg);
            const toolName = msg.name || 'tool';
            const normalized = normalizeHistoricalToolResult(toolName, msg, { unpaired: true });
            if (normalized.skipStep) {
              continue;
            }

            this.onStepStart({ tool: toolName, args: {} });
            this.onStepComplete({ tool: toolName, result: normalized.result, elapsed: '' });
          }
        } else if (role === 'system') {
          const text = typeof msg.content === 'string' ? msg.content : '';
          if (text.startsWith('[Continuum Context')) {
            this.frame('notice', () => {
              const firstLine = text.split('\n')[0] || '[Continuum Context]';
              this.write(`${paint('accent', GLYPHS.bullet)} ${dim(firstLine)}`);
            });
          }
        }
      }

      const finalMeasured = measureMessages(safeMessages);
      if (finalMeasured > 0) {
        this.status.contextChars = finalMeasured;
      }
      if (!this.status.contextLimit) {
        this.status.contextLimit = resolveCharPool(this.status.tier, undefined, {
          provider: sessionInfo?.provider || this.status.provider,
          model: sessionInfo?.model || this.status.model
        });
      }
      if (sessionInfo) {
        this.status.setSession({
          ...sessionInfo,
          contextChars: this.status.contextChars || finalMeasured,
          contextLimit: sessionInfo.contextLimit || this.status.contextLimit
        });
      }

      if (this.transcript?.surface?.viewport) {
        this.transcript.surface.viewport.manual = false;
        this.transcript.surface.viewport.unseen = 0;
        this.transcript.surface.viewport.toBottom();
      }
    };

    if (this.transcript && typeof this.transcript.batch === 'function') {
      this.transcript.batch(renderContent);
    } else {
      renderContent();
    }
  }

  onAgentMessage(msg: Record<string, any> | null | undefined): void {
    const safeMsg = msg && typeof msg === 'object' ? msg : {};
    const content = safeDisplay(safeMsg.content || '');
    const isStreaming = Boolean(safeMsg.streaming);

    const tailIsAssistant = !this.transcript
      || this.transcript.frames?.at(-1)?.meta?.assistant === true;
    if (this._activeAssistant && !tailIsAssistant) {
      this._activeAssistant = false;
    }

    if (isStreaming) {
      if (!this._activeAssistant) {
        this._activeAssistant = true;
        this.frame('assistant', () => this.formatAssistantMessage(content, { streaming: true }), { assistant: true, messageText: String(safeMsg.content || '') });
      } else {
        this.updateTailFrame('assistant', () => this.formatAssistantMessage(content, { streaming: true }), { assistant: true, messageText: String(safeMsg.content || '') });
      }
      return;
    }

    if (this._activeAssistant) {
      this._activeAssistant = false;
      this.updateTailFrame('assistant', () => this.formatAssistantMessage(content, { streaming: false }), { assistant: true, messageText: String(safeMsg.content || '') });
    } else {
      this.frame('assistant', () => this.formatAssistantMessage(content, { streaming: false }), { assistant: true, messageText: String(safeMsg.content || '') });
    }
  }

  formatAssistantMessage(content: string, { streaming = false }: { streaming?: boolean } = {}): void {
    const width = this.measure();
    this.write(`${paint('agent', GLYPHS.arrow)} ${bold(paint('agent', 'Causyne'))}${streaming ? ' ' + dim('…') : ''}`);
    for (const line of renderMarkdown(content, Math.max(8, width - 4))) {
      this.write(line ? '  ' + line : '');
    }
    this.write();
  }

  onAgentReasoning(msg: Record<string, any> | null | undefined): void {
    const safeMsg = msg && typeof msg === 'object' ? msg : {};
    const content = safeDisplay(safeMsg.content || '');
    const isStreaming = Boolean(safeMsg.streaming);
    const elapsedMs = Number(safeMsg.elapsedMs) || 0;
    const durationText = elapsedMs > 0 ? formatDuration(elapsedMs) : '';
    const activity = typeof safeMsg.activity === 'string' ? safeMsg.activity : '';
    const title = typeof safeMsg.title === 'string' ? safeMsg.title : '';
    const completedTitle = typeof safeMsg.completedTitle === 'string' ? safeMsg.completedTitle : '';

    const tailFrame = this.transcript?.frames?.at(-1);
    const tailIsReasoning = !this.transcript
      || tailFrame?.meta?.reasoning === true;
    if (this._activeReasoning && !tailIsReasoning) {
      this._activeReasoning = false;
    }

    if (isStreaming) {
      if (!this._activeReasoning) {
        this._activeReasoning = true;
        const meta: Record<string, any> = {
          reasoning: true,
          collapsed: false,
          streaming: true,
          durationText,
          content,
          activity,
          title,
          completedTitle,
          scrollStart: 0
        };
        this.frame('reasoning', () => this.renderReasoning(meta.content, {
          streaming: Boolean(meta.streaming),
          durationText: meta.durationText,
          collapsed: Boolean(meta.collapsed),
          startLine: Number(meta.scrollStart) || 0,
          activity: meta.activity,
          title: meta.title,
          completedTitle: meta.completedTitle
        }), meta);
      } else {
        const meta: Record<string, any> = tailFrame?.meta || { reasoning: true };
        meta.streaming = true;
        meta.durationText = durationText;
        meta.content = content;
        if (activity) meta.activity = activity;
        if (title) meta.title = title;
        if (completedTitle) meta.completedTitle = completedTitle;
        if (meta.collapsed === undefined) meta.collapsed = false;
        if (meta.scrollStart === undefined) meta.scrollStart = 0;
        this.updateTailFrame('reasoning', () => this.renderReasoning(meta.content, {
          streaming: Boolean(meta.streaming),
          durationText: meta.durationText,
          collapsed: Boolean(meta.collapsed),
          startLine: Number(meta.scrollStart) || 0,
          activity: meta.activity,
          title: meta.title,
          completedTitle: meta.completedTitle
        }), meta);
      }
      return;
    }

    if (this._activeReasoning) {
      this._activeReasoning = false;
      const meta: Record<string, any> = tailFrame?.meta || { reasoning: true };
      meta.streaming = false;
      meta.done = true;
      meta.durationText = durationText;
      meta.content = content;
      if (activity) meta.activity = activity;
      if (title) meta.title = title;
      if (completedTitle) meta.completedTitle = completedTitle;
      if (meta.collapsed === undefined) meta.collapsed = Boolean(safeMsg.collapsed);
      if (meta.scrollStart === undefined) meta.scrollStart = 0;
      this.updateTailFrame('reasoning', () => this.renderReasoning(meta.content, {
        streaming: Boolean(meta.streaming),
        durationText: meta.durationText,
        collapsed: Boolean(meta.collapsed),
        startLine: Number(meta.scrollStart) || 0,
        activity: meta.activity,
        title: meta.title,
        completedTitle: meta.completedTitle
      }), meta);
    } else if (content.trim()) {
      const meta: Record<string, any> = {
        reasoning: true,
        done: true,
        streaming: false,
        durationText,
        content,
        activity,
        title,
        completedTitle,
        collapsed: Boolean(safeMsg.collapsed),
        scrollStart: 0
      };
      this.frame('reasoning', () => this.renderReasoning(meta.content, {
        streaming: Boolean(meta.streaming),
        durationText: meta.durationText,
        collapsed: Boolean(meta.collapsed),
        startLine: Number(meta.scrollStart) || 0,
        activity: meta.activity,
        title: meta.title,
        completedTitle: meta.completedTitle
      }), meta);
    }
  }

  renderReasoning(
    content: string,
    { streaming = false, durationText = '', collapsed = false, startLine = 0, activity = '', title = '', completedTitle = '' }: {
      streaming?: boolean;
      durationText?: string;
      collapsed?: boolean;
      startLine?: number;
      activity?: string;
      title?: string;
      completedTitle?: string;
    } = {}
  ): void {
    const width = this.measure();
    const rows = renderThinkingFrame(content, {
      width,
      streaming,
      durationText,
      collapsed,
      startLine: Number(startLine) || 0,
      activity,
      title,
      completedTitle
    });

    if (rows.length === 0) return;

    this.write();
    for (const row of rows) {
      this.write(row);
    }
    this.write();
  }

  scrollThinkingPanel(_key: unknown, _surface: unknown): boolean {
    return false;
  }

  onAgentActivity(msg: Record<string, any> | null | undefined): void {
    if (!msg || typeof msg !== 'object') return;
    const text = String(msg.activity || msg.message || '').trim();
    if (!text) return;
    this.frame('notice', () => {
      const prefix = `${GLYPHS.arrow || '▸'} `;
      for (const [index, row] of activityRows(text, this.width(), prefix).entries()) {
        if (index === 0) {
          const body = row.startsWith(prefix) ? row.slice(prefix.length) : row;
          this.write(`${paint('accent', GLYPHS.arrow || '▸')} ${dim(body)}`);
        } else {
          this.write(dim(row));
        }
      }
    }, { activity: true });
  }

  onAgentPlan(msg: Record<string, any> | null | undefined): void {
    if (!msg || !Array.isArray(msg.plan) || msg.plan.length === 0) return;
    const plan = msg.plan.slice();
    this.latestPlan = plan;
    const placement = this.onPlanChange?.(plan);
    if (placement === 'sidebar') return;
    this.frame('plan', () => this.renderPlan(plan), { items: plan.length });
  }

  onDecisionRequest(msg: Record<string, any> | null | undefined): void {
    if (this.dialogWillAsk) return;
    const request = (msg && msg.request) || {};
    this.frame('approval', () => {
      this.write();
      this.write(`${paint('accent', GLYPHS.arrow)} ${bold(safeDisplay(request.header || 'decision required'))}`);
      for (const row of wrapBlock(safeDisplay(request.question || ''), Math.max(20, this.width() - 4), { hang: 0 })) this.write(`  ${row}`);
      this.write();
    }, { kind: request.kind || 'other' });
  }

  onDecisionResult(msg: Record<string, any> | null | undefined): void {
    const request = (msg && msg.request) || {};
    const answer = msg && msg.answer;
    this.frame('approval', () => {
      if (!answer) {
        this.write(`  ${paint('muted', 'decision dismissed')}  ${safeDisplay(request.header || '')}`);
        return;
      }
      this.write(`  ${paint('success', GLYPHS.check)} ${bold(safeDisplay(answer.label || ''))}${answer.custom ? dim('  custom choice') : ''}`);
    }, { kind: request.kind || 'other', answered: Boolean(answer) });
  }

  renderPlan(plan: readonly any[]): void {
    if (!Array.isArray(plan) || plan.length === 0) return;
    const width = this.width();
    this.write();
    this.write(paint('muted', 'plan'));
    for (const item of plan) {
      if (!item || typeof item !== 'object') continue;
      const done = item.status === 'completed';
      const active = item.status === 'in_progress';
      const mark = done ? paint('success', GLYPHS.check)
        : active ? paint('accent', GLYPHS.arrow)
        : paint('muted', GLYPHS.dot);
      const text = item.text || item.step || item.content || '';
      const label = done ? dim(safeDisplay(text)) : paint('ink', safeDisplay(text));
      this.write(`  ${mark} ${truncate(label, Math.max(8, width - 5), GLYPHS.ellipsis)}`);
    }
    this.write();
  }

  onStepStart(msg: Record<string, any> | null | undefined): void {
    const safeMsg = msg && typeof msg === 'object' ? msg : {};
    this.stepStartedAt = Date.now();
    this.stepCount++;

    const toolLabel = safeDisplay(safeMsg.tool || 'tool') || 'tool';
    const { verb, detail } = describeTool(safeMsg.tool, safeMsg.args);
    const step = this.stepCount;

    this.frame('step', () => {
      const width = this.width();
      const index = paint('muted', String(step).padStart(2, '0'));
      const displayVerb = verb || toolLabel;
      const name = paint('accent', padEnd(displayVerb, STATUS_GUTTER));

      const used = 2 + 2 + 1 + Math.max(visibleWidth(displayVerb), STATUS_GUTTER) + 1;
      const detailText = detail ? paint('ink', truncate(detail, Math.max(10, width - used - 12), GLYPHS.ellipsis)) : '';

      this.write(`${paint('muted', GLYPHS.arrow)} ${index} ${name} ${detailText}`);
    }, { step, tool: safeMsg.tool, verb: verb || toolLabel, detail });
  }

  onStepComplete(msg: Record<string, any> | null | undefined): void {
    const safeMsg = msg && typeof msg === 'object' ? msg : {};
    const elapsed = typeof safeMsg.elapsed === 'string'
      ? safeMsg.elapsed
      : (this.stepStartedAt ? formatDuration(Date.now() - this.stepStartedAt) : '');
    const result = safeMsg.result || {};

    this.captureLastOutput(result);

    const tail = this.transcript?.frames?.at(-1);
    if (compactSuccessfulToolResult(this.stepCount, result, tail, safeMsg.tool) && tail?.meta) {
      const { step, verb, detail, tool } = tail.meta;
      const completedElapsed = elapsed;
      this.updateTailFrame('step', () => {
        const width = this.width();
        const index = paint('muted', String(step).padStart(2, '0'));
        const name = paint('accent', padEnd(verb || tool, STATUS_GUTTER));
        const used = 2 + 2 + 1 + Math.max(visibleWidth(verb || tool), STATUS_GUTTER) + 1;
        const tailText = completedElapsed ? ` ${dim(completedElapsed)}` : '';
        const detailWidth = Math.max(5, width - used - visibleWidth(tailText) - 10);
        const detailText = detail ? paint('ink', truncate(detail, detailWidth, GLYPHS.ellipsis)) : '';
        this.write(`${paint('success', GLYPHS.check)} ${index} ${name} ${detailText}${tailText}`);
      }, { ...tail.meta, success: true, elapsed: completedElapsed });
      return;
    }

    this.frame('result', () => {
      if (result.success) {
        const elapsedText = elapsed ? ` ${dim(elapsed)}` : '';
        this.write(`     ${paint('success', GLYPHS.check)}${elapsedText}`);
        this.renderOutputPreview(result, safeMsg.tool || '');
        return;
      }
      const detail = `${safeDisplay(result.error || 'failed')}${elapsed ? ` · ${elapsed}` : ''}`;
      for (const row of wrappedChatRows(detail, this.width(), `     ${paint('danger', GLYPHS.cross)} `, 'danger')) this.write(row);
    }, { success: Boolean(result.success) });
  }

  expandLastOutput(): boolean {
    if (!this.lastOutput || !this.lastOutput.text) {
      this.frame('notice', () => this.write(dim('  nothing to expand')));
      return false;
    }
    const output = this.lastOutput;
    this.frame('result', () => {
      const width = Math.max(8, this.width() - 7);
      this.write('');
      let emitted = 0;
      let truncatedExpanded = false;
      for (const line of String(output.text).split('\n')) {
        for (const part of wrap(safeDisplay(line), width)) {
          if (emitted >= MAX_EXPAND_LINES) {
            truncatedExpanded = true;
            break;
          }
          this.write(`     ${paint('rule', GLYPHS.vLine)} ${dim(part)}`);
          emitted++;
        }
        if (truncatedExpanded) break;
      }
      if (truncatedExpanded) {
        this.write(`     ${paint('rule', GLYPHS.corner)} ${dim(`${GLYPHS.ellipsis} expanded view capped at ${MAX_EXPAND_LINES} lines`)}`);
      }
      if (output.spillPath) {
        this.write(this.clipHint(output.spillPath));
      }
      this.write('');
    }, { expanded: true });
    return true;
  }

  captureLastOutput(result: any): void {
    if (!result || typeof result !== 'object') return;
    const payload = typeof result.output === 'string' ? result.output
      : typeof result.log === 'string' ? result.log
      : '';
    if (!payload) return;
    this.lastOutput = { text: payload, spillPath: result.spillPath || null };
  }

  renderOutputPreview(result: any, toolName = ''): void {
    if (!result || typeof result !== 'object') return;
    const rawPayload = typeof result.output === 'string' ? result.output
      : typeof result.log === 'string' ? result.log
      : '';
    const payload = cleanToolOutputPreview(rawPayload, toolName);
    if (!payload) return;

    const source = payload.length > PREVIEW_SOURCE_BUDGET
      ? payload.slice(0, PREVIEW_SOURCE_BUDGET)
      : payload;
    if (!source.trim()) return;

    const width = Math.max(8, this.width() - 7);
    const cleaned = safeDisplay(source).replace(/\n{3,}/g, '\n\n').trim();

    const wrapped: string[] = [];
    for (const rawLine of cleaned.split('\n')) {
      const line = rawLine.replace(/\r/g, '').trimEnd();
      if (/^\s*(?:% Total\b|Dload\s+Upload\b|\d+\s+\d+\s+\d+\s+.*--:--:--)/i.test(line)) continue;
      for (const part of wrap(line, width)) {
        wrapped.push(part);
        if (wrapped.length > PREVIEW_LINES + 1) break;
      }
      if (wrapped.length > PREVIEW_LINES + 1) break;
    }

    const previewLimit = this.stepCount >= 12 ? 5 : PREVIEW_LINES;
    for (const line of wrapped.slice(0, previewLimit)) {
      this.write(`     ${paint('rule', GLYPHS.vLine)} ${dim(line)}`);
    }
    const clipped = wrapped.length > previewLimit || source.length < payload.length;
    if (clipped) this.write(this.clipHint(result.spillPath));
  }

  clipHint(spillPath?: string | null): string {
    const corner = paint('rule', GLYPHS.corner);
    const room = Math.max(12, this.width() - 8);

    if (spillPath) {
      const label = truncate(shortenHome(spillPath), Math.max(8, room - 13), GLYPHS.ellipsis);
      return `     ${corner} ${dim(`full output: ${fileLink(label, spillPath)}`)}`;
    }

    const full = `${GLYPHS.ellipsis} output truncated — ctrl+o to expand`;
    const short = `${GLYPHS.ellipsis} truncated — ctrl+o`;
    const hint = visibleWidth(full) <= room ? full
      : visibleWidth(short) <= room ? short
      : truncate(full, room, GLYPHS.ellipsis);
    return `     ${corner} ${dim(hint)}`;
  }

  onCheckpoint(msg: Record<string, any> | null | undefined): void {
    if (!msg || typeof msg !== 'object') return;
    const where = typeof msg.path === 'string' ? safeDisplay(shortenHome(msg.path)) : '';
    const count = Number(msg.count) || 1;
    this.frame('checkpoint', () => {
      const label = where
        ? `restore point ${GLYPHS.dot} ${where}`
        : `restore point ${GLYPHS.dot} ${count} file${count === 1 ? '' : 's'}`;
      this.write(`     ${paint('muted', GLYPHS.dot)} ${dim(truncate(label, Math.max(10, this.width() - 8), GLYPHS.ellipsis))}`);
    }, { tool: msg.tool, path: msg.path || null, step: msg.step ?? null, taskId: msg.taskId || null });
  }

  onStepError(msg: Record<string, any> | null | undefined): void {
    const safeMsg = msg && typeof msg === 'object' ? msg : {};
    const label = safeDisplay(`${safeMsg.tool || ''}`.trim());
    const rawError = safeMsg.error || (safeMsg.result && (safeMsg.result.error || safeMsg.result.message)) || '';
    const detail = safeDisplay(`${rawError}`.trim());
    const head = label && detail ? `${label}  ${detail}` : (detail || label || 'failed');

    this.frame('error', () => {
      const rows = wrapBlock(head, Math.max(20, this.width() - 7), { hang: 0 });
      this.write(`     ${paint('danger', GLYPHS.cross)} ${paint('danger', rows[0] || '')}`);
      for (const row of rows.slice(1)) this.write(`       ${dim(row)}`);
    }, { tool: safeMsg.tool });
  }

  onApprovalRequest(msg: Record<string, any> | null | undefined): void {
    if (!msg || typeof msg !== 'object') return;
    if (msg.toolCallId) this.pendingApprovals.set(msg.toolCallId, msg);

    if (this.dialogWillAsk) return;

    const diff = approvalDiff(msg.tool, msg.args, { width: this.width() });

    this.frame('approval', () => this.renderApprovalRequest(msg, diff), {
      tool: msg.tool,
      risk: String(msg.risk || 'unknown').toUpperCase()
    });
  }

  renderApprovalRequest(msg: Record<string, any> | null | undefined, diff: ApprovalDiffResult | null | undefined = undefined): void {
    if (!msg || typeof msg !== 'object') return;
    const risk = String(msg.risk || 'unknown').toUpperCase();
    const role = risk === 'EXTREME' ? 'danger' : risk === 'DANGEROUS' ? 'warn' : 'accent';
    const { verb, detail } = describeTool(msg.tool, msg.args);

    this.write();
    this.write(`${paint(role, GLYPHS.warnMark)} ${paint('ink', 'permission required')}  ${bold(safeDisplay(msg.tool || ''))}${verb ? dim(`  ${verb}`) : ''}`);
    if (detail) {
      this.write(`  ${paint('ink', truncate(detail, Math.max(8, this.width() - 4), GLYPHS.ellipsis))}`);
    }

    const resolvedDiff = diff === undefined ? approvalDiff(msg.tool, msg.args, { width: this.width() }) : diff;
    if (resolvedDiff) {
      const stat = [
        resolvedDiff.added ? paint('success', `+${resolvedDiff.added}`) : '',
        resolvedDiff.removed ? paint('danger', `-${resolvedDiff.removed}`) : ''
      ].filter(Boolean).join(' ');
      const note = resolvedDiff.note ? dim(`  ${GLYPHS.dot}  ${resolvedDiff.note}`) : '';
      const where = detail ? '' : `${dim(resolvedDiff.path)}  `;
      this.write(`  ${where}${stat}${note}`);
      this.write();
      for (const row of resolvedDiff.rows) this.write(row);
      if (resolvedDiff.clipped) {
        this.write(`     ${paint('rule', GLYPHS.corner)} ${dim(`${GLYPHS.ellipsis} diff truncated`)}`);
      }
      this.write();
    }
  }

  renderApprovalDecision(msg: Record<string, any> | null | undefined, approved: boolean, scope = 'once'): void {
    const safeMsg = msg && typeof msg === 'object' ? msg : {};
    const verdict = !approved
      ? paint('danger', 'rejected')
      : scope === 'always'
        ? paint('warn', 'allowed always')
        : paint('success', 'allowed once');
    const { verb } = describeTool(safeMsg.tool, safeMsg.args);
    this.frame('approval', () => {
      this.write(`  ${verdict} ${bold(safeDisplay(safeMsg.tool || ''))}${verb ? dim(`  ${verb}`) : ''}`);
    }, { tool: safeMsg.tool, approved: Boolean(approved), scope });
  }

  onError(msg: Record<string, any> | null | undefined): void {
    const safeMsg = msg && typeof msg === 'object' ? msg : {};
    const message = safeDisplay(safeMsg.message || '');
    this.frame('error', () => {
      this.write();
      for (const row of wrappedChatRows(message, this.width(), `${badge('danger', 'ERROR')} `, 'danger')) this.write(row);
      this.write();
    });
  }

  onBudgetWarning(msg: Record<string, any> | null | undefined): void {
    const safeMsg = msg && typeof msg === 'object' ? msg : {};
    const message = safeDisplay(safeMsg.message || '');
    this.frame('notice', () => {
      for (const row of wrappedChatRows(message, this.width(), `${badge('warn', 'BUDGET')} `, 'warn')) this.write(row);
    }, { tone: 'warn' });
  }

  onStatus(msg: Record<string, any> | null | undefined): void {
    const safeMsg = msg && typeof msg === 'object' ? msg : {};
    this.startSpinner(safeMsg.message || '');
  }

  skillInvoked(id: unknown, instruction?: unknown): void {
    this.frame('skill', () => {
      const width = this.width();
      const head = `${paint('accent', GLYPHS.step)} ${bold(paint('ink', 'skill'))}`
        + `${dim(`  ${GLYPHS.dot}  `)}${paint('agent', safeDisplay(String(id ?? '')))}`;
      this.write();
      this.write(truncate(head, Math.max(8, width - 1), GLYPHS.ellipsis));
      if (instruction) {
        for (const line of wrapBlock(safeDisplay(String(instruction)), Math.max(8, width - 4), { hang: 0 })) {
          this.write(dim(`  ${line}`));
        }
      }
    }, { skill: String(id || '') });
  }

  onNotice(msg: Record<string, any> | null | undefined): void {
    const safeMsg = msg && typeof msg === 'object' ? msg : {};
    const tone = ['accent', 'success', 'warn', 'muted'].includes(safeMsg.tone) ? String(safeMsg.tone) : 'muted';
    const message = safeDisplay(safeMsg.message || '');
    this.frame('notice', () => {
      const width = this.measure();
      const marker = paint(tone === 'muted' ? 'rule' : tone, GLYPHS.vLine);
      for (const line of wrapBlock(message, Math.max(8, width - 2), { hang: 0 })) {
        this.write(`${marker} ${dim(line)}`);
      }
    }, { tone });
  }

  handle(msg: Record<string, any> | null | undefined): boolean {
    if (!msg || typeof msg.type !== 'string') return false;
    if (msg.type !== 'status') this.stopSpinner();

    switch (msg.type) {
      case 'status':           this.onStatus(msg); return true;
      case 'agent_activity':   this.onAgentActivity(msg); return true;
      case 'agent_message':    this.onAgentMessage(msg); return true;
      case 'agent_reasoning':  this.onAgentReasoning(msg); return true;
      case 'agent_plan':       this.onAgentPlan(msg); return true;
      case 'step_start':       this.onStepStart(msg); return true;
      case 'step_complete':    this.onStepComplete(msg); return true;
      case 'step_error':       this.onStepError(msg); return true;
      case 'checkpoint':       this.onCheckpoint(msg); return true;
      case 'approval_request': this.onApprovalRequest(msg); return true;
      case 'decision_request': this.onDecisionRequest(msg); return true;
      case 'decision_result':  this.onDecisionResult(msg); return true;
      case 'error':            this.onError(msg); return true;
      case 'budget_warning':   this.onBudgetWarning(msg); return true;
      case 'notice':           this.onNotice(msg); return true;
      case 'usage_update':     this.status.onUsage(msg); return true;
      default:                 return false;
    }
  }
}
