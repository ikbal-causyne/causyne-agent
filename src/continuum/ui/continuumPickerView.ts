/**
 * Causyne Continuum: provider-aware, keyboard-operated session browser.
 * This is a presentation-only layer over the existing SelectLayer/SelectList.
 * No adapter, journal, tool policy or adoption behavior is changed here.
 */
// @ts-expect-error The existing dialog component is implemented in JavaScript.
import { SelectLayer } from '../../tui/dialogs.js';
// @ts-expect-error The existing theme is implemented in JavaScript.
import { bold, dim, paint, GLYPHS } from '../../tui/theme.js';
import { safeDisplay, truncate, visibleWidth } from '../../tui/text.js';
import type { AgentPlatform, ContinuumSessionSummary } from '../types.js';

export interface ContinuumPickerItem {
  label: string;
  category: string;
  description: string;
  searchText: string;
  hint?: string;
  value: ContinuumSessionSummary;
}

export interface ContinuumPickerViewOptions {
  sessions: ContinuumPickerItem[];
  onPick: (item: ContinuumPickerItem | null) => void;
  onPreview?: (session: ContinuumSessionSummary) => void;
}

interface KeyEvent {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  sequence?: string;
  text?: string;
}

interface FilteredEntry { item: ContinuumPickerItem; }
interface ListWindow {
  rows: string[];
  firstIndex: number;
  lastIndex: number;
  itemCount: number;
}

const MAX_PANEL_HEIGHT = 34;
const MIN_DETAIL_WIDTH = 46;
const SOURCE_ORDER: AgentPlatform[] = [
  'codex', 'antigravity', 'opencode', 'claude_code', 'causyne', 'cursor'
];
const PLATFORM_NAMES: Record<AgentPlatform, string> = {
  codex: 'Codex',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  claude_code: 'Claude Code',
  causyne: 'Causyne',
  cursor: 'Cursor'
};

type Scope = AgentPlatform | 'all';

function clean(value: unknown): string {
  // safeDisplay strips control sequences that could corrupt a terminal frame.
  return safeDisplay(String(value ?? '')).replace(/\s+/g, ' ').trim();
}

function shortWorkspace(value: string): string {
  const path = clean(value).replace(/\\/g, '/').replace(/\/+$/, '');
  if (!path) return 'Unknown workspace';
  const parts = path.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
}

