/**
 * Causyne Agent /sessions: workspace-aware session presentation on the existing modal stack.
 * Preserves the date-grouped placement algorithm while elevating the active workspace's
 * sessions (or an explicit Empty state) above deduplicated All Sessions.
 */
// @ts-expect-error The existing dialog component is authored in JavaScript.
import { SelectLayer } from './dialogs.js';
import { bold, dim, paint, GLYPHS } from './theme.js';
import { safeDisplay, truncate, visibleWidth } from './text.js';
import {
  sameWorkspace,
  workspaceDisplayName,
  shortenWorkspacePath,
  formatWorkspaceSectionTitle
} from './workspaceIdentity.js';
import type { SessionPickerItem, SessionPickerSection } from './sessionPicker.js';

export interface SessionPickerViewOptions {
  items: SessionPickerItem[];
  currentWorkspace: string;
  activeId: string | null;
  onPick: (item: SessionPickerItem | null) => void;
}

export interface RenderSessionRowsOptions {
  currentWorkspace?: string | undefined;
  workspaceCount?: number | undefined;
  otherCount?: number | undefined;
  scope?: SessionScope | undefined;
  isSearching?: boolean | undefined;
  canonicalCache?: Map<string, string> | undefined;
}

type SessionScope = 'all' | 'workspace';
type Key = { name?: string; ctrl?: boolean; sequence?: string; text?: string } | null;

const INNER_HEADER_ROWS = 3;  // scope, search, divider
const INNER_DETAIL_ROWS = 3;  // divider, selected title, metadata
const MAX_PANEL_HEIGHT = 28;

function clean(value: unknown): string {
  return safeDisplay(typeof value === 'string' ? value : String(value ?? '')).replace(/[\r\n]+/g, ' ');
}

function rowPair(left: string, right: string, width: number): string {
  const room = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 60;
  const rightWidth = visibleWidth(right);
  if (rightWidth === 0) return truncate(left, room, '…');
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
  const rawMsgs = Number(item.value.messageCount);
  const safeMsgs = Number.isFinite(rawMsgs) ? Math.max(0, Math.floor(rawMsgs)) : 0;
  const timeText = shortTime(item);
  const metaCore = timeText ? `${safeMsgs} msgs  ${GLYPHS.dot}  ${timeText}` : `${safeMsgs} msgs`;
  const right = isAction
    ? dim(item.value.type === 'new' ? 'create' : 'branch')
    : dim(`${metaCore}${item.value.isCurrent ? '  ACTIVE' : ''}`);
  const available = Math.max(1, width - visibleWidth(leftPrefix) - 1);
  // Keep titles legible on small terminals instead of allowing metadata to eat them.
  const showMeta = available >= 42;
  const usableRight = showMeta ? right : '';
  const titleBudget = Math.max(1, available - (showMeta ? visibleWidth(usableRight) + 2 : 0));
  const name = truncate(rawName, titleBudget, '…');
  const styledName = selected ? bold(paint('ink', name)) : paint('ink', name);
  return rowPair(leftPrefix + styledName, usableRight, width);
}

function resolveItemSection(
  item: SessionPickerItem,
  currentWorkspace?: string,
  cache?: Map<string, string>
): SessionPickerSection {
  if (item.value.type !== 'switch') return 'actions';
  if (item.section === 'workspace' || item.section === 'all') {
    if (!currentWorkspace || item.value.workspace === undefined) return item.section;
  }
  if (currentWorkspace && sameWorkspace(item.value.workspace, currentWorkspace, cache)) {
    return 'workspace';
  }
  return 'all';
}

export interface PartitionedSessionItems {
  ordered: SessionPickerItem[];
  workspaceCount: number;
  otherCount: number;
}

/**
 * Partition picker items into:
 *   1. Pinned actions
 *   2. Current workspace sessions (preserving date-sorted order)
 *   3. All other sessions (preserving date-sorted order, strictly deduplicated)
 */
export function partitionSessionPickerItems(
  items: SessionPickerItem[],
  currentWorkspace: string,
  cache?: Map<string, string>
): PartitionedSessionItems {
  const actions: SessionPickerItem[] = [];
  const workspace: SessionPickerItem[] = [];
  const other: SessionPickerItem[] = [];
  const seenIds = new Set<string>();

  for (const raw of Array.isArray(items) ? items : []) {
    if (!raw || !raw.value) continue;
    const key = typeof raw.id === 'string' && raw.id ? raw.id : '';
    if (key && seenIds.has(key)) continue;
    if (key) seenIds.add(key);

    if (raw.value.type !== 'switch') {
      actions.push(raw.section === 'actions' ? raw : { ...raw, section: 'actions' });
      continue;
    }

    const inWorkspace = sameWorkspace(raw.value.workspace, currentWorkspace, cache);
    if (inWorkspace) {
      workspace.push(raw.section === 'workspace' ? raw : { ...raw, section: 'workspace' });
    } else {
      other.push(raw.section === 'all' ? raw : { ...raw, section: 'all' });
    }
  }

  return {
    ordered: [...actions, ...workspace, ...other],
    workspaceCount: workspace.length,
    otherCount: other.length
  };
}

