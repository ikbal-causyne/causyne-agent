import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

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
const IDLE_CLOSE_MS = 10 * 60_000;
const MAX_SEARCH_RESULTS = 10;
const MAX_EXTRACT_CHARS = 80_000;
const MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;
const INTERACTIVE_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'link', 'menuitem', 'option', 'radio',
  'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem'
]);

interface BrowserLocator {
  first(): BrowserLocator;
  nth(index: number): BrowserLocator;
  click(options?: Record<string, unknown>): Promise<void>;
  fill(value: string, options?: Record<string, unknown>): Promise<void>;
  press(key: string, options?: Record<string, unknown>): Promise<void>;
  selectOption(value: string, options?: Record<string, unknown>): Promise<unknown>;
  innerText(options?: Record<string, unknown>): Promise<string>;
  ariaSnapshot(options?: Record<string, unknown>): Promise<string>;
}

interface BrowserDownload {
  suggestedFilename(): string;
  saveAs(target: string): Promise<void>;
  failure(): Promise<string | null>;
}

interface BrowserRoute {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

interface BrowserPage {
  isClosed(): boolean;
  url(): string;
  title(): Promise<string>;
  goto(url: string, options?: Record<string, unknown>): Promise<{ status(): number; headers(): Record<string, string> } | null>;
  waitForLoadState(state: string, options?: Record<string, unknown>): Promise<void>;
  waitForTimeout(milliseconds: number): Promise<void>;
  waitForEvent(event: 'download', options?: Record<string, unknown>): Promise<BrowserDownload>;
  locator(selector: string): BrowserLocator;
  getByRole(role: string, options?: Record<string, unknown>): BrowserLocator;
  evaluate<T>(expression: string, argument?: unknown): Promise<T>;
  route(pattern: string, handler: (route: BrowserRoute) => Promise<void>): Promise<void>;
  setDefaultTimeout(milliseconds: number): void;
  goBack(options?: Record<string, unknown>): Promise<unknown>;
  goForward(options?: Record<string, unknown>): Promise<unknown>;
  reload(options?: Record<string, unknown>): Promise<unknown>;
  screenshot(options?: Record<string, unknown>): Promise<Buffer>;
  close(): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  mouse: { wheel(deltaX: number, deltaY: number): Promise<void> };
}

interface BrowserSession {
  newPage(): Promise<BrowserPage>;
  pages(): BrowserPage[];
  close(): Promise<void>;
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
}

interface TabState {
  id: string;
  page: BrowserPage;
  refs: Map<string, BrowserRef>;
  lastSnapshot: string;
}

export type BrowserAction = {
  type: 'newTab' | 'switchTab' | 'listTabs' | 'closeTab' | 'search' | 'goto' | 'snapshot' | 'scrape'
    | 'click' | 'clickIndex' | 'type' | 'typeIndex' | 'selectOption' | 'keyPress' | 'scroll'
    | 'back' | 'forward' | 'reload' | 'extract' | 'download' | 'screenshot';
  tabId?: string;
  url?: string;
  query?: string;
  ref?: string;
  index?: number;
  selector?: string;
  text?: string;
  value?: string;
  key?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  offset?: number;
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
    if (counter > 500) break;
    const match = line.match(/^\s*-\s+([a-z][\w-]*)(?:\s+"([^"]*)")?/i);
    if (!match) continue;
    const role = (match[1] ?? '').toLowerCase();
    if (!INTERACTIVE_ROLES.has(role)) continue;
    const name = match[2] ?? '';
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
    const key = `${ref.role}:${ref.name}`;
    queues.set(key, [...(queues.get(key) ?? []), id]);
  }
  return String(snapshot ?? '').split('\n').map(line => {
    const match = line.match(/^(\s*-\s+)([a-z][\w-]*)(?:\s+"([^"]*)")?/i);
    if (!match) return line;
    const key = `${(match[2] ?? '').toLowerCase()}:${match[3] ?? ''}`;
    const id = queues.get(key)?.shift();
    return id ? `${line} [${id}]` : line;
  }).join('\n');
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

export class CausyneBrowser {
  private readonly workspace: string;
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

