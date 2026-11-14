/**
 * Causyne Agent /sessions: session-specific presentation on the existing modal stack.
 * No changes to the session store, approval policy or the shared SelectList.
 */
import path from 'node:path';
// @ts-expect-error The existing dialog component is authored in JavaScript.
import { SelectLayer } from './dialogs.js';
// @ts-expect-error The theme is authored in JavaScript.
import { bold, dim, paint, GLYPHS } from './theme.js';
import { safeDisplay, truncate, visibleWidth } from './text.js';
import type { SessionPickerItem } from './sessionPicker.js';

export interface SessionPickerViewOptions {
  items: SessionPickerItem[];
  currentWorkspace: string;
  activeId: string | null;
  onPick: (item: SessionPickerItem | null) => void;
}

type SessionScope = 'all' | 'workspace';
type Key = { name?: string; ctrl?: boolean; sequence?: string; text?: string } | null;

const INNER_HEADER_ROWS = 3;  // scope, search, divider
const INNER_DETAIL_ROWS = 3;  // divider, selected title, metadata
const MAX_PANEL_HEIGHT = 28;

function clean(value: unknown): string {
  return safeDisplay(typeof value === 'string' ? value : String(value ?? ''));
}

function sameWorkspace(first: string | undefined, second: string): boolean {
  if (!first || !second) return false;
  const a = path.resolve(first);
  const b = path.resolve(second);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function rowPair(left: string, right: string, width: number): string {
  const room = Math.max(0, Math.floor(width));
  const rightWidth = visibleWidth(right);
  if (rightWidth >= room - 5) return truncate(left, room, '…');
  const safeLeft = truncate(left, Math.max(0, room - rightWidth - 2), '…');
  return safeLeft + ' '.repeat(Math.max(1, room - visibleWidth(safeLeft) - rightWidth)) + right;
}

function itemTitle(item: SessionPickerItem): string {
  if (item.value.type === 'new') return 'New session';
  if (item.value.type === 'fork') return 'Fork current session';
  return clean(item.value.title || item.label).replace(/\s*\[active\]\s*$/, '');
}

function shortTime(item: SessionPickerItem): string {
  const timestamp = item.value.updatedAt;
  if (!Number.isFinite(timestamp)) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - Number(timestamp)) / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

function actionOrSessionText(item: SessionPickerItem, selected: boolean, width: number): string {
  const isAction = item.value.type !== 'switch';
  const marker = selected ? paint('accent', GLYPHS.arrow) : ' ';
  const leftPrefix = ` ${marker} `;
  const rawName = itemTitle(item);
  const right = isAction
    ? dim(item.value.type === 'new' ? 'create' : 'branch')
    : dim(`${item.value.messageCount ?? 0} msgs  ${GLYPHS.dot}  ${shortTime(item)}${item.value.isCurrent ? '  ACTIVE' : ''}`);
  const available = Math.max(1, width - visibleWidth(leftPrefix) - 1);
  // Keep titles legible on small terminals instead of allowing metadata to eat them.
  const showMeta = available >= 42;
  const usableRight = showMeta ? right : '';
  const titleBudget = Math.max(1, available - (showMeta ? visibleWidth(usableRight) + 2 : 0));
  const name = truncate(rawName, titleBudget, '…');
  const styledName = selected ? bold(paint('ink', name)) : paint('ink', name);
  return rowPair(leftPrefix + styledName, usableRight, width);
}

interface ListWindow { rows: string[]; lastIndex: number; }

/**
 * Category headers are terminal rows, not selectable items. This window is
 * measured in *actual rows*, preventing selection disappearing at group edges.
 */
export function renderSessionRows(
  entries: Array<{ item: SessionPickerItem }>,
  start: number,
  selected: number,
  width: number,
  budget: number
): ListWindow {
  const rows: string[] = [];
  const safeStart = Number.isFinite(start) ? Math.max(0, Math.floor(start)) : 0;
  const safeWidth = Number.isFinite(width) ? Math.max(4, Math.floor(width)) : 60;
  const safeBudget = budget === Number.POSITIVE_INFINITY
    ? entries.length
    : (Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0);
  let lastIndex = safeStart - 1;
  let previousCategory: string | null = null;
  for (let i = safeStart; i < entries.length && rows.length < safeBudget; i++) {
    const item = entries[i]!.item;
    const category = clean(item.category || 'Sessions');
    const isNewGroup = category !== previousCategory;
    // Avoid leaving an orphaned header in the final available row.
    if (isNewGroup && safeBudget - rows.length >= 2) {
      rows.push(dim(`  ${truncate(category.toUpperCase(), Math.max(1, safeWidth - 4), '…')}`));
    } else if (isNewGroup && rows.length > 0) {
      break;
    }
    if (rows.length >= safeBudget) break;
    rows.push(actionOrSessionText(item, i === selected, safeWidth));
    lastIndex = i;
    previousCategory = category;
  }
  return { rows, lastIndex };
}

export class SessionPickerLayer extends SelectLayer {
  // SelectLayer is currently an untyped JavaScript class in the repository.
  // Declare the inherited API used here without introducing runtime fields.
  declare list: {
    all: SessionPickerItem[];
    filtered: Array<{ item: SessionPickerItem }>;
    selected: number;
    offset: number;
    query: string;
    current: SessionPickerItem | null;
    lastItemRows?: number;
    setItems(items: SessionPickerItem[]): void;
    moveTo(index: number, visibleRows: number): void;
  };
  declare cursor: { x: number; y: number } | null;
  readonly currentWorkspace: string;
  readonly activeId: string | null;
  readonly allItems: SessionPickerItem[];
  scope: SessionScope = 'all';

  constructor(options: SessionPickerViewOptions) {
    super({
      title: `Sessions  ${options.items.filter(i => i.value.type === 'switch').length}`,
      width: 100,
      height: MAX_PANEL_HEIGHT,
      items: options.items,
      placeholder: 'Search sessions by title, ID or workspace',
      emptyText: 'No matching sessions',
      footer: `↑↓ navigate  ${GLYPHS.dot}  enter open  ${GLYPHS.dot}  tab workspace  ${GLYPHS.dot}  esc close`,
      onPick: options.onPick
    });
    this.allItems = options.items;
    this.currentWorkspace = options.currentWorkspace;
    this.activeId = options.activeId;
  }

  preferredHeight(): number {
    // Modals with a few sessions do not retain a large blank area.
    const distinctGroups = new Set(this.list.filtered.map((entry: { item: SessionPickerItem }) => entry.item.category));
    const content = this.list.filtered.length + distinctGroups.size;
    return Math.min(MAX_PANEL_HEIGHT, Math.max(12, content + INNER_HEADER_ROWS + INNER_DETAIL_ROWS + 2));
  }

  private countSessions(): number {
    return this.list.filtered.filter((entry: { item: SessionPickerItem }) => entry.item.value.type === 'switch').length;
  }

  private toggleWorkspace(): void {
    const oldId = (this.list.current as SessionPickerItem | null)?.id;
    this.scope = this.scope === 'all' ? 'workspace' : 'all';
    const scoped = this.scope === 'all'
      ? this.allItems
      : this.allItems.filter(item => item.value.type !== 'switch' ||
          sameWorkspace(item.value.workspace, this.currentWorkspace));
    this.list.setItems(scoped);
    const next = this.list.filtered.findIndex((entry: { item: SessionPickerItem }) => entry.item.id === oldId);
    const firstSession = this.list.filtered.findIndex((entry: { item: SessionPickerItem }) => entry.item.value.type === 'switch');
    this.list.selected = next >= 0 ? next : Math.max(0, firstSession);
    this.list.offset = 0;
  }

  key(event: Key): string | null {
    if (event?.name === 'tab') {
      this.toggleWorkspace();
      return 'handled';
    }
    const previousQuery = this.list.query;
    const result = super.key(event);
    if (this.list.query !== previousQuery) {
      this.list.selected = 0;
      this.list.offset = 0;
    }
    return result;
  }

  body(width: number, height: number): string[] {
    const w = Math.max(12, Number.isFinite(width) ? Math.floor(width) : 60);
    const h = Math.max(1, Number.isFinite(height) ? Math.floor(height) : 20);
    const rows: string[] = [];
    const scopeLabel = this.scope === 'all' ? 'ALL WORKSPACES' : 'THIS WORKSPACE';
    const total = this.allItems.filter(item => item.value.type === 'switch').length;
    const count = this.countSessions();

    rows.push(rowPair(`  ${paint('accent', scopeLabel)}`, w >= 52 ? dim(`${count} / ${total} sessions`) : '', w));
    const query = String(this.list.query || '');
    const lead = `  ${paint('accent', GLYPHS.arrow)} `;
    const maxInput = Math.max(1, w - visibleWidth(lead) - 1);
    // Show the tail of long queries without splitting UTF-16 surrogate pairs.
    const runes = Array.from(query);
    while (runes.length > 0 && visibleWidth(runes.join('')) > maxInput) runes.shift();
    const visibleQuery = runes.join('');
    const shown = query ? clean(visibleQuery) : dim('Search by title, workspace or ID…');
    rows.push(lead + truncate(shown, maxInput, '…'));
    this.cursor = { x: Math.min(w - 1, visibleWidth(lead) + (query ? visibleWidth(visibleQuery) : 0)), y: 1 };
    rows.push(paint('rule', '─'.repeat(w)));

    const available = Math.max(0, h - INNER_HEADER_ROWS - INNER_DETAIL_ROWS);
    const entries = this.list.filtered as Array<{ item: SessionPickerItem }>;
    if (available > 0) {
      if (!entries.length) {
        rows.push('');
        if (rows.length < h - INNER_DETAIL_ROWS) rows.push(dim('  No sessions match this search.'));
        if (rows.length < h - INNER_DETAIL_ROWS) rows.push(dim('  Try another title, ID, or workspace.'));
      } else {
        const selected = Math.max(0, Math.min(this.list.selected, entries.length - 1));
        let start = Math.max(0, Math.min(this.list.offset, selected));
        let output = renderSessionRows(entries, start, selected, w, available);
        while (output.lastIndex < selected && start < selected) {
          start++;
          output = renderSessionRows(entries, start, selected, w, available);
        }
        this.list.offset = start;
        this.list.lastItemRows = available;
        rows.push(...output.rows);
      }
    }
    while (rows.length < Math.max(0, h - INNER_DETAIL_ROWS)) rows.push('');
    if (h >= INNER_DETAIL_ROWS) {
      rows.push(paint('rule', '─'.repeat(w)));
      const chosen = this.list.current as SessionPickerItem | null;
      if (chosen) {
        const title = itemTitle(chosen);
        const state = chosen.value.isCurrent ? paint('accent', 'ACTIVE') : dim('SELECTED');
        rows.push(rowPair(`  ${truncate(title, Math.max(1, w - 19), '…')}`, state, w));
        const description = chosen.value.type === 'switch'
          ? chosen.description
          : chosen.value.type === 'new' ? 'Start with an empty conversation in this workspace'
          : 'Duplicate conversation history; authorization is reset';
        rows.push(dim(`  ${truncate(clean(description), Math.max(1, w - 3), '…')}`));
      } else {
        rows.push(dim('  No session selected'));
        rows.push('');
      }
    }
    return rows.slice(0, h).map(line => truncate(line, w, '…'));
  }
}