interface ListWindow { rows: string[]; lastIndex: number; }

/**
 * Section and date headers are terminal rows, not selectable items. This window is
 * measured in *actual rows*, preventing orphaned headers or hidden selections at
 * section and group boundaries.
 */
export function renderSessionRows(
  entries: Array<{ item: SessionPickerItem }>,
  start: number,
  selected: number,
  width: number,
  budget: number,
  options?: RenderSessionRowsOptions
): ListWindow {
  const rows: string[] = [];
  const safeStart = Number.isFinite(start) ? Math.max(0, Math.floor(start)) : 0;
  const safeWidth = Number.isFinite(width) ? Math.max(4, Math.floor(width)) : 60;
  const safeBudget = budget === Number.POSITIVE_INFINITY
    ? Math.max(entries.length * 4 + 6, 16)
    : (Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0);

  if (safeBudget === 0) {
    return { rows, lastIndex: safeStart - 1 };
  }

  const useSections = Boolean(
    options?.currentWorkspace
    || entries.some((entry) => entry?.item?.section !== undefined)
  );

  // Legacy 5-argument direct rendering without workspace sections.
  if (!useSections) {
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

  const currentWorkspace = options?.currentWorkspace;
  const cache = options?.canonicalCache;
  const isSearching = Boolean(options?.isSearching);

  const wsCount = typeof options?.workspaceCount === 'number' && Number.isFinite(options.workspaceCount)
    ? Math.max(0, Math.floor(options.workspaceCount))
    : entries.filter((entry) => resolveItemSection(entry.item, currentWorkspace, cache) === 'workspace').length;
  const otherCount = typeof options?.otherCount === 'number' && Number.isFinite(options.otherCount)
    ? Math.max(0, Math.floor(options.otherCount))
    : entries.filter((entry) => resolveItemSection(entry.item, currentWorkspace, cache) === 'all').length;

  const wsDisplayName = workspaceDisplayName(currentWorkspace, cache);
  const wsShortPath = currentWorkspace ? shortenWorkspacePath(currentWorkspace) : '';

  const actionsHeaderRow = (): string =>
    dim(`  ${truncate('ACTIONS', Math.max(1, safeWidth - 4), '…')}`);

  const workspaceSectionRow = (): string => {
    const title = formatWorkspaceSectionTitle(currentWorkspace, wsCount, cache);
    const styledLeft = `  ${bold(paint('accent', title))}`;
    const leftWidth = visibleWidth(styledLeft);
    const remainingForPath = safeWidth - leftWidth - 3;
    let rightPath = '';
    if (
      safeWidth >= 52
      && remainingForPath >= 12
      && wsShortPath
      && wsShortPath !== wsDisplayName
      && wsShortPath !== '(default)'
    ) {
      let shownPath = wsShortPath;
      if (visibleWidth(shownPath) > remainingForPath) {
        const runes = Array.from(shownPath);
        const budget = Math.max(1, remainingForPath - 1);
        while (runes.length > 0 && visibleWidth(runes.join('')) > budget) runes.shift();
        shownPath = `…${runes.join('')}`;
      }
      rightPath = dim(shownPath);
    }
    return rowPair(styledLeft, rightPath, safeWidth);
  };

  const workspaceEmptyRow = (): string => {
    const label = safeWidth >= 46
      ? 'Empty — no sessions in this workspace yet'
      : 'Empty';
    return dim(`    ${truncate(label, Math.max(1, safeWidth - 4), '…')}`);
  };

  const allSessionsSectionRow = (): string => {
    const title = `ALL SESSIONS (${otherCount})`;
    return truncate(`  ${bold(paint('ink', title))}`, safeWidth, '…');
  };

  const dateSubHeaderRow = (category: string): string =>
    dim(`    ${truncate(category.toUpperCase(), Math.max(1, safeWidth - 6), '…')}`);

  const searchGroupHeaderRow = (section: SessionPickerSection, category: string): string => {
    if (section === 'actions') return actionsHeaderRow();
    if (section === 'workspace') {
      const text = `${wsDisplayName}  ${GLYPHS.dot}  ${category.toUpperCase()}`;
      return truncate(`  ${paint('accent', text)}`, safeWidth, '…');
    }
    const text = `ALL SESSIONS  ${GLYPHS.dot}  ${category.toUpperCase()}`;
    return dim(`  ${truncate(text, Math.max(1, safeWidth - 4), '…')}`);
  };

  const shouldShowEmptyWorkspace = !isSearching && wsCount === 0;
  let emptyWorkspaceEmitted = false;
  let lastIndex = safeStart - 1;
  let previousSection: SessionPickerSection | null = null;
  let previousCategory: string | null = null;

  for (let i = safeStart; i < entries.length && rows.length < safeBudget; i++) {
    const item = entries[i]!.item;
    const category = clean(item.category || 'Sessions');
    const section = resolveItemSection(item, currentWorkspace, cache);

    // Emit the Empty workspace block directly after Actions (or at index 0 when
    // there are no Actions) before transitioning into ALL SESSIONS.
    const needsEmptyWorkspaceBefore = shouldShowEmptyWorkspace
      && !emptyWorkspaceEmitted
      && section === 'all'
      && (previousSection === 'actions' || (safeStart === 0 && i === 0));

    if (needsEmptyWorkspaceBefore) {
      const remainingBeforeEmpty = safeBudget - rows.length;
      if (rows.length === 0 && i === selected && remainingBeforeEmpty < 3) {
        // Ultra-short viewport targeting this item: never let the empty notice starve selection.
        emptyWorkspaceEmitted = true;
      } else if (remainingBeforeEmpty >= 2) {
        rows.push(workspaceSectionRow());
        rows.push(workspaceEmptyRow());
        emptyWorkspaceEmitted = true;
      } else if (rows.length > 0) {
        break;
      }
    }

    const pendingHeaders: string[] = [];
    if (isSearching) {
      if (section !== previousSection || category !== previousCategory) {
        pendingHeaders.push(searchGroupHeaderRow(section, category));
      }
    } else {
      const sectionChanged = section !== previousSection;
      if (sectionChanged) {
        // Reset date tracking on section change so TODAY renders cleanly under ALL SESSIONS
        // even when the preceding workspace section also ended on TODAY.
        previousCategory = null;
        if (section === 'actions') {
          pendingHeaders.push(actionsHeaderRow());
        } else if (section === 'workspace') {
          pendingHeaders.push(workspaceSectionRow());
        } else {
          pendingHeaders.push(allSessionsSectionRow());
        }
      }
      if (section !== 'actions' && category !== previousCategory) {
        pendingHeaders.push(dateSubHeaderRow(category));
      }
    }

    const remaining = safeBudget - rows.length;
    if (pendingHeaders.length + 1 <= remaining) {
      rows.push(...pendingHeaders);
      rows.push(actionOrSessionText(item, i === selected, safeWidth));
    } else if (rows.length === 0) {
      // First item in window on a very tight viewport: keep selection visible without orphaned headers.
      if (remaining >= 2 && pendingHeaders.length > 0) {
        rows.push(pendingHeaders[0]!);
        rows.push(actionOrSessionText(item, i === selected, safeWidth));
      } else if (remaining >= 1) {
        rows.push(actionOrSessionText(item, i === selected, safeWidth));
      } else {
        break;
      }
    } else {
      break;
    }

    lastIndex = i;
    previousSection = section;
    previousCategory = category;
  }

  // When the current workspace has 0 sessions and no other sessions followed Actions
  // (for example: brand-new install or Tab-scoped THIS WORKSPACE view), show the
  // workspace section header + Empty notice directly beneath Actions.
  const reachedEnd = entries.length === 0 || lastIndex === entries.length - 1;
  if (shouldShowEmptyWorkspace && !emptyWorkspaceEmitted && reachedEnd && safeBudget - rows.length >= 2) {
    rows.push(workspaceSectionRow());
    rows.push(workspaceEmptyRow());
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
    move(delta: number, visibleRows: number): void;
    moveTo(index: number, visibleRows: number): void;
  };
  declare cursor: { x: number; y: number } | null;
  readonly currentWorkspace: string;
  readonly activeId: string | null;
  readonly allItems: SessionPickerItem[];
  private readonly canonicalCache: Map<string, string>;
  private lastWidth = 80;
  scope: SessionScope = 'all';

  constructor(options: SessionPickerViewOptions) {
    const canonicalCache = new Map<string, string>();
    const partitioned = partitionSessionPickerItems(options.items, options.currentWorkspace, canonicalCache);
    const totalSwitchCount = partitioned.workspaceCount + partitioned.otherCount;

    super({
      title: `Sessions  ${totalSwitchCount}`,
      width: 100,
      height: MAX_PANEL_HEIGHT,
      items: partitioned.ordered,
      placeholder: 'Search sessions by title, ID or workspace',
      emptyText: 'No matching sessions',
      footer: `↑↓ navigate  ${GLYPHS.dot}  enter open  ${GLYPHS.dot}  tab workspace  ${GLYPHS.dot}  esc close`,
      onPick: options.onPick
    });
    this.canonicalCache = canonicalCache;
    this.allItems = partitioned.ordered;
    this.currentWorkspace = options.currentWorkspace;
    this.activeId = options.activeId;
  }

  private renderOptions(entries: Array<{ item: SessionPickerItem }>): RenderSessionRowsOptions {
    const isSearching = Boolean(clean(this.list.query || '').trim());
    let workspaceCount = 0;
    let otherCount = 0;
    for (const entry of entries) {
      const section = resolveItemSection(entry.item, this.currentWorkspace, this.canonicalCache);
      if (section === 'workspace') workspaceCount++;
      else if (section === 'all') otherCount++;
    }
    return {
      currentWorkspace: this.currentWorkspace,
      workspaceCount,
      otherCount,
      scope: this.scope,
      isSearching,
      canonicalCache: this.canonicalCache
    };
  }

  preferredHeight(): number {
    // Modals with a few sessions do not retain a large blank area.
    const entries = this.list.filtered as Array<{ item: SessionPickerItem }>;
    const rendered = renderSessionRows(
      entries,
      0,
      0,
      this.lastWidth,
      MAX_PANEL_HEIGHT,
      this.renderOptions(entries)
    );
    const content = Math.max(1, rendered.rows.length);
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
          sameWorkspace(item.value.workspace, this.currentWorkspace, this.canonicalCache));
    this.list.setItems(scoped);
    const next = this.list.filtered.findIndex((entry: { item: SessionPickerItem }) => entry.item.id === oldId);
    const firstWorkspace = this.list.filtered.findIndex((entry: { item: SessionPickerItem }) => entry.item.section === 'workspace');
    this.list.selected = next >= 0 ? next : Math.max(0, firstWorkspace);
    this.list.offset = 0;
  }

  key(event: Key): string | null {
    if (event?.name === 'tab') {
      this.toggleWorkspace();
      return 'handled';
    }
    if (event?.name === 'pageup' || event?.name === 'pagedown') {
      const entries = this.list.filtered as Array<{ item: SessionPickerItem }>;
      if (entries.length === 0) return 'handled';
      const available = Math.max(1, this.list.lastItemRows || 12);
      const offset = Math.max(0, Math.min(Math.floor(this.list.offset || 0), entries.length - 1));
      const selected = Math.max(0, Math.min(Math.floor(this.list.selected || 0), entries.length - 1));
      const window = renderSessionRows(entries, offset, selected, this.lastWidth, available, this.renderOptions(entries));
      const page = Math.max(1, window.lastIndex - offset + 1);
      const target = Math.max(0, Math.min(entries.length - 1, selected + (event.name === 'pageup' ? -page : page)));
      if (typeof this.list.moveTo === 'function') {
        this.list.moveTo(target, available);
      } else {
        this.list.move(target - selected, available);
      }
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
    this.lastWidth = w;
    const rows: string[] = [];
    const scopeLabel = this.scope === 'all' ? 'ALL WORKSPACES' : 'THIS WORKSPACE';
    const wsName = workspaceDisplayName(this.currentWorkspace, this.canonicalCache);
    const total = this.allItems.filter(item => item.value.type === 'switch').length;
    const count = this.countSessions();

    const leftScope = `  ${paint('accent', scopeLabel)}  ${dim(`${GLYPHS.dot}  ${wsName}`)}`;
    rows.push(rowPair(leftScope, w >= 52 ? dim(`${count} / ${total} sessions`) : '', w));
    const query = clean(this.list.query || '');
    const lead = `  ${paint('accent', GLYPHS.arrow)} `;
    const maxInput = Math.max(1, w - visibleWidth(lead) - 1);
    // Show the tail of long queries without splitting UTF-16 surrogate pairs.
    const runes = Array.from(query);
    while (runes.length > 0 && visibleWidth(runes.join('')) > maxInput) runes.shift();
    const visibleQuery = runes.join('');
    const shown = query ? visibleQuery : dim('Search by title, workspace or ID…');
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
        const rawSel = Number.isFinite(this.list.selected) ? Math.floor(this.list.selected) : 0;
        const rawOff = Number.isFinite(this.list.offset) ? Math.floor(this.list.offset) : 0;
        const selected = Math.max(0, Math.min(rawSel, entries.length - 1));
        this.list.selected = selected;
        let start = Math.max(0, Math.min(rawOff, selected));
        const renderOpts = this.renderOptions(entries);
        let output = renderSessionRows(entries, start, selected, w, available, renderOpts);
        while (output.lastIndex < selected && start < selected) {
          start++;
          output = renderSessionRows(entries, start, selected, w, available, renderOpts);
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
          : chosen.value.type === 'new' ? `Start with an empty conversation in ${wsName}`
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