  async run(actions: BrowserAction[]): Promise<BrowserActionResult[]> {
    if (!Array.isArray(actions) || actions.length === 0 || actions.length > 40) {
      throw new Error('Browser actions must contain between 1 and 40 operations');
    }
    await this.start();
    const results: BrowserActionResult[] = [];
    for (const action of actions) results.push(await this.runAction(action));
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

  async snapshot(offset = 0): Promise<SnapshotWindow & { tabId: string; url: string; title: string; refsCount: number }> {
    await this.start();
    const state = await this.activeTab();
    const raw = await state.page.locator('body').ariaSnapshot({ timeout: ACTION_TIMEOUT_MS });
    state.refs = parseAriaRefs(raw);
    state.lastSnapshot = annotateAriaSnapshot(raw, state.refs);
    return {
      ...windowSnapshot(state.lastSnapshot, offset),
      tabId: state.id,
      url: state.page.url(),
      title: await state.page.title(),
      refsCount: state.refs.size
    };
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const session = this.session;
    this.session = null;
    this.starting = null;
    this.tabs.clear();
    this.activeTabId = null;
    this.contextRouteInstalled = false;
    this.securedPages = new WeakSet<object>();
    this.pageStates = new WeakMap<object, TabState>();
    if (session) await session.close().catch(() => {});
  }

  private async start(): Promise<void> {
    if (this.session) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const verdict = await this.ensureBrowserCapability();
      if (!verdict.ok) throw new BrowserCapabilityError(verdict.reason ?? 'Browser capability is unavailable', verdict.requiresConsent);
      const runtime = this.resolveRuntime();
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
        enable_cache: true
      });
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
    const state: TabState = { id, page, refs: new Map(), lastSnapshot: '' };
    this.pageStates.set(page, state);
    this.tabs.set(id, state);
    this.activeTabId = id;
    return state;
  }

