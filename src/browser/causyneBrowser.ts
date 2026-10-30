import { WorkspacePreview } from './workspacePreview.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  capabilityDirectory,
  ensureCapability,
  loadCapabilityPackage
} from '../provisioning/capabilityProvisioner.js';
import { resolveBrowserRuntime, type PreparedBrowserRuntime } from './browserRuntime.js';
import { assertPublicWebUrl } from './urlPolicy.js';
import { windowSnapshot, type SnapshotWindow } from './snapshotWindow.js';

const NAVIGATION_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 12_000;
const IFRAME_SNAPSHOT_TIMEOUT_MS = 3_000;
const IDLE_CLOSE_MS = 10 * 60_000;
const MAX_SEARCH_RESULTS = 10;
const MAX_EXTRACT_CHARS = 80_000;
const MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;
const MAX_SNAPSHOT_NODES = 500;
const MAX_IFRAMES_TO_PROCESS = 8;

const INTERACTIVE_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'link', 'listitem', 'menuitem', 'option', 'radio',
  'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem'
]);

const SKIP_PATTERNS = [
  /datepicker/i, /date.?picker/i, /calendar/i, /^date$/i
];

const IFRAME_SKIP_PATTERNS = [
  /web-pixel/i, /analytics/i, /tracking/i, /gtm/i, /facebook/i,
  /doubleclick/i, /google.*tag/i, /hotjar/i, /segment/i, /sentry/i,
  /recaptcha/i, /gstatic/i, /app-bridge/i, /extensions\.shopifycdn/i,
  /px-iframe/i, /px-captcha/i, /perimeterx/i, /\bcaptcha\b/i, /hcaptcha/i,
  /arkose/i, /funcaptcha/i, /datadome/i
];

const NON_FILLABLE_INPUT_TYPES = new Set([
  'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'
]);

const KEY_MODIFIER_ALIASES = new Map<string, string>([
  ['ctrl', 'Control'],
  ['control', 'Control'],
  ['cmd', 'Meta'],
  ['command', 'Meta'],
  ['meta', 'Meta'],
  ['option', 'Alt'],
  ['esc', 'Escape'],
  ['return', 'Enter'],
  ['enter', 'Enter'],
  ['del', 'Delete']
]);

const SEARCH_MACROS: Record<string, (query: string) => string> = {
  '@google_search': query => `https://www.google.com/search?q=${encodeURIComponent(query || '')}`,
  '@duckduckgo_search': query => `https://duckduckgo.com/?q=${encodeURIComponent(query || '')}`,
  '@bing_search': query => `https://www.bing.com/search?q=${encodeURIComponent(query || '')}`,
  '@github_search': query => `https://github.com/search?q=${encodeURIComponent(query || '')}`,
  '@youtube_search': query => `https://www.youtube.com/results?search_query=${encodeURIComponent(query || '')}`,
  '@amazon_search': query => `https://www.amazon.com/s?k=${encodeURIComponent(query || '')}`,
  '@reddit_search': query => `https://www.reddit.com/search.json?q=${encodeURIComponent(query || '')}&limit=25`,
  '@reddit_subreddit': query => `https://www.reddit.com/r/${encodeURIComponent(query || 'all')}.json?limit=25`,
  '@wikipedia_search': query => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(query || '')}`,
  '@twitter_search': query => `https://twitter.com/search?q=${encodeURIComponent(query || '')}`,
  '@yelp_search': query => `https://www.yelp.com/search?find_desc=${encodeURIComponent(query || '')}`,
  '@spotify_search': query => `https://open.spotify.com/search/${encodeURIComponent(query || '')}`,
  '@netflix_search': query => `https://www.netflix.com/search?q=${encodeURIComponent(query || '')}`,
  '@linkedin_search': query => `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(query || '')}`,
  '@instagram_search': query => `https://www.instagram.com/explore/tags/${encodeURIComponent(query || '')}`,
  '@tiktok_search': query => `https://www.tiktok.com/search?q=${encodeURIComponent(query || '')}`,
  '@twitch_search': query => `https://www.twitch.tv/search?term=${encodeURIComponent(query || '')}`
};

export function expandSearchMacro(macro: string, query = ''): string | null {
  const fn = SEARCH_MACROS[String(macro || '').trim()];
  return fn ? fn(String(query ?? '')) : null;
}

export function getSupportedSearchMacros(): string[] {
  return Object.keys(SEARCH_MACROS);
}

export function normalizeBrowserKey(key: string): string {
  if (typeof key !== 'string' || !key.trim()) return 'Enter';
  return key
    .split('+')
    .map(part => {
      const trimmed = part.trim();
      return KEY_MODIFIER_ALIASES.get(trimmed.toLowerCase()) ?? trimmed;
    })
    .join('+');
}

export function visibleSelectorCandidate(selector: string): string | null {
  if (typeof selector !== 'string') return null;
  const trimmed = selector.trim();
  if (!trimmed || trimmed.includes(',') || trimmed.includes(':visible')) return null;
  return `${trimmed}:visible`;
}

export function selectorValidationError(selector?: string): string | null {
  if (selector === undefined || selector === null) return null;
  if (typeof selector !== 'string' || selector.trim() === '') return 'selector must be a non-empty string';
  if (/^text\s*\(/i.test(selector)) return 'Invalid text selector syntax. Use text=... or a valid CSS selector.';
  const stack: string[] = [];
  let quote: string | null = null;
  let escaped = false;
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  for (const ch of selector) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.pop() !== pairs[ch]) return `Invalid selector syntax: ${selector}`;
    }
  }
  if (quote || stack.length > 0) return `Invalid selector syntax: ${selector}`;
  return null;
}

const SUPPORTED_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'null']);

export interface ExtractPropertySchema {
  type?: string;
  'x-ref'?: string;
  description?: string;
}

export interface ExtractSchema {
  type: string;
  properties: Record<string, ExtractPropertySchema>;
  required?: string[];
}

export function validateExtractSchema(schema: unknown): { ok: boolean; error?: string } {
  if (!schema || typeof schema !== 'object') {
    return { ok: false, error: 'schema must be an object' };
  }
  const candidate = schema as Record<string, unknown>;
  if (candidate.type !== 'object') {
    return { ok: false, error: 'top-level schema must have type: object' };
  }
  if (!candidate.properties || typeof candidate.properties !== 'object' || Array.isArray(candidate.properties)) {
    return { ok: false, error: 'schema must have a properties object' };
  }
  for (const [prop, def] of Object.entries(candidate.properties as Record<string, unknown>)) {
    if (!def || typeof def !== 'object') {
      return { ok: false, error: `property "${prop}" must be an object` };
    }
    const propDef = def as ExtractPropertySchema;
    if (propDef.type && !SUPPORTED_SCHEMA_TYPES.has(propDef.type)) {
      return { ok: false, error: `property "${prop}" has unsupported type "${propDef.type}"` };
    }
  }
  return { ok: true };
}