function relativeTime(timestamp: number, now: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'unknown';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d`;
  return `${Math.floor(seconds / (7 * 86400))}w`;
}

function countLabel(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '0 msgs';
  return `${Math.floor(count).toLocaleString('en-US')} ${count === 1 ? 'msg' : 'msgs'}`;
}

/** Fit two pieces of styled text in one terminal row, retaining the left title. */
function pairedRow(left: string, right: string, columns: number): string {
  const width = Math.max(1, Math.floor(columns));
  const rightWidth = visibleWidth(right);
  if (!right || width < 45 || rightWidth > width - 20) return truncate(left, width, '…');
  const title = truncate(left, Math.max(1, width - rightWidth - 2), '…');
  return title + ' '.repeat(Math.max(1, width - visibleWidth(title) - rightWidth)) + right;
}

function sourceName(value: ContinuumSessionSummary): string {
  return clean(value.sourceLabel) || PLATFORM_NAMES[value.sourcePlatform] || 'Other';
}

/**
 * Group by agent with recency inside each source. A stable tie-breaker means
 * the selected session never jumps unpredictably between redraws.
 */
export function sortContinuumItems(items: ContinuumPickerItem[]): ContinuumPickerItem[] {
  const order = new Map(SOURCE_ORDER.map((platform, index) => [platform, index]));
  return [...items].sort((a, b) => {
    const groupA = order.get(a.value.sourcePlatform) ?? SOURCE_ORDER.length;
    const groupB = order.get(b.value.sourcePlatform) ?? SOURCE_ORDER.length;
    return groupA - groupB
      || (Number(b.value.updatedAt) || 0) - (Number(a.value.updatedAt) || 0)
      || a.value.id.localeCompare(b.value.id);
  });
}

function renderedItem(
  item: ContinuumPickerItem, selected: boolean, width: number, now: number
): string[] {
  const title = clean(item.value.title) || 'Untitled session';
  const prefix = selected ? ` ${paint('accent', '▸')} ` : '   ';
  const stats = dim(`${countLabel(item.value.messageCount)}  ${GLYPHS.dot}  ${relativeTime(item.value.updatedAt, now)}`);
  const headline = pairedRow(
    prefix + (selected ? bold(paint('ink', title)) : paint('ink', title)), stats, width
  );
  const workspace = clean(item.value.workspacePath);
  const sub = `   ${dim(shortWorkspace(workspace))}`;
  return [truncate(headline, width, '…'), truncate(sub, width, '…')];
}

/**
 * Render a viewport of category headings + TWO-row session entries.
 * Headers never occupy the only remaining row; selected items stay visible.
 */
export function renderContinuumWindow(
  entries: FilteredEntry[], start: number, selected: number,
  width: number, budget: number, now = Date.now()
): ListWindow {
  const rows: string[] = [];
  const safeWidth = Math.max(1, Math.floor(width));
  const allowed = Math.max(0, Math.floor(budget));
  let lastIndex = start - 1;
  let itemCount = 0;
  let previousGroup: string | null = null;
  for (let index = start; index < entries.length; index++) {
    const item = entries[index]?.item;
    if (!item) continue;
    const group = sourceName(item.value);
    const needHeader = group !== previousGroup;
    const needed = 2 + (needHeader ? 1 : 0);
    if (rows.length + needed > allowed) {
      // With only two rows remaining, show the item without an orphaned header.
      if (!(needHeader && rows.length + 2 <= allowed)) break;
    } else if (needHeader) {
      rows.push(dim(`   ${truncate(group.toUpperCase(), Math.max(1, safeWidth - 5), '…')}`));
    }
    rows.push(...renderedItem(item, index === selected, safeWidth, now));
    lastIndex = index;
    itemCount++;
    previousGroup = group;
  }
  return { rows, firstIndex: start, lastIndex, itemCount };
}

export class ContinuumPickerLayer extends SelectLayer {
  // Inherited instance fields from the existing JavaScript SelectLayer.
  declare list: {
    all: ContinuumPickerItem[];
    filtered: FilteredEntry[];
    selected: number;
    offset: number;
    query: string;
    current: ContinuumPickerItem | null;
    lastItemRows?: number;
    setItems(items: ContinuumPickerItem[]): void;
    moveTo(index: number, visibleRows: number): void;
    refilter(): void;
  };
  declare cursor: { x: number; y: number } | null;
  private readonly items: ContinuumPickerItem[];
  private readonly scopes: Scope[];
  private readonly onPreview: ((session: ContinuumSessionSummary) => void) | undefined;
  private scopeIndex = 0;
  private visibleItems = 5;

  constructor(options: ContinuumPickerViewOptions) {
    const items = sortContinuumItems(options.sessions);
    super({
      title: `Continuum  ·  ${items.length} recent cross-agent sessions`,
      width: 112,
      height: MAX_PANEL_HEIGHT,
      footer: `↑↓ move  ${GLYPHS.dot}  tab source  ${GLYPHS.dot}  F2 preview  ${GLYPHS.dot}  enter adopt  ${GLYPHS.dot}  esc close`,
      placeholder: 'Search sessions, projects, or IDs',
      emptyText: 'No matching sessions',
      items,
      onPick: options.onPick
    });
    this.items = items;
    this.scopes = ['all', ...SOURCE_ORDER.filter(platform =>
      items.some(item => item.value.sourcePlatform === platform))];
    this.onPreview = options.onPreview;
  }

  get scope(): Scope { return this.scopes[this.scopeIndex] ?? 'all'; }
  get availableScopes(): readonly Scope[] { return this.scopes; }

  preferredHeight(): number {
    // No fixed 34-row empty frame when the machine has only a few sessions.
    const items = this.list.filtered.length;
    const categories = new Set(this.list.filtered.map(({ item }: FilteredEntry) => sourceName(item.value))).size;
    return Math.min(MAX_PANEL_HEIGHT, Math.max(12, 3 + 4 + 2 + items * 2 + categories));
  }

  private setScope(direction: number): void {
    const oldId = this.list.current?.value.id;
    this.scopeIndex = (this.scopeIndex + direction + this.scopes.length) % this.scopes.length;
    const scope = this.scope;
    const chosen = scope === 'all' ? this.items :
      this.items.filter(item => item.value.sourcePlatform === scope);
    const query = this.list.query;
    this.list.setItems(chosen);
    this.list.query = query;
    this.list.refilter();
    const preserved = this.list.filtered.findIndex(({ item }: FilteredEntry) => item.value.id === oldId);
    this.list.selected = preserved >= 0 ? preserved : 0;
    this.list.offset = 0;
  }

  key(event: KeyEvent | null): string | null {
    if (!event) return null;
    if (event.name === 'tab') {
      this.setScope(event.shift ? -1 : 1);
      return 'handled';
    }
    if (event.name === 'f2') {
      const current = this.list.current;
      if (current && this.onPreview) this.onPreview(current.value);
      return 'handled';
    }
    if (event.name === 'pageup' || event.name === 'pagedown') {
      const direction = event.name === 'pageup' ? -1 : 1;
      this.list.moveTo(this.list.selected + direction * Math.max(1, this.visibleItems - 1),
        Math.max(1, this.visibleItems));
      return 'handled';
    }
    const query = this.list.query;
    const result = super.key(event);
    if (this.list.query !== query) {
      this.list.selected = 0;
      this.list.offset = 0;
    }
    return result;
  }

  body(width: number, height: number): string[] {
    const w = Math.max(8, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    const rows: string[] = [];
    const scope = this.scope;
    const label = scope === 'all' ? 'ALL SOURCES' : PLATFORM_NAMES[scope];
    const filtered = this.list.filtered;
    const count = filtered.length;
    const total = this.items.length;
    const narrow = w < MIN_DETAIL_WIDTH;

    const sourceText = `  ${paint('accent', label.toUpperCase())}`;
    rows.push(pairedRow(sourceText,
      w >= 49 ? dim(`${count} / ${total} sessions   ${this.scopeIndex + 1}/${this.scopes.length} sources`) : '', w));

    const lead = `  ${paint('accent', GLYPHS.arrow)} `;
    const room = Math.max(1, w - visibleWidth(lead) - 1);
    const query = clean(this.list.query);
    let tail = query;
    while (visibleWidth(tail) > room) tail = [...tail].slice(1).join('');
    const shown = tail || dim(narrow ? 'Search sessions...' : 'Search by title, project, provider, or ID...');
    rows.push(lead + truncate(shown, room, '…'));
    this.cursor = { x: Math.min(w - 1, visibleWidth(lead) + visibleWidth(tail)), y: 1 };
    rows.push(paint('rule', '─'.repeat(w)));

    // Small terminals favor visible list navigation over the detail inspector.
    const details = h >= 18 ? 5 : h >= 12 ? 3 : h >= 9 ? 1 : 0;
    const budget = Math.max(0, h - 3 - details);
    if (budget > 0 && count === 0) {
      rows.push('');
      if (rows.length < h - details) rows.push(dim('  No sessions match this filter.'));
      if (rows.length < h - details) rows.push(dim('  Tab changes source. Ctrl+U clears search.'));
    } else if (budget > 0) {
      const selected = Math.min(Math.max(0, this.list.selected), count - 1);
      let from = Math.min(Math.max(0, this.list.offset), selected);
      let output = renderContinuumWindow(filtered, from, selected, w, budget);
      while (output.lastIndex < selected && from < selected) {
        from++;
        output = renderContinuumWindow(filtered, from, selected, w, budget);
      }
      this.list.offset = from;
      this.visibleItems = Math.max(1, output.itemCount);
      this.list.lastItemRows = Math.max(1, this.visibleItems);
      rows.push(...output.rows);
    }
    while (rows.length < h - details) rows.push('');

    const selected = this.list.current?.value;
    if (details > 0) {
      rows.push(paint('rule', '─'.repeat(w)));
    }
    if (details >= 3) {
      const heading = selected ? `  ${sourceName(selected)}` : '  No session selected';
      const countText = selected ? dim(countLabel(selected.messageCount)) : '';
      rows.push(pairedRow(heading, countText, w));
      rows.push(dim('  ' + truncate(selected ? shortWorkspace(selected.workspacePath) : 'Change the source or search query.',
        Math.max(1, w - 3), '…')));
    }
    if (details >= 5) {
      const snippet = selected ? clean(selected.snippet) : '';
      rows.push(dim('  ' + truncate(snippet || 'No excerpt available', Math.max(1, w - 3), '…')));
      const id = selected ? clean(selected.id) : '';
      rows.push(dim('  ' + truncate(id || 'No session ID', Math.max(1, w - 3), '…')));
    }
    while (rows.length < h) rows.push('');
    return rows.slice(0, h).map(row => truncate(row, w, '…'));
  }
}