  private async guardRoute(route: BrowserRoute): Promise<void> {
    const url = route.request().url();
    if (/^(about:|data:|blob:|moz-extension:)/i.test(url)) return route.continue();
    try {
      const parsed = new URL(url);
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
    const state = await this.registerPage(await this.session.newPage());
    if (url) await this.navigate(state, url);
    return state;
  }

  private async activeTab(): Promise<TabState> {
    const active = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
    if (active && !active.page.isClosed()) return active;
    return this.createTab();
  }

  private requestedTab(action: BrowserAction): TabState | null {
    if (!action.tabId) return null;
    const state = this.tabs.get(action.tabId);
    if (!state || state.page.isClosed()) throw new Error(`Unknown or closed browser tab: ${action.tabId}`);
    this.activeTabId = state.id;
    return state;
  }

  private async navigate(state: TabState, value: string): Promise<void> {
    const url = await this.validateUrl(value);
    const response = await state.page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    const status = response?.status() ?? 0;
    if (status >= 400) throw new Error(`Destination returned HTTP ${status}`);
    await state.page.waitForLoadState('domcontentloaded', { timeout: NAVIGATION_TIMEOUT_MS });
    await this.validateUrl(state.page.url());
    state.refs.clear();
    state.lastSnapshot = '';
  }

  private locatorFor(state: TabState, action: BrowserAction): BrowserLocator {
    const refId = action.ref ?? (action.index !== undefined ? `e${action.index}` : undefined);
    if (refId) {
      const ref = state.refs.get(refId);
      if (!ref) throw new Error(`Unknown element ref ${refId}. Take a new snapshot before interacting.`);
      return state.page.getByRole(ref.role, { name: ref.name, exact: true }).nth(ref.nth);
    }
    if (action.selector) return state.page.locator(action.selector).first();
    throw new Error(`${action.type} requires a current ref or selector`);
  }

  private async saveDownload(state: TabState, action: BrowserAction): Promise<BrowserActionResult> {
    if (!action.outputFile) throw new Error('download requires outputFile');
    const target = path.resolve(this.workspace, action.outputFile);
    if (!isWithin(this.workspace, target)) throw new Error('Download target must stay inside the selected workspace');
    const locator = this.locatorFor(state, action);
    const [download] = await Promise.all([
      state.page.waitForEvent('download', { timeout: NAVIGATION_TIMEOUT_MS }),
      locator.click({ timeout: ACTION_TIMEOUT_MS })
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

  private async saveScreenshot(state: TabState, action: BrowserAction): Promise<BrowserActionResult> {
    if (!action.outputFile) throw new Error('screenshot requires outputFile');
    const target = path.resolve(this.workspace, action.outputFile);
    if (!isWithin(this.workspace, target)) throw new Error('Screenshot target must stay inside the selected workspace');
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

  private async runAction(action: BrowserAction): Promise<BrowserActionResult> {
    if (!action || typeof action.type !== 'string') throw new Error('Every browser action needs a type');
    if (action.type === 'newTab') {
      const state = await this.createTab(action.url);
      return { action: action.type, tabId: state.id, url: state.page.url(), title: await state.page.title() };
    }
    if (action.type === 'listTabs') {
      const data = await Promise.all([...this.tabs.values()].filter(tab => !tab.page.isClosed()).map(async tab => ({
        tabId: tab.id, active: tab.id === this.activeTabId, url: tab.page.url(), title: await tab.page.title()
      })));
      return { action: action.type, data };
    }
    const requested = this.requestedTab(action);
    const state = requested ?? await this.activeTab();
    if (action.type === 'switchTab') return { action: action.type, tabId: state.id, url: state.page.url(), title: await state.page.title() };
    if (action.type === 'closeTab') {
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
    if (action.type === 'goto') {
      if (!action.url) throw new Error('goto requires url');
      await this.navigate(state, action.url);
      return { action: action.type, tabId: state.id, url: state.page.url(), title: await state.page.title() };
    }
    if (action.type === 'snapshot' || action.type === 'scrape') {
      const snapshot = await this.snapshot(action.offset ?? 0);
      return { action: action.type, tabId: snapshot.tabId, url: snapshot.url, title: snapshot.title, output: snapshot.text, data: {
        refsCount: snapshot.refsCount, truncated: snapshot.truncated, totalChars: snapshot.totalChars, nextOffset: snapshot.nextOffset
      } };
    }
    if (action.type === 'click' || action.type === 'clickIndex') {
      await this.locatorFor(state, action).click({ timeout: ACTION_TIMEOUT_MS });
      state.refs.clear();
      return { action: action.type, tabId: state.id, url: state.page.url(), output: 'Element clicked' };
    }
    if (action.type === 'type' || action.type === 'typeIndex') {
      if (action.text === undefined) throw new Error(`${action.type} requires text`);
      await this.locatorFor(state, action).fill(action.text, { timeout: ACTION_TIMEOUT_MS });
      return { action: action.type, tabId: state.id, url: state.page.url(), output: 'Text entered' };
    }
    if (action.type === 'selectOption') {
      const value = action.value ?? action.text;
      if (value === undefined) throw new Error('selectOption requires value');
      await this.locatorFor(state, action).selectOption(value, { timeout: ACTION_TIMEOUT_MS });
      return { action: action.type, tabId: state.id, url: state.page.url(), output: 'Option selected' };
    }
    if (action.type === 'keyPress') {
      await state.page.keyboard.press(action.key ?? 'Enter');
      return { action: action.type, tabId: state.id, url: state.page.url(), output: `Pressed ${action.key ?? 'Enter'}` };
    }
    if (action.type === 'scroll') {
      const amount = Math.max(1, Math.min(10_000, Math.floor(action.amount ?? 700)));
      const direction = action.direction ?? 'down';
      const x = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
      const y = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
      await state.page.mouse.wheel(x, y);
      return { action: action.type, tabId: state.id, url: state.page.url(), output: `Scrolled ${direction} ${amount}px` };
    }
    if (action.type === 'back') await state.page.goBack({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    else if (action.type === 'forward') await state.page.goForward({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    else if (action.type === 'reload') await state.page.reload({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    else if (action.type === 'extract') {
      const selector = action.selector ?? 'body';
      const output = boundedText(await state.page.locator(selector).first().innerText({ timeout: ACTION_TIMEOUT_MS }));
      return { action: action.type, tabId: state.id, url: state.page.url(), output };
    } else if (action.type === 'download') return this.saveDownload(state, action);
    else if (action.type === 'screenshot') return this.saveScreenshot(state, action);
    else throw new Error(`Unsupported browser action: ${action.type}`);
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

export function causyneBrowser(): CausyneBrowser {
  sharedBrowser ??= new CausyneBrowser();
  return sharedBrowser;
}

export async function closeCausyneBrowser(): Promise<void> {
  const browser = sharedBrowser;
  sharedBrowser = null;
  if (browser) await browser.close();
}