function coerceSchemaValue(raw: string | null, type?: string): unknown {
  if (raw == null) return null;
  if (type === 'string' || !type) return String(raw).trim();
  if (type === 'number') {
    const n = parseFloat(String(raw).replace(/[^0-9.eE+-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'integer') {
    const n = parseInt(String(raw).replace(/[^0-9-]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'boolean') {
    const s = String(raw).toLowerCase().trim();
    if (s === 'true' || s === 'yes' || s === '1') return true;
    if (s === 'false' || s === 'no' || s === '0') return false;
    return null;
  }
  return raw;
}

export function extractDeterministic(options: {
  schema: ExtractSchema;
  refs: Map<string, BrowserRef>;
}): Record<string, unknown> {
  const check = validateExtractSchema(options.schema);
  if (!check.ok) throw new Error(check.error ?? 'Invalid extraction schema');

  const result: Record<string, unknown> = {};
  for (const [prop, def] of Object.entries(options.schema.properties)) {
    const refId = def['x-ref'];
    let value: unknown = null;
    if (refId) {
      const info = options.refs.get(refId);
      const raw = info?.name ? info.name : null;
      if (raw != null) {
        value = def.type && def.type !== 'object' ? coerceSchemaValue(raw, def.type) : raw;
      }
    }
    if (value == null && Array.isArray(options.schema.required) && options.schema.required.includes(prop)) {
      throw new Error(`required property "${prop}" could not be extracted (x-ref=${refId || 'n/a'})`);
    }
    result[prop] = value;
  }
  return result;
}

export interface PageStructureField {
  label: string;
  role: string;
  tag: string;
  type: string;
  id?: string;
  name?: string;
  disabled: boolean;
  value?: string;
  options?: Array<{ label: string; value: string; selected: boolean }>;
  optionsTruncated?: boolean;
  ref?: string;
}

export interface PageStructureForm {
  label?: string;
  id?: string;
  name?: string;
  method: string;
  fields: PageStructureField[];
  fieldsTruncated: boolean;
  submitControls: Array<{ label: string; id?: string; name?: string; disabled: boolean; ref?: string }>;
}

export interface PageStructureTable {
  label?: string;
  id?: string;
  headers: string[];
  columns: string[];
  rowCount: number;
  rows: string[][];
  rowsTruncated: boolean;
}

export interface PageStructure {
  forms: PageStructureForm[];
  formsTruncated: boolean;
  tables: PageStructureTable[];
  tablesTruncated: boolean;
}

export function attachStructureRefs(
  structure: PageStructure | null,
  refs: Map<string, BrowserRef>
): PageStructure | null {
  if (!structure || !(refs instanceof Map)) return structure;
  const refByRoleAndName = new Map<string, string>();
  for (const [ref, info] of refs) {
    refByRoleAndName.set(`${info.role}:${info.name}:${info.nth}`, ref);
  }
  const assign = (control: { label?: string; ref?: string }, role: string) => {
    if (!control?.label) return;
    const ref = refByRoleAndName.get(`${role}:${control.label}:0`);
    if (ref) control.ref = ref;
  };
  for (const form of structure.forms || []) {
    for (const field of form.fields || []) assign(field, field.role);
    for (const control of form.submitControls || []) assign(control, 'button');
  }
  return structure;
}

export function isDeadContextError(err: unknown): boolean {
  const msg = errorMessage(err);
  return msg.includes('Target page, context or browser has been closed')
    || msg.includes('browser has been closed')
    || msg.includes('Context closed')
    || msg.includes('Browser closed');
}

export function isPageCrashedError(err: unknown): boolean {
  const msg = errorMessage(err);
  return msg.includes('Page crashed')
    || msg.includes('Target crashed')
    || msg.includes('crashed page');
}

interface BrowserFrame {
  url(): string;
  name(): string;
  locator(selector: string): BrowserLocator;
  getByRole(role: string, options?: Record<string, unknown>): BrowserLocator;
}

interface BrowserLocator {
  first(): BrowserLocator;
  nth(index: number): BrowserLocator;
  click(options?: Record<string, unknown>): Promise<void>;
  dblclick?(options?: Record<string, unknown>): Promise<void>;
  hover?(options?: Record<string, unknown>): Promise<void>;
  focus?(options?: Record<string, unknown>): Promise<void>;
  fill(value: string, options?: Record<string, unknown>): Promise<void>;
  press(key: string, options?: Record<string, unknown>): Promise<void>;
  selectOption(value: unknown, options?: Record<string, unknown>): Promise<unknown>;
  setInputFiles?(files: string | string[], options?: Record<string, unknown>): Promise<void>;
  innerText(options?: Record<string, unknown>): Promise<string>;
  ariaSnapshot(options?: Record<string, unknown>): Promise<string>;
  count?(): Promise<number>;
  isVisible?(options?: Record<string, unknown>): Promise<boolean>;
  boundingBox?(options?: Record<string, unknown>): Promise<{ x: number; y: number; width: number; height: number } | null>;
  evaluate?<T>(fn: (element: any) => T): Promise<T>;
  waitFor?(options?: Record<string, unknown>): Promise<void>;
}

interface BrowserDownload {
  suggestedFilename(): string;
  saveAs(target: string): Promise<void>;
  failure(): Promise<string | null>;
}

interface BrowserFileChooser {
  setFiles(files: string | string[]): Promise<void>;
}

interface BrowserRoute {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
  fulfill?(response: { status: number; contentType: string; body: Buffer }): Promise<void>;
}

interface BrowserPage {
  isClosed(): boolean;
  url(): string;
  title(): Promise<string>;
  goto(url: string, options?: Record<string, unknown>): Promise<{ status(): number; headers(): Record<string, string> } | null>;
  waitForLoadState(state: string, options?: Record<string, unknown>): Promise<void>;
  waitForTimeout(milliseconds: number): Promise<void>;
  waitForSelector?(selector: string, options?: Record<string, unknown>): Promise<unknown>;
  waitForEvent(event: 'download' | 'filechooser', options?: Record<string, unknown>): Promise<any>;
  locator(selector: string): BrowserLocator;
  getByRole(role: string, options?: Record<string, unknown>): BrowserLocator;
  frames?(): BrowserFrame[];
  mainFrame?(): BrowserFrame;
  frame?(options: { name: string }): BrowserFrame | null;
  evaluate<T>(expression: string | ((arg?: any) => T | Promise<T>), argument?: unknown): Promise<T>;
  route(pattern: string, handler: (route: BrowserRoute) => Promise<void>): Promise<void>;
  setDefaultTimeout(milliseconds: number): void;
  setViewportSize?(size: { width: number; height: number }): Promise<void>;
  goBack(options?: Record<string, unknown>): Promise<unknown>;
  goForward(options?: Record<string, unknown>): Promise<unknown>;
  reload(options?: Record<string, unknown>): Promise<unknown>;
  screenshot(options?: Record<string, unknown>): Promise<Buffer>;
  close(): Promise<void>;
  on?(event: string, handler: (...args: any[]) => void): void;
  keyboard: {
    press(key: string): Promise<void>;
    type?(text: string, options?: { delay?: number }): Promise<void>;
  };
  mouse: {
    wheel(deltaX: number, deltaY: number): Promise<void>;
    move?(x: number, y: number): Promise<void>;
    down?(): Promise<void>;
    up?(): Promise<void>;
  };
}

interface BrowserSession {
  newPage(): Promise<BrowserPage>;
  pages(): BrowserPage[];
  close(): Promise<void>;
  isConnected?(): boolean;
  route?(pattern: string, handler: (route: BrowserRoute) => Promise<void>): Promise<void>;
  on?(event: 'page', handler: (page: BrowserPage) => void): void;
}

interface BrowserEngineModule {
  Camoufox(options: Record<string, unknown>): Promise<BrowserSession>;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
}

export interface BrowserRef {
  role: string;
  name: string;
  nth: number;
  frameName?: string;
  frameUrl?: string;
}

interface TabState {
  id: string;
  page: BrowserPage;
  refs: Map<string, BrowserRef>;
  lastSnapshot: string;
  lastStructure: PageStructure | null;
  crashed?: boolean;
  runtimeErrors: string[];
}

export type BrowserActionType =
  | 'newTab' | 'new_tab'
  | 'switchTab' | 'switch_tab'
  | 'listTabs' | 'list_tabs'
  | 'closeTab' | 'close_tab'
  | 'search'
  | 'goto' | 'open' | 'navigate' | 'preview'
  | 'snapshot' | 'scrape'
  | 'click' | 'clickIndex'
  | 'type' | 'typeIndex' | 'fill'
  | 'selectOption' | 'select'
  | 'keyPress' | 'press'
  | 'hover'
  | 'scroll'
  | 'wait'
  | 'viewport'
  | 'back' | 'forward' | 'reload' | 'refresh'
  | 'extract' | 'links' | 'images'
  | 'upload' | 'download' | 'screenshot';

export type BrowserAction = {
  type: BrowserActionType;
  tabId?: string;
  url?: string;
  macro?: string;
  query?: string;
  ref?: string;
  index?: number;
  selector?: string;
  text?: string;
  value?: string;
  option?: string;
  key?: string;
  mode?: 'fill' | 'keyboard';
  delay?: number;
  submit?: boolean;
  pressEnter?: boolean;
  doubleClick?: boolean;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  offset?: number;
  limit?: number;
  timeout?: number;
  waitForNetwork?: boolean;
  dismissConsent?: boolean;
  width?: number;
  height?: number;
  schema?: ExtractSchema;
  filePath?: string | string[];
  outputFile?: string;
  fullPage?: boolean;
};

export interface BrowserActionResult {
  action: BrowserAction['type'];
  tabId?: string;
  url?: string;
  title?: string;
  output?: string;
  data?: unknown;
  structure?: PageStructure | null;
}

export interface BrowserRunOptions {
  workspace?: string;
}

interface RuntimeOptions {
  workspace?: string;
  ensureBrowserCapability?: () => Promise<{ ok: boolean; reason?: string; requiresConsent?: boolean }>;
  loadBrowserEngine?: () => Promise<BrowserEngineModule>;
  resolveRuntime?: () => PreparedBrowserRuntime;
  profileDirectory?: string;
  visible?: boolean;
  validateUrl?: (value: string) => Promise<URL>;
}

export class BrowserCapabilityError extends Error {
  readonly requiresConsent: boolean;

  constructor(message: string, requiresConsent = false) {
    super(message);
    this.name = 'BrowserCapabilityError';
    this.requiresConsent = requiresConsent;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedText(value: string, limit = MAX_EXTRACT_CHARS): string {
  const text = String(value ?? '').replace(/\u0000/g, '');
  return text.length > limit ? `${text.slice(0, limit)}\n\n[Browser output truncated at ${limit} characters]` : text;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function parseAriaRefs(snapshot: string): Map<string, BrowserRef> {
  const refs = new Map<string, BrowserRef>();
  const seen = new Map<string, number>();
  let counter = 1;
  for (const line of String(snapshot ?? '').split('\n')) {
    if (counter > MAX_SNAPSHOT_NODES) break;
    const match = line.match(/^\s*-\s+([a-z][\w-]*)(?:\s+"([^"]*)")?/i);
    if (!match) continue;
    const role = (match[1] ?? '').toLowerCase();
    const name = match[2] ?? '';
    if (name && SKIP_PATTERNS.some(pattern => pattern.test(name))) continue;
    if (!INTERACTIVE_ROLES.has(role)) continue;
    const key = `${role}:${name}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    refs.set(`e${counter++}`, { role, name, nth });
  }
  return refs;
}

export function annotateAriaSnapshot(snapshot: string, refs: Map<string, BrowserRef>): string {
  const queues = new Map<string, string[]>();
  for (const [id, ref] of refs) {
    if (ref.frameName || ref.frameUrl) continue;
    const key = `${ref.role}:${ref.name}`;
    queues.set(key, [...(queues.get(key) ?? []), id]);
  }
  return String(snapshot ?? '').split('\n').map(line => {
    const match = line.match(/^(\s*-\s+)([a-z][\w-]*)(?:\s+"([^"]*)")?/i);
    if (!match) return line;
    const name = match[3] ?? '';
    if (name && SKIP_PATTERNS.some(pattern => pattern.test(name))) return line;
    const key = `${(match[2] ?? '').toLowerCase()}:${name}`;
    const id = queues.get(key)?.shift();
    return id ? `${line} [${id}]` : line;
  }).join('\n');
}

const PAGE_STRUCTURE_EXTRACT_SCRIPT = `(() => {
  const MAX_FORMS = 20;
  const MAX_FIELDS_PER_FORM = 30;
  const MAX_TABLES = 20;
  const MAX_ROWS_PER_TABLE = 50;
  const MAX_CELLS_PER_ROW = 30;
  const MAX_CELL_CHARS = 200;
  const MAX_OPTIONS_PER_SELECT = 30;
  const MAX_LABEL_CHARS = 150;
  const SENSITIVE_FIELD_RE = /password|passwd|pwd|secret|token|api[_-]?key|ssn|credit|card|cvv|cvc/i;

  function trunc(str, max) {
    if (!str) return '';
    const s = String(str).replace(/\\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(el);
    if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  function resolveLabel(el) {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return trunc(ariaLabel, MAX_LABEL_CHARS);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\\s+/)
        .map(id => document.getElementById(id)?.textContent || '')
        .join(' ')
        .trim();
      if (text) return trunc(text, MAX_LABEL_CHARS);
    }
    if (el.id) {
      const escapedId = String(el.id).replace(/"/g, '\\\\"');
      const byFor = document.querySelector('label[for="' + escapedId + '"]');
      if (byFor) return trunc(byFor.textContent, MAX_LABEL_CHARS);
    }
    const parentLabel = el.closest('label');
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll('input,select,textarea,button').forEach(node => node.remove());
      const text = clone.textContent?.trim();
      if (text) return trunc(text, MAX_LABEL_CHARS);
    }
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return trunc(placeholder, MAX_LABEL_CHARS);
    const title = el.getAttribute('title');
    if (title) return trunc(title, MAX_LABEL_CHARS);
    return null;
  }

  function inferRole(el, tag, type) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      if (type === 'number') return 'spinbutton';
      if (type === 'range') return 'slider';
      return 'textbox';
    }
    return null;
  }

  function extractField(el) {
    const tag = (el.tagName || '').toLowerCase();
    const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : tag;
    if (type === 'hidden') return null;
    if (!isVisible(el)) return null;
    const name = el.getAttribute('name') || null;
    const id = el.id || null;
    const label = resolveLabel(el);
    const role = inferRole(el, tag, type);
    const accessibleName = trunc(
      el.getAttribute('aria-label') || label || el.value || el.textContent || '',
      MAX_LABEL_CHARS
    ) || null;
    const isSensitive = type === 'password'
      || SENSITIVE_FIELD_RE.test(name || '')
      || SENSITIVE_FIELD_RE.test(id || '')
      || SENSITIVE_FIELD_RE.test(el.getAttribute('autocomplete') || '');
    const field = { tag, type };
    if (name) field.name = trunc(name, 80);
    if (id) field.id = trunc(id, 80);
    if (label) field.label = label;
    if (role) field.role = role;
    if (accessibleName) field._accessibleName = accessibleName;
    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder !== label) field.placeholder = trunc(placeholder, MAX_LABEL_CHARS);
    if (el.required || el.getAttribute('aria-required') === 'true') field.required = true;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') field.disabled = true;
    if (el.readOnly) field.readOnly = true;
    if (type === 'checkbox' || type === 'radio') {
      field.checked = Boolean(el.checked);
      if (el.value && el.value !== 'on') field.value = trunc(el.value, 100);
    } else if (tag === 'select') {
      const opts = Array.from(el.options || []).slice(0, MAX_OPTIONS_PER_SELECT).map(o => ({
        value: trunc(o.value, 100),
        text: trunc(o.text, 100),
        ...(o.selected ? { selected: true } : {})
      }));
      field.options = opts;
      if ((el.options || []).length > MAX_OPTIONS_PER_SELECT) field.optionsTruncated = true;
    } else if (tag === 'button' || type === 'submit' || type === 'button' || type === 'reset') {
      const btnText = trunc(el.textContent || el.value || '', 100);
      if (btnText) field.text = btnText;
    } else if (isSensitive) {
      field.value = el.value ? '[REDACTED]' : '';
      field.redacted = true;
    } else if (typeof el.value === 'string' && el.value.length > 0) {
      field.value = trunc(el.value, MAX_CELL_CHARS);
    }
    return field;
  }

  const formEls = Array.from(document.querySelectorAll('form'));
  const forms = [];
  const seenControls = new Set();

  for (const formEl of formEls.slice(0, MAX_FORMS)) {
    const controls = Array.from(formEl.querySelectorAll('input, select, textarea, button'));
    controls.forEach(c => seenControls.add(c));
    const fields = [];
    for (const ctrl of controls) {
      if (fields.length >= MAX_FIELDS_PER_FORM) break;
      const f = extractField(ctrl);
      if (f) fields.push(f);
    }
    if (fields.length === 0) continue;
    const formObj = { fields };
    if (formEl.id) formObj.id = trunc(formEl.id, 80);
    const fName = formEl.getAttribute('name') || formEl.getAttribute('aria-label');
    if (fName) formObj.name = trunc(fName, 100);
    const action = formEl.getAttribute('action');
    if (action) formObj.action = trunc(action, 200);
    const method = (formEl.getAttribute('method') || 'get').toUpperCase();
    formObj.method = method;
    if (controls.length > MAX_FIELDS_PER_FORM) formObj.fieldsTruncated = true;
    forms.push(formObj);
  }

  if (forms.length < MAX_FORMS) {
    const orphans = Array.from(document.querySelectorAll('input, select, textarea'))
      .filter(el => !seenControls.has(el));
    const orphanFields = [];
    for (const ctrl of orphans) {
      if (orphanFields.length >= MAX_FIELDS_PER_FORM) break;
      const f = extractField(ctrl);
      if (f) orphanFields.push(f);
    }
    if (orphanFields.length > 0) {
      forms.push({ implicit: true, fields: orphanFields });
    }
  }

  const tableEls = Array.from(document.querySelectorAll('table'));
  const tables = [];

  for (const tableEl of tableEls) {
    if (tables.length >= MAX_TABLES) break;
    if (!isVisible(tableEl)) continue;
    const allRows = Array.from(tableEl.querySelectorAll('tr'));
    if (allRows.length === 0) continue;
    let headers = [];
    const theadRow = tableEl.querySelector('thead tr');
    let bodyStartIdx = 0;
    if (theadRow) {
      headers = Array.from(theadRow.querySelectorAll('th, td'))
        .slice(0, MAX_CELLS_PER_ROW)
        .map(c => trunc(c.textContent, MAX_CELL_CHARS));
    } else {
      const firstRow = allRows[0];
      const ths = firstRow.querySelectorAll('th');
      if (ths.length > 0) {
        headers = Array.from(firstRow.querySelectorAll('th, td'))
          .slice(0, MAX_CELLS_PER_ROW)
          .map(c => trunc(c.textContent, MAX_CELL_CHARS));
        bodyStartIdx = 1;
      }
    }
    const bodyRowEls = theadRow
      ? Array.from(tableEl.querySelectorAll('tbody tr'))
      : allRows.slice(bodyStartIdx);
    const rows = [];
    for (const tr of bodyRowEls) {
      if (rows.length >= MAX_ROWS_PER_TABLE) break;
      const cells = Array.from(tr.querySelectorAll('td, th'))
        .slice(0, MAX_CELLS_PER_ROW)
        .map(c => trunc(c.textContent, MAX_CELL_CHARS));
      if (cells.length === 0 || cells.every(c => c === '')) continue;
      if (headers.length > 0 && headers.some(Boolean)) {
        const obj = {};
        cells.forEach((val, idx) => {
          const key = headers[idx] || ('col_' + (idx + 1));
          obj[key] = val;
        });
        rows.push(obj);
      } else {
        rows.push(cells);
      }
    }
    if (headers.length === 0 && rows.length < 2) continue;
    const tableObj = { headers, rows, rowCount: bodyRowEls.length };
    if (tableEl.id) tableObj.id = trunc(tableEl.id, 80);
    const caption = tableEl.querySelector('caption')?.textContent || tableEl.getAttribute('aria-label');
    if (caption) tableObj.caption = trunc(caption, MAX_LABEL_CHARS);
    if (bodyRowEls.length > MAX_ROWS_PER_TABLE) tableObj.rowsTruncated = true;
    tables.push(tableObj);
  }

  return { forms, tables };
})()`;

export async function extractPageStructure(page: BrowserPage): Promise<PageStructure | null> {
  try {
    const raw = await page.evaluate<PageStructure>(PAGE_STRUCTURE_EXTRACT_SCRIPT);
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.forms) || !Array.isArray(raw.tables)) {
      return null;
    }
    if (raw.forms.length === 0 && raw.tables.length === 0) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

const SEARCH_EXTRACT_SCRIPT = `(() => {
  const text = value => String(value || '').replace(/\\s+/g, ' ').trim();
  const candidates = [
    ...document.querySelectorAll('#rso h3, #search h3, li.b_algo h2, article h2, a.result__a')
  ];
  const seen = new Set();
  const results = [];
  for (const heading of candidates) {
    const anchor = heading.matches('a[href]') ? heading : heading.closest('a[href]');
    if (!anchor || !anchor.href) continue;
    let href = anchor.href;
    try {
      const parsed = new URL(href, document.baseURI);
      if (parsed.hostname.includes('google.') && parsed.pathname === '/url') {
        href = parsed.searchParams.get('q') || parsed.searchParams.get('url') || href;
      }
      if (/(^|\.)duckduckgo\.com$/i.test(parsed.hostname) && parsed.pathname.startsWith('/l/')) {
        href = parsed.searchParams.get('uddg') || href;
      }
      const clean = new URL(href, document.baseURI);
      if (!/^https?:$/.test(clean.protocol) || seen.has(clean.href)) continue;
      if (/^(www\\.)?(google|bing|duckduckgo)\\./i.test(clean.hostname)) continue;
      seen.add(clean.href);
      href = clean.href;
    } catch { continue; }
    const title = text(heading.textContent);
    if (!title) continue;
    const block = heading.closest('.MjjYud, .g, li.b_algo, article, .result') || anchor.parentElement?.parentElement;
    let snippet = '';
    if (block) {
      const snippetNode = block.querySelector('.VwiC3b, .b_caption p, .result__snippet, [data-sncf]');
      snippet = text(snippetNode?.textContent || '');
      if (!snippet) snippet = text(block.textContent).replace(title, '').slice(0, 500);
    }
    results.push({ title: title.slice(0, 300), url: href, snippet: snippet.slice(0, 500) });
    if (results.length >= ${MAX_SEARCH_RESULTS}) break;
  }
  return results;
})()`;

const LINKS_EXTRACT_SCRIPT = `(opts) => {
  const scope = opts && opts.selector ? document.querySelector(opts.selector) : document;
  if (!scope) return { links: [], totalLinks: 0 };
  const anchors = Array.from(scope.querySelectorAll('a[href]'));
  const seen = new Set();
  const all = [];
  for (const a of anchors) {
    let href;
    try {
      href = new URL(a.getAttribute('href'), document.baseURI).href;
    } catch {
      continue;
    }
    if (!href.startsWith('http://') && !href.startsWith('https://')) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    const text = (a.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200);
    all.push({ url: href, text: text || undefined });
  }
  const start = (opts && opts.offset) || 0;
  const max = (opts && opts.limit) || 50;
  return { links: all.slice(start, start + max), totalLinks: all.length };
}`;

const IMAGES_EXTRACT_SCRIPT = `(opts) => {
  const max = Math.min(Math.max(Number(opts && opts.limit) || 100, 1), 300);
  const imgs = Array.from(document.querySelectorAll('img'));
  const seen = new Set();
  const out = [];
  for (const img of imgs) {
    const src = img.currentSrc || img.src || '';
    if (!src || src.startsWith('data:') || seen.has(src)) continue;
    const width = Number(img.naturalWidth || img.width || 0);
    const height = Number(img.naturalHeight || img.height || 0);
    seen.add(src);
    out.push({
      src,
      alt: (img.alt || '').trim().slice(0, 200) || undefined,
      width,
      height
    });
    if (out.length >= max) break;
  }
  return out;
}`;

const DISMISS_CONSENT_SCRIPT = `(() => {
  const selectors = [
    '#onetrust-accept-btn-handler',
    '.onetrust-close-btn-handler',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    '#CybotCookiebotDialogBodyButtonAccept',
    '[data-testid="cookie-policy-dialog-accept-button"]',
    'button[id*="cookie"][id*="accept" i]',
    'button[class*="cookie"][class*="accept" i]',
    'button[aria-label*="Accept all" i]',
    'button[aria-label*="Accept cookies" i]'
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && typeof el.click === 'function') {
      const rect = el.getBoundingClientRect?.();
      if (!rect || (rect.width > 0 && rect.height > 0)) {
        el.click();
        return true;
      }
    }
  }
  return false;
})()`;

const WAIT_FOR_PAGE_READY_SCRIPT = `(() => {
  return new Promise(resolve => {
    if (document.readyState === 'complete') {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
    } else {
      window.addEventListener('load', () => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
      }, { once: true });
      setTimeout(() => resolve(false), 3000);
    }
  });
})()`;

export class CausyneBrowser {
  private workspace: string;
  private readonly workspacePreview = new WorkspacePreview();
  private readonly ensureBrowserCapability: NonNullable<RuntimeOptions['ensureBrowserCapability']>;
  private readonly loadBrowserEngine: NonNullable<RuntimeOptions['loadBrowserEngine']>;
  private readonly resolveRuntime: NonNullable<RuntimeOptions['resolveRuntime']>;
  private readonly profileDirectory: string;
  private readonly visible: boolean;
  private readonly validateUrl: (value: string) => Promise<URL>;
  private session: BrowserSession | null = null;
  private starting: Promise<void> | null = null;
  private tabs = new Map<string, TabState>();
  private activeTabId: string | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private securedPages = new WeakSet<object>();
  private pageStates = new WeakMap<object, TabState>();
  private contextRouteInstalled = false;

  constructor(options: RuntimeOptions = {}) {
    this.workspace = path.resolve(options.workspace ?? process.cwd());
    this.ensureBrowserCapability = options.ensureBrowserCapability ?? (() => ensureCapability('browser'));
    this.loadBrowserEngine = options.loadBrowserEngine ?? (async () => await loadCapabilityPackage('camoufox-js') as BrowserEngineModule);
    this.resolveRuntime = options.resolveRuntime ?? resolveBrowserRuntime;
    this.profileDirectory = path.resolve(options.profileDirectory ?? path.join(capabilityDirectory(), 'browser-profile'));
    this.visible = options.visible ?? process.env.CAUSYNE_BROWSER_VISIBLE === '1';
    this.validateUrl = options.validateUrl ?? assertPublicWebUrl;
  }

  setWorkspace(workspace: string): void {
    if (workspace && typeof workspace === 'string') {
      if (this.workspace !== path.resolve(workspace)) this.workspacePreview.clear();
      this.workspace = path.resolve(workspace);
    }
  }

  getWorkspace(): string {
    return this.workspace;
  }

  async run(actions: BrowserAction[], options: BrowserRunOptions = {}): Promise<BrowserActionResult[]> {
    if (!Array.isArray(actions) || actions.length === 0 || actions.length > 40) {
      throw new Error('Browser actions must contain between 1 and 40 operations');
    }
    const activeWorkspace = options.workspace ? path.resolve(options.workspace) : this.workspace;
    await this.start();
    const results: BrowserActionResult[] = [];
    for (const action of actions) {
      try {
        results.push(await this.runAction(action, activeWorkspace));
      } catch (error) {
        if (isDeadContextError(error)) {
          await this.close();
          await this.start();
          results.push(await this.runAction(action, activeWorkspace));
        } else {
          throw error;
        }
      }
    }
    this.touch();
    return results;
  }

  async search(query: string): Promise<SearchResult[]> {
    const cleaned = String(query ?? '').trim();
    if (!cleaned || cleaned.length > 1_000) throw new Error('Search query must contain 1-1000 characters');
    await this.start();
    const state = await this.activeTab();
    const targets = [
      { engine: 'google', url: `https://www.google.com/search?q=${encodeURIComponent(cleaned)}` },
      { engine: 'duckduckgo', url: `https://duckduckgo.com/html/?q=${encodeURIComponent(cleaned)}` },
      { engine: 'bing', url: `https://www.bing.com/search?q=${encodeURIComponent(cleaned)}` }
    ];
    const failures: string[] = [];
    for (const target of targets) {
      try {
        await this.navigate(state, target.url);
        await state.page.waitForTimeout(250);
        const extracted = await state.page.evaluate<Array<Omit<SearchResult, 'engine'>>>(SEARCH_EXTRACT_SCRIPT);
        if (Array.isArray(extracted) && extracted.length > 0) {
          return extracted.slice(0, MAX_SEARCH_RESULTS).map(result => ({ ...result, engine: target.engine }));
        }
        failures.push(`${target.engine}: no organic results`);
      } catch (error) {
        failures.push(`${target.engine}: ${errorMessage(error)}`);
      }
    }
    throw new Error(`Search providers exhausted. ${failures.join('; ')}`);
  }

  async snapshot(offset = 0): Promise<SnapshotWindow & { tabId: string; url: string; title: string; refsCount: number; structure?: PageStructure | null }> {
    await this.start();
    const state = await this.activeTab();
    await this.captureSnapshotState(state);
    return {
      ...windowSnapshot(state.lastSnapshot, offset),
      tabId: state.id,
      url: state.page.url(),
      title: await state.page.title(),
      refsCount: state.refs.size,
      ...(state.lastStructure ? { structure: state.lastStructure } : {})
    };
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const session = this.session;
    this.session = null;
    this.starting = null;
    this.tabs.clear();
    this.workspacePreview.clear();
    this.activeTabId = null;
    this.contextRouteInstalled = false;
    this.securedPages = new WeakSet<object>();
    this.pageStates = new WeakMap<object, TabState>();
    if (session) await session.close().catch(() => {});
  }

  private isSessionHealthy(): boolean {
    if (!this.session) return false;
    if (typeof this.session.isConnected === 'function' && !this.session.isConnected()) {
      return false;
    }
    try {
      this.session.pages();
      return true;
    } catch {
      return false;
    }
  }

  private async start(): Promise<void> {
    if (this.session) {
      if (this.isSessionHealthy()) return;
      await this.close();
    }
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const verdict = await this.ensureBrowserCapability();
      if (!verdict.ok) throw new BrowserCapabilityError(verdict.reason ?? 'Browser capability is unavailable', verdict.requiresConsent);
      const runtime = this.resolveRuntime();
      if (runtime.engine === 'chromium') {
        const engine = await loadCapabilityPackage('playwright-core') as { chromium: { launchPersistentContext(profile: string, options: Record<string, unknown>): Promise<BrowserSession> } };
        const profile = path.join(this.profileDirectory, 'chromium');
        const chromiumArgs = [
          '--enable-webgl',
          '--use-gl=angle',
          ...(process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-gl=swiftshader']),
          '--ignore-gpu-blocklist',
          '--enable-gpu-rasterization'
        ];
        this.session = await engine.chromium.launchPersistentContext(profile, {
          executablePath: runtime.executablePath, headless: !this.visible, serviceWorkers: 'block', chromiumSandbox: true,
          args: chromiumArgs,
          handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false
        });
      } else {
      process.env.CAMOUFOX_INSTALL_DIR = runtime.installDirectory;
      await fs.mkdir(this.profileDirectory, { recursive: true, mode: 0o700 });
      const module = await this.loadBrowserEngine();
      if (!module || typeof module.Camoufox !== 'function') throw new Error('Causyne Browser has no usable launcher');
      this.session = await module.Camoufox({
        headless: !this.visible,
        user_data_dir: this.profileDirectory,
        humanize: 0.35,
        block_webrtc: true,
        geoip: false,
        enable_cache: true,
        ...(runtime.executablePath ? { executable_path: runtime.executablePath } : {}),
        firefox_user_prefs: {
          'Security.OCSP.enabled': 0
        },
        handleSIGTERM: false,
        handleSIGINT: false,
        handleSIGHUP: false
      });
      }
      if (typeof this.session.route === 'function') {
        await this.session.route('**/*', route => this.guardRoute(route));
        this.contextRouteInstalled = true;
      }
      this.session.on?.('page', page => { void this.registerPage(page).catch(() => {}); });
      const existing = this.session.pages().find(page => !page.isClosed());
      if (existing) await this.registerPage(existing);
      else await this.createTab();
    })();
    try {
      await this.starting;
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      this.starting = null;
    }
  }

  private async registerPage(page: BrowserPage): Promise<TabState> {
    const known = this.pageStates.get(page);
    if (known) {
      this.activeTabId = known.id;
      return known;
    }
    const id = crypto.randomUUID();
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    if (!this.contextRouteInstalled && !this.securedPages.has(page)) {
      await page.route('**/*', route => this.guardRoute(route));
      this.securedPages.add(page);
    }
    const state: TabState = { id, page, refs: new Map(), lastSnapshot: '', lastStructure: null, runtimeErrors: [] };
    page.on?.('pageerror', (error: unknown) => {
      if (state.runtimeErrors.length < 10) state.runtimeErrors.push(error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400));
    });
    page.on?.('console', (msg: any) => {
      const type = typeof msg?.type === 'function' ? msg.type() : (msg?.type || 'log');
      const text = typeof msg?.text === 'function' ? msg.text() : String(msg?.text || msg || '');
      if (type === 'error' || type === 'warning') {
        if (state.runtimeErrors.length < 10) {
          state.runtimeErrors.push(`[console.${type}] ${text.slice(0, 400)}`);
        }
      }
    });
    page.on?.('crash', () => {
      state.crashed = true;
    });
    page.on?.('close', () => {
      this.tabs.delete(id);
      if (this.activeTabId === id) {
        const remaining = [...this.tabs.values()].find(tab => !tab.page.isClosed() && !tab.crashed);
        this.activeTabId = remaining?.id ?? null;
      }
    });
    this.pageStates.set(page, state);
    this.tabs.set(id, state);
    this.activeTabId = id;
    return state;
  }

  private async guardRoute(route: BrowserRoute): Promise<void> {
    const url = route.request().url();
    if (/^(about:|data:|blob:|moz-extension:)/i.test(url)) return route.continue();
    try {
      const preview = await this.workspacePreview.response(url);
      if (preview) {
        if (!route.fulfill) throw new Error('Browser engine cannot fulfill preview requests');
        await route.fulfill(preview);
        return;
      }
      const parsed = new URL(url);
      if (parsed.protocol === 'file:') {
        const workspace = await fs.realpath(this.workspace);
        const file = await fs.realpath(fileURLToPath(parsed));
        if (!isWithin(workspace, file)) throw new Error('File is outside the selected workspace');
        await route.continue();
        return;
      }
      if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
        parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
        await this.validateUrl(parsed.href);
      } else {
        await this.validateUrl(url);
      }
      await route.continue();
    } catch {
      await route.abort('blockedbyclient');
    }
  }

  private async createTab(url?: string): Promise<TabState> {
    if (!this.session) throw new Error('Browser is not started');
    let page: BrowserPage;
    try {
      page = await this.session.newPage();
    } catch (error) {
      if (isDeadContextError(error)) {
        await this.close();
        await this.start();
        if (!this.session) throw error;
        page = await this.session.newPage();
      } else {
        throw error;
      }
    }
    const state = await this.registerPage(page);
    if (url) await this.navigate(state, url);
    return state;
  }

  private async activeTab(): Promise<TabState> {
    const active = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
    if (active && !active.page.isClosed() && !active.crashed) return active;
    for (const candidate of this.tabs.values()) {
      if (!candidate.page.isClosed() && !candidate.crashed) {
        this.activeTabId = candidate.id;
        return candidate;
      }
    }
    return this.createTab();
  }

  private requestedTab(action: BrowserAction): TabState | null {
    if (!action.tabId) return null;
    const state = this.tabs.get(action.tabId);
    if (!state || state.page.isClosed() || state.crashed) throw new Error(`Unknown or closed browser tab: ${action.tabId}`);
    this.activeTabId = state.id;
    return state;
  }

  private async captureSnapshotState(state: TabState): Promise<void> {
    let raw: string;
    try {
      raw = await state.page.locator('body').ariaSnapshot({ timeout: ACTION_TIMEOUT_MS });
    } catch (error) {
      if (isDeadContextError(error) || isPageCrashedError(error)) throw error;
      await state.page.waitForTimeout(400);
      raw = await state.page.locator('body').ariaSnapshot({ timeout: ACTION_TIMEOUT_MS });
    }
    const mainRefs = parseAriaRefs(raw);
    const annotatedParts = [annotateAriaSnapshot(raw, mainRefs)];
    const allRefs = new Map(mainRefs);
    let nextCounter = allRefs.size + 1;

    if (typeof state.page.frames === 'function') {
      try {
        const mainFrame = typeof state.page.mainFrame === 'function' ? state.page.mainFrame() : null;
        const childFrames = state.page.frames().filter(frame => frame !== mainFrame);
        for (const frame of childFrames.slice(0, MAX_IFRAMES_TO_PROCESS)) {
          if (nextCounter > MAX_SNAPSHOT_NODES) break;
          const frameUrl = frame.url();
          if (!frameUrl || frameUrl === 'about:blank' || frameUrl.startsWith('javascript:') || frameUrl.startsWith('data:')) {
            continue;
          }
          if (IFRAME_SKIP_PATTERNS.some(pattern => pattern.test(frameUrl))) continue;
          try {
            const frameYaml = await frame.locator('body').ariaSnapshot({ timeout: IFRAME_SNAPSHOT_TIMEOUT_MS });
            if (!frameYaml || frameYaml.trim().length < 10) continue;
            const frameSeen = new Map<string, number>();
            const frameRefs = new Map<string, BrowserRef>();
            const frameName = frame.name() || undefined;
            for (const line of String(frameYaml).split('\n')) {
              if (nextCounter > MAX_SNAPSHOT_NODES) break;
              const match = line.match(/^\s*-\s+([a-z][\w-]*)(?:\s+"([^"]*)")?/i);
              if (!match) continue;
              const role = (match[1] ?? '').toLowerCase();
              const name = match[2] ?? '';
              if (name && SKIP_PATTERNS.some(pattern => pattern.test(name))) continue;
              if (!INTERACTIVE_ROLES.has(role)) continue;
              const key = `${role}:${name}`;
              const nth = frameSeen.get(key) ?? 0;
              frameSeen.set(key, nth + 1);
              const id = `e${nextCounter++}`;
              const ref: BrowserRef = { role, name, nth, frameUrl, ...(frameName ? { frameName } : {}) };
              frameRefs.set(id, ref);
              allRefs.set(id, ref);
            }
            if (frameRefs.size > 0) {
              const queues = new Map<string, string[]>();
              for (const [id, ref] of frameRefs) {
                const key = `${ref.role}:${ref.name}`;
                queues.set(key, [...(queues.get(key) ?? []), id]);
              }
              const annotatedFrame = String(frameYaml).split('\n').map(line => {
                const match = line.match(/^(\s*-\s+)([a-z][\w-]*)(?:\s+"([^"]*)")?/i);
                if (!match) return line;
                const name = match[3] ?? '';
                const key = `${(match[2] ?? '').toLowerCase()}:${name}`;
                const id = queues.get(key)?.shift();
                return id ? `${line} [${id}]` : line;
              }).join('\n');
              annotatedParts.push(`\n--- iframe: ${frameName || frameUrl} ---\n${annotatedFrame}`);
            }
          } catch {
            // Cross-origin or detached iframe; skip gracefully
          }
        }
      } catch {
        // Ignore frame enumeration errors
      }
    }

    const structure = await extractPageStructure(state.page);
    if (structure) {
      attachStructureRefs(structure, allRefs);
    }

    state.refs = allRefs;
    state.lastSnapshot = annotatedParts.join('\n');
    state.lastStructure = structure;
  }

  private resolveTargetUrl(action: BrowserAction): { targetUrl: string; macroName?: string; macroQuery?: string } {
    if (action.macro) {
      const expanded = expandSearchMacro(action.macro, action.query ?? action.text ?? '');
      if (!expanded) {
        throw new Error(`Unsupported search macro: ${action.macro}. Supported macros: ${getSupportedSearchMacros().join(', ')}`);
      }
      return { targetUrl: expanded, macroName: action.macro, macroQuery: action.query ?? action.text ?? '' };
    }
    if (action.url && action.url.trim().startsWith('@')) {
      const trimmed = action.url.trim();
      const spaceIdx = trimmed.indexOf(' ');
      const macroName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const inlineQuery = spaceIdx === -1 ? (action.query ?? action.text ?? '') : trimmed.slice(spaceIdx + 1).trim();
      const expanded = expandSearchMacro(macroName, inlineQuery);
      if (expanded) {
        return { targetUrl: expanded, macroName, macroQuery: inlineQuery };
      }
    }
    if (!action.url) throw new Error(`${action.type} requires url or macro`);
    return { targetUrl: action.url };
  }

  private async navigate(state: TabState, value: string): Promise<void> {
    const url = await this.validateUrl(value);
    state.runtimeErrors = [];
    const response = await state.page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    const status = response?.status() ?? 0;
    if (status >= 400) throw new Error(`Destination returned HTTP ${status}`);
    await state.page.waitForLoadState('domcontentloaded', { timeout: NAVIGATION_TIMEOUT_MS });
    await this.validateUrl(state.page.url());
    state.refs.clear();
    state.lastSnapshot = '';
    state.lastStructure = null;
  }

  private async preview(state: TabState, filePath: string, workspace: string): Promise<void> {
    state.runtimeErrors = [];
    const previewUrl = await this.workspacePreview.open(workspace, filePath);
    await state.page.goto(previewUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    await state.page.waitForLoadState('domcontentloaded', { timeout: NAVIGATION_TIMEOUT_MS });
    if (state.page.url() !== previewUrl) throw new Error('Preview navigated away from the selected workspace file');
    state.refs.clear();
    state.lastSnapshot = '';
    state.lastStructure = null;
  }

  private async navigateWithMacroFallback(state: TabState, action: BrowserAction): Promise<void> {
    const { targetUrl, macroName, macroQuery } = this.resolveTargetUrl(action);
    if (macroName === '@google_search' && macroQuery) {
      const fallbacks = [
        targetUrl,
        `https://duckduckgo.com/html/?q=${encodeURIComponent(macroQuery)}`,
        `https://www.bing.com/search?q=${encodeURIComponent(macroQuery)}`
      ];
      let lastError: unknown = null;
      for (let i = 0; i < fallbacks.length; i++) {
        try {
          await this.navigate(state, fallbacks[i]!);
          if (i === 0) {
            await state.page.waitForTimeout(200);
            const extracted = await state.page.evaluate<unknown[]>(SEARCH_EXTRACT_SCRIPT).catch(() => []);
            if (Array.isArray(extracted) && extracted.length === 0) {
              const currentUrl = state.page.url();
              if (/google\.[^/]+\/sorry/i.test(currentUrl)) {
                continue;
              }
            }
          }
          return;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) throw lastError;
      return;
    }
    await this.navigate(state, targetUrl);
  }

  private resolveRefFrame(state: TabState, ref: BrowserRef): BrowserPage | BrowserFrame {
    if (!ref.frameName && !ref.frameUrl) return state.page;
    try {
      if (ref.frameName && typeof state.page.frame === 'function') {
        const byName = state.page.frame({ name: ref.frameName });
        if (byName) return byName;
      }
      if (ref.frameUrl && typeof state.page.frames === 'function') {
        const exact = state.page.frames().find(f => f.url() === ref.frameUrl);
        if (exact) return exact;
        const prefix = ref.frameUrl.split('?')[0] ?? '';
        if (prefix) {
          const byPrefix = state.page.frames().find(f => f.url().startsWith(prefix));
          if (byPrefix) return byPrefix;
        }
      }
    } catch {
      // Fall back to main page
    }
    return state.page;
  }

  private async locatorFor(state: TabState, action: BrowserAction): Promise<BrowserLocator> {
    const refId = action.ref ?? (action.index !== undefined ? `e${action.index}` : undefined);
    if (refId) {
      let ref = state.refs.get(refId);
      if (!ref && state.refs.size === 0) {
        await this.captureSnapshotState(state).catch(() => {});
        ref = state.refs.get(refId);
      }
      if (!ref) throw new Error(`Unknown element ref ${refId}. Take a new snapshot before interacting.`);
      const target = this.resolveRefFrame(state, ref);
      return target.getByRole(ref.role, { name: ref.name, exact: true }).nth(ref.nth);
    }
    if (action.selector) {
      const validationErr = selectorValidationError(action.selector);
      if (validationErr) throw new Error(validationErr);
      const visibleCandidate = visibleSelectorCandidate(action.selector);
      if (visibleCandidate) {
        try {
          const candidateLocator = state.page.locator(visibleCandidate);
          if (typeof candidateLocator.count === 'function') {
            const visibleCount = await candidateLocator.count();
            if (visibleCount === 1) {
              return candidateLocator.first();
            }
          }
        } catch {
          // Fall back to standard locator
        }
      }
      return state.page.locator(action.selector).first();
    }
    throw new Error(`${action.type} requires a current ref or selector`);
  }

  private async assertFillable(locator: BrowserLocator): Promise<void> {
    if (typeof locator.evaluate !== 'function') return;
    const check = await locator.evaluate((element: any) => {
      if (!element || !element.tagName) return { ok: true, reason: '' };
      const tag = String(element.tagName).toLowerCase();
      if (tag === 'textarea') return { ok: true, reason: '' };
      if (tag === 'input') {
        const inputType = String(element.getAttribute?.('type') || 'text').toLowerCase();
        const nonFillable = ['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'];
        if (nonFillable.includes(inputType)) {
          return { ok: false, reason: `Cannot type into <input type="${inputType}">. Use click or selectOption instead.` };
        }
        return { ok: true, reason: '' };
      }
      if (element.isContentEditable) return { ok: true, reason: '' };
      const role = String(element.getAttribute?.('role') || '').toLowerCase();
      if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return { ok: true, reason: '' };
      return {
        ok: false,
        reason: `Target <${tag}> is not an editable input, textarea, or contenteditable element.`
      };
    }).catch(() => ({ ok: true, reason: '' }));
    if (!check.ok) {
      throw new Error(check.reason);
    }
  }

  private async performClick(state: TabState, locator: BrowserLocator, doubleClick = false): Promise<void> {
    if (doubleClick && typeof locator.dblclick === 'function') {
      await locator.dblclick({ timeout: ACTION_TIMEOUT_MS });
      return;
    }
    try {
      await locator.click({ timeout: ACTION_TIMEOUT_MS });
    } catch (clickError) {
      const msg = errorMessage(clickError);
      if (msg.includes('intercepts pointer events') || msg.includes('Timeout')) {
        try {
          await locator.click({ timeout: 5_000, force: true });
          return;
        } catch {
          if (
            typeof locator.boundingBox === 'function' &&
            typeof state.page.mouse.move === 'function' &&
            typeof state.page.mouse.down === 'function' &&
            typeof state.page.mouse.up === 'function'
          ) {
            const box = await locator.boundingBox({ timeout: 2_000 }).catch(() => null);
            if (box && box.width > 0 && box.height > 0) {
              const cx = box.x + box.width / 2;
              const cy = box.y + box.height / 2;
              await state.page.mouse.move(cx, cy);
              await state.page.waitForTimeout(30);
              await state.page.mouse.down();
              await state.page.waitForTimeout(30);
              await state.page.mouse.up();
              return;
            }
          }
        }
      }
      throw clickError;
    }
  }

  private async performType(state: TabState, locator: BrowserLocator, action: BrowserAction): Promise<void> {
    if (action.text === undefined) throw new Error(`${action.type} requires text`);
    await this.assertFillable(locator);
    if (action.mode === 'keyboard' && typeof state.page.keyboard.type === 'function') {
      await this.performClick(state, locator, false);
      const delay = Math.max(0, Math.min(500, Number(action.delay ?? 20)));
      await state.page.keyboard.type(action.text, { delay });
    } else {
      await locator.fill(action.text, { timeout: ACTION_TIMEOUT_MS });
    }
    if (action.submit || action.pressEnter) {
      await state.page.keyboard.press('Enter');
    }
  }

  private async performSelectOption(locator: BrowserLocator, value: string): Promise<void> {
    try {
      const selected = await locator.selectOption(value, { timeout: ACTION_TIMEOUT_MS });
      if (!Array.isArray(selected) || selected.length > 0) return;
    } catch {
      // Retry by label
    }
    await locator.selectOption({ label: value }, { timeout: ACTION_TIMEOUT_MS });
  }

  private async performUpload(state: TabState, action: BrowserAction, workspace: string): Promise<BrowserActionResult> {
    const rawPaths = action.filePath ?? action.value;
    if (!rawPaths || (Array.isArray(rawPaths) && rawPaths.length === 0)) {
      throw new Error('upload requires filePath');
    }
    const list = Array.isArray(rawPaths) ? rawPaths : [rawPaths];
    const resolvedFiles: string[] = [];
    for (const item of list) {
      const resolved = path.resolve(workspace, String(item));
      if (!isWithin(workspace, resolved)) {
        throw new Error('Upload file must stay inside the selected workspace');
      }
      const stat = await fs.stat(resolved).catch(() => null);
      if (!stat || !stat.isFile()) {
        throw new Error(`Upload file does not exist or is not a regular file: ${resolved}`);
      }
      resolvedFiles.push(resolved);
    }

    const locator = await this.locatorFor(state, action);
    if (typeof locator.setInputFiles === 'function') {
      try {
        await locator.setInputFiles(resolvedFiles, { timeout: ACTION_TIMEOUT_MS });
        state.refs.clear();
        return {
          action: action.type,
          tabId: state.id,
          url: state.page.url(),
          output: `Uploaded ${resolvedFiles.length} file(s)`
        };
      } catch {
        // Fall through to filechooser event
      }
    }

    const [chooser] = await Promise.all([
      state.page.waitForEvent('filechooser', { timeout: ACTION_TIMEOUT_MS }) as Promise<BrowserFileChooser>,
      this.performClick(state, locator, false)
    ]);
    await chooser.setFiles(resolvedFiles);
    state.refs.clear();
    return {
      action: action.type,
      tabId: state.id,
      url: state.page.url(),
      output: `Uploaded ${resolvedFiles.length} file(s) via file chooser`
    };
  }

  private async saveDownload(state: TabState, action: BrowserAction, workspace: string): Promise<BrowserActionResult> {
    if (!action.outputFile) throw new Error('download requires outputFile');
    const target = path.resolve(workspace, action.outputFile);
    if (!isWithin(workspace, target)) throw new Error('Download target must stay inside the selected workspace');
    const locator = await this.locatorFor(state, action);
    const [download] = await Promise.all([
      state.page.waitForEvent('download', { timeout: NAVIGATION_TIMEOUT_MS }) as Promise<BrowserDownload>,
      this.performClick(state, locator, false)
    ]);
    // outputFile is an explicit file destination. Never let a server-selected
    // filename alter the caller's workspace-scoped target.
    const finalTarget = target;
    const temporary = `${finalTarget}.part-${crypto.randomUUID()}`;
    await fs.mkdir(path.dirname(finalTarget), { recursive: true });
    try {
      await download.saveAs(temporary);
      const failure = await download.failure();
      if (failure) throw new Error(failure);
      const stat = await fs.stat(temporary);
      if (stat.size > MAX_DOWNLOAD_BYTES) throw new Error(`Download exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
      await fs.rename(temporary, finalTarget);
      return { action: action.type, tabId: state.id, url: state.page.url(), output: `Downloaded ${stat.size} bytes to ${finalTarget}` };
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }

  private async saveScreenshot(state: TabState, action: BrowserAction, workspace: string): Promise<BrowserActionResult> {
    if (!action.outputFile) throw new Error('screenshot requires outputFile');
    const target = path.resolve(workspace, action.outputFile);
    if (!isWithin(workspace, target)) throw new Error('Screenshot target must stay inside the selected workspace');
    const extension = path.extname(target).toLowerCase();
    if (!['.png', '.jpg', '.jpeg'].includes(extension)) throw new Error('Screenshot outputFile must end in .png, .jpg, or .jpeg');
    const bytes = await state.page.screenshot({
      fullPage: action.fullPage ?? false,
      type: extension === '.png' ? 'png' : 'jpeg'
    });
    if (bytes.byteLength > MAX_SCREENSHOT_BYTES) throw new Error(`Screenshot exceeds ${MAX_SCREENSHOT_BYTES} bytes`);
    const temporary = `${target}.part-${crypto.randomUUID()}`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.writeFile(temporary, bytes, { mode: 0o600 });
      await fs.rename(temporary, target);
      return { action: action.type, tabId: state.id, url: state.page.url(), output: `Saved ${bytes.byteLength}-byte screenshot to ${target}` };
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }

  private async runAction(action: BrowserAction, workspace = this.workspace): Promise<BrowserActionResult> {
    if (!action || typeof action.type !== 'string') throw new Error('Every browser action needs a type');
    if (action.type === 'newTab' || action.type === 'new_tab') {
      const initialUrl = action.macro
        ? (expandSearchMacro(action.macro, action.query ?? action.text ?? '') ?? undefined)
        : action.url;
      const state = await this.createTab(initialUrl);
      return { action: action.type, tabId: state.id, url: state.page.url(), title: await state.page.title() };
    }
    if (action.type === 'listTabs' || action.type === 'list_tabs') {
      const data = await Promise.all([...this.tabs.values()].filter(tab => !tab.page.isClosed() && !tab.crashed).map(async tab => ({
        tabId: tab.id, active: tab.id === this.activeTabId, url: tab.page.url(), title: await tab.page.title()
      })));
      return { action: action.type, data };
    }
    const requested = this.requestedTab(action);
    const state = requested ?? await this.activeTab();
    if (action.type === 'switchTab' || action.type === 'switch_tab') {
      return { action: action.type, tabId: state.id, url: state.page.url(), title: await state.page.title() };
    }
    if (action.type === 'closeTab' || action.type === 'close_tab') {
      await state.page.close();
      this.tabs.delete(state.id);
      if (this.activeTabId === state.id) this.activeTabId = null;
      return { action: action.type, tabId: state.id, output: 'Tab closed' };
    }
    if (action.type === 'search') {
      const results = await this.search(action.query ?? action.text ?? '');
      const active = await this.activeTab();
      return { action: action.type, tabId: active.id, url: active.page.url(), data: results };
    }
    if (action.type === 'goto' || action.type === 'open' || action.type === 'navigate') {
      await this.navigateWithMacroFallback(state, action);
      return { action: action.type, tabId: state.id, url: state.page.url(), title: await state.page.title() };
    }
    if (action.type === 'preview') {
      if (typeof action.filePath !== 'string') throw new Error('preview requires filePath');
      await this.preview(state, action.filePath, workspace);
      return { action: action.type, tabId: state.id, url: state.page.url(), title: await state.page.title(), output: 'Rendered in an isolated internal preview. This browser-only origin is not user-openable. Start a real local server with sysRunBg if the user needs an interactive URL.' };
    }
    if (action.type === 'snapshot' || action.type === 'scrape') {
      const snapshot = await this.snapshot(action.offset ?? 0);
      return {
        action: action.type,
        tabId: snapshot.tabId,
        url: snapshot.url,
        title: snapshot.title,
        output: snapshot.text + (state.runtimeErrors.length ? `\nRuntime errors: ${state.runtimeErrors.join('; ')}` : ''),
        ...(snapshot.structure ? { structure: snapshot.structure } : {}),
        data: {
          runtimeErrors: [...state.runtimeErrors],
          refsCount: snapshot.refsCount,
          truncated: snapshot.truncated,
          totalChars: snapshot.totalChars,
          nextOffset: snapshot.nextOffset,
          ...(snapshot.structure ? { structure: snapshot.structure } : {})
        }
      };
    }
    if (action.type === 'click' || action.type === 'clickIndex') {
      const locator = await this.locatorFor(state, action);
      await this.performClick(state, locator, Boolean(action.doubleClick));
      state.refs.clear();
      return { action: action.type, tabId: state.id, url: state.page.url(), output: 'Element clicked' };
    }
    if (action.type === 'hover') {
      const locator = await this.locatorFor(state, action);
      if (typeof locator.hover === 'function') {
        await locator.hover({ timeout: ACTION_TIMEOUT_MS });
      } else {
        await this.performClick(state, locator, false);
      }
      return { action: action.type, tabId: state.id, url: state.page.url(), output: 'Element hovered' };
    }
    if (action.type === 'type' || action.type === 'typeIndex' || action.type === 'fill') {
      const locator = await this.locatorFor(state, action);
      await this.performType(state, locator, action);
      return { action: action.type, tabId: state.id, url: state.page.url(), output: 'Text entered' };
    }
    if (action.type === 'selectOption' || action.type === 'select') {
      const value = action.value ?? action.option ?? action.text;
      if (value === undefined) throw new Error(`${action.type} requires value`);
      const locator = await this.locatorFor(state, action);
      await this.performSelectOption(locator, value);
      return { action: action.type, tabId: state.id, url: state.page.url(), output: 'Option selected' };
    }
    if (action.type === 'keyPress' || action.type === 'press') {
      const normalizedKey = normalizeBrowserKey(action.key ?? 'Enter');
      await state.page.keyboard.press(normalizedKey);
      return { action: action.type, tabId: state.id, url: state.page.url(), output: `Pressed ${normalizedKey}` };
    }
    if (action.type === 'scroll') {
      const amount = Math.max(1, Math.min(10_000, Math.floor(action.amount ?? 700)));
      const direction = action.direction ?? 'down';
      const x = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
      const y = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
      await state.page.mouse.wheel(x, y);
      return { action: action.type, tabId: state.id, url: state.page.url(), output: `Scrolled ${direction} ${amount}px` };
    }
    if (action.type === 'wait') {
      const waitTimeout = Math.max(50, Math.min(30_000, Number(action.timeout ?? action.amount ?? 1_000)));
      if (action.selector) {
        const validationErr = selectorValidationError(action.selector);
        if (validationErr) throw new Error(validationErr);
        if (typeof state.page.waitForSelector === 'function') {
          await state.page.waitForSelector(action.selector, { timeout: waitTimeout });
        } else {
          const loc = state.page.locator(action.selector).first();
          if (typeof loc.waitFor === 'function') {
            await loc.waitFor({ timeout: waitTimeout });
          } else {
            await state.page.waitForTimeout(waitTimeout);
          }
        }
      } else {
        if (action.waitForNetwork) {
          await state.page.waitForLoadState('networkidle', { timeout: waitTimeout }).catch(() => {});
        }
        await state.page.evaluate(WAIT_FOR_PAGE_READY_SCRIPT).catch(() => {});
        await state.page.waitForTimeout(Math.min(waitTimeout, 2_000));
      }
      if (action.dismissConsent) {
        await state.page.evaluate(DISMISS_CONSENT_SCRIPT).catch(() => false);
      }
      return { action: action.type, tabId: state.id, url: state.page.url(), output: 'Wait completed' };
    }
    if (action.type === 'viewport') {
      const width = Math.floor(Number(action.width ?? 1280));
      const height = Math.floor(Number(action.height ?? 800));
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 100 || width > 4000 || height < 100 || height > 4000) {
        throw new Error('viewport width and height must be between 100 and 4000 pixels');
      }
      if (typeof state.page.setViewportSize === 'function') {
        await state.page.setViewportSize({ width, height });
      }
      return { action: action.type, tabId: state.id, url: state.page.url(), output: `Viewport set to ${width}x${height}` };
    }
    if (action.type === 'back') {
      try {
        await state.page.goBack({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
      } catch (error) {
        if (!errorMessage(error).includes('NS_BINDING_CANCELLED')) throw error;
      }
    } else if (action.type === 'forward') {
      try {
        await state.page.goForward({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
      } catch (error) {
        if (!errorMessage(error).includes('NS_BINDING_CANCELLED')) throw error;
      }
    } else if (action.type === 'reload' || action.type === 'refresh') {
      await state.page.reload({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    } else if (action.type === 'extract') {
      if (action.schema) {
        const check = validateExtractSchema(action.schema);
        if (!check.ok) throw new Error(`Invalid extract schema: ${check.error}`);
        if (state.refs.size === 0) {
          await this.captureSnapshotState(state);
        }
        const extracted = extractDeterministic({ schema: action.schema, refs: state.refs });
        return {
          action: action.type,
          tabId: state.id,
          url: state.page.url(),
          output: JSON.stringify(extracted),
          data: extracted
        };
      }
      const selector = action.selector ?? 'body';
      const validationErr = selectorValidationError(selector);
      if (validationErr) throw new Error(validationErr);
      const output = boundedText(await state.page.locator(selector).first().innerText({ timeout: ACTION_TIMEOUT_MS }));
      return { action: action.type, tabId: state.id, url: state.page.url(), output };
    } else if (action.type === 'links') {
      if (action.selector) {
        const validationErr = selectorValidationError(action.selector);
        if (validationErr) throw new Error(validationErr);
      }
      const data = await state.page.evaluate(
        LINKS_EXTRACT_SCRIPT,
        { selector: action.selector, offset: action.offset ?? 0, limit: action.limit ?? 50 }
      );
      return { action: action.type, tabId: state.id, url: state.page.url(), data };
    } else if (action.type === 'images') {
      const data = await state.page.evaluate(IMAGES_EXTRACT_SCRIPT, { limit: action.limit ?? 100 });
      return { action: action.type, tabId: state.id, url: state.page.url(), data };
    } else if (action.type === 'upload') {
      return this.performUpload(state, action, workspace);
    } else if (action.type === 'download') {
      return this.saveDownload(state, action, workspace);
    } else if (action.type === 'screenshot') {
      return this.saveScreenshot(state, action, workspace);
    } else {
      throw new Error(`Unsupported browser action: ${action.type}`);
    }
    state.refs.clear();
    return { action: action.type, tabId: state.id, url: state.page.url(), title: await state.page.title() };
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.close(); }, IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }
}

let sharedBrowser: CausyneBrowser | null = null;

export function causyneBrowser(options?: { workspace?: string }): CausyneBrowser {
  sharedBrowser ??= new CausyneBrowser(options);
  if (options?.workspace) {
    sharedBrowser.setWorkspace(options.workspace);
  }
  return sharedBrowser;
}

export async function closeCausyneBrowser(): Promise<void> {
  const browser = sharedBrowser;
  sharedBrowser = null;
  if (browser) await browser.close();
}

export interface BrowserSandboxValidationResult {
  allowed: boolean;
  risk: 'safe' | 'moderate' | 'dangerous' | 'extreme' | 'forbidden';
  reason?: string;
}

const INTERACTIVE_BROWSER_ACTIONS = new Set([
  'click', 'clickIndex',
  'type', 'typeIndex', 'fill',
  'selectOption', 'select',
  'keyPress', 'press',
  'hover',
  'upload'
]);

export function validateBrowserActSandbox(
  args: Record<string, unknown> | undefined,
  workspaceRoot: string,
  isInternalUrl: (url: string) => boolean,
  isPathAllowed: (resolvedPath: string) => boolean
): BrowserSandboxValidationResult {
  const actions = Array.isArray(args?.actions) ? (args.actions as Array<Record<string, unknown>>) : [];
  let hasDownload = false;
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    if (action.type === 'preview') {
      const filePath = typeof action.filePath === 'string' ? action.filePath : '';
      if (!filePath || !/\.html?$/i.test(filePath) || !isPathAllowed(path.resolve(workspaceRoot, filePath))) {
        return { allowed: false, reason: 'Preview requires an HTML file inside the selected workspace', risk: 'forbidden' };
      }
    }
    const rawUrl = typeof action.url === 'string' ? action.url.trim() : '';
    const rawMacro = typeof action.macro === 'string' ? action.macro.trim() : '';
    if (rawMacro) {
      const expanded = expandSearchMacro(rawMacro, typeof action.query === 'string' ? action.query : '');
      if (!expanded || isInternalUrl(expanded)) {
        return { allowed: false, reason: 'Cannot navigate the agent browser to an internal or invalid URL', risk: 'forbidden' };
      }
    }
    if (rawUrl) {
      let urlToCheck = rawUrl;
      if (rawUrl.startsWith('@')) {
        const spaceIdx = rawUrl.indexOf(' ');
        const macroName = spaceIdx === -1 ? rawUrl : rawUrl.slice(0, spaceIdx);
        const query = spaceIdx === -1 ? (typeof action.query === 'string' ? action.query : '') : rawUrl.slice(spaceIdx + 1).trim();
        const expanded = expandSearchMacro(macroName, query);
        if (!expanded) {
          return { allowed: false, reason: 'Cannot navigate the agent browser to an internal or invalid URL', risk: 'forbidden' };
        }
        urlToCheck = expanded;
      }
      if (isInternalUrl(urlToCheck)) {
        return { allowed: false, reason: 'Cannot navigate the agent browser to an internal or invalid URL', risk: 'forbidden' };
      }
    }
    if (action.type === 'download' || action.type === 'screenshot') {
      const out = typeof action.outputFile === 'string' ? action.outputFile : '';
      if (!out || !isPathAllowed(path.resolve(workspaceRoot, out))) {
        return { allowed: false, reason: 'Browser downloads must stay inside the selected workspace', risk: 'forbidden' };
      }
      hasDownload = true;
    }
    if (action.type === 'upload') {
      const rawPaths = action.filePath ?? action.value;
      const list = Array.isArray(rawPaths) ? rawPaths : rawPaths ? [rawPaths] : [];
      if (list.length === 0) {
        return { allowed: false, reason: 'Browser uploads must specify a file inside the selected workspace', risk: 'forbidden' };
      }
      for (const item of list) {
        if (typeof item !== 'string' || !item || !isPathAllowed(path.resolve(workspaceRoot, item))) {
          return { allowed: false, reason: 'Browser uploads must stay inside the selected workspace', risk: 'forbidden' };
        }
      }
    }
  }
  if (hasDownload) {
    return { allowed: true, risk: 'extreme', reason: 'Writes browser content to the selected workspace' };
  }
  if (actions.some(action => typeof action?.type === 'string' && INTERACTIVE_BROWSER_ACTIONS.has(action.type))) {
    return { allowed: true, risk: 'dangerous', reason: 'Interacts with a website through the dedicated agent browser' };
  }
  return { allowed: true, risk: 'safe' };
}
