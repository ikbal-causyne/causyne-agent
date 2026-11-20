import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  canonicalWorkspacePath,
  sameWorkspace,
  workspaceDisplayName,
  shortenWorkspacePath,
  formatWorkspaceSectionTitle
} from '../src/tui/workspaceIdentity.js';
import {
  buildSessionPickerItems,
  formatSessionsTextReport,
  runInteractiveSessionPicker
} from '../src/tui/sessionPicker.js';
import {
  SessionPickerLayer,
  renderSessionRows,
  partitionSessionPickerItems
} from '../src/tui/sessionPickerView.js';
import { createSession, saveSessionMessages, deleteSession } from '../src/sessionStore.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe('workspaceIdentity dynamic detection and safety', () => {
  it('derives dynamic workspace names without hardcoding and sanitizes terminal control sequences', () => {
    const fsRoot = path.parse(process.cwd()).root;
    const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
    assert.equal(workspaceDisplayName('/Users/example/suika-game'), 'suika-game');
    assert.equal(workspaceDisplayName('/Users/example/Causyne AI/causyne-agent/'), 'causyne-agent');
    assert.equal(workspaceDisplayName('/srv/apps/My Creative Studio'), 'My Creative Studio');
    assert.equal(workspaceDisplayName(fsRoot), fsRoot);
    assert.equal(workspaceDisplayName(''), 'Current Workspace');
    assert.equal(workspaceDisplayName(homeDir), '~');

    const hostile = '/tmp/proj-\x1b[31mred\x1b[0m\ninjected';
    const cleanName = workspaceDisplayName(hostile);
    assert.ok(!cleanName.includes('\x1b'), 'ANSI escape sequences must be stripped');
    assert.ok(!cleanName.includes('\n') && !cleanName.includes('\r'), 'newlines must be collapsed');
    assert.ok(cleanName.includes('proj-'));

    assert.equal(formatWorkspaceSectionTitle('/tmp/suika-game', 3), 'suika-game SESSIONS (3)');
    assert.equal(formatWorkspaceSectionTitle('/tmp/causyne-agent', 0), 'causyne-agent SESSIONS (0)');
    assert.equal(formatWorkspaceSectionTitle(homeDir, 2), 'HOME (~) SESSIONS (2)');
    assert.equal(formatWorkspaceSectionTitle(fsRoot, 0), `WORKSPACE (${fsRoot}) SESSIONS (0)`);
  });

  it('matches canonical symlinked workspaces without confusing parent, child, or same-basename folders', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-ws-id-'));
    try {
      const realProject = path.join(base, 'parent', 'my-app');
      const siblingSameName = path.join(base, 'other', 'my-app');
      const childSubdir = path.join(realProject, 'nested');
      const symlinkProject = path.join(base, 'my-app-link');

      fs.mkdirSync(childSubdir, { recursive: true });
      fs.mkdirSync(siblingSameName, { recursive: true });
      fs.symlinkSync(realProject, symlinkProject, process.platform === 'win32' ? 'junction' : 'dir');

      const cache = new Map<string, string>();
      assert.equal(sameWorkspace(realProject, symlinkProject, cache), true);
      assert.equal(sameWorkspace(realProject, `${realProject}${path.sep}`, cache), true);
      assert.equal(sameWorkspace(realProject, path.dirname(realProject), cache), false);
      assert.equal(sameWorkspace(realProject, childSubdir, cache), false);
      assert.equal(sameWorkspace(realProject, siblingSameName, cache), false);
      assert.equal(sameWorkspace('', realProject, cache), false);
      assert.equal(canonicalWorkspacePath(realProject, cache), canonicalWorkspacePath(symlinkProject, cache));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('shortens home paths strictly on directory boundaries', () => {
    const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
    assert.equal(shortenWorkspacePath(home), '~');
    assert.equal(shortenWorkspacePath(path.join(home, 'projects', 'suika-game')), path.join('~', 'projects', 'suika-game'));
    const siblingPrefix = `${home}-sibling`;
    assert.equal(shortenWorkspacePath(siblingPrefix), siblingPrefix);
  });
});

describe('workspace-aware /sessions partitioning, deduplication, and rendering', () => {
  it('places current workspace sessions first with identical date sorting and zero duplicates in All Sessions', () => {
    const now = Date.now();
    // Anchor timestamps to local midnight so the test never flakes at 00:00–00:59 UTC/local
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const startMs = todayStart.getTime();
    const currentWs = '/work/alpha/suika-game';
    const otherWs = '/work/beta/payments-api';
    const sameBasenameOtherWs = '/work/gamma/suika-game';

    const sessions = [
      { id: 'ws-old', workspace: currentWs, workspaceKey: 'a', title: 'Old suika tweak', createdAt: startMs - 4 * DAY_MS + 12 * HOUR_MS, updatedAt: startMs - 4 * DAY_MS + 12 * HOUR_MS, messageCount: 7 },
      { id: 'other-today', workspace: otherWs, workspaceKey: 'b', title: 'API rate limit fix', createdAt: startMs + 100, updatedAt: startMs + 100, messageCount: 4 },
      { id: 'ws-today', workspace: currentWs, workspaceKey: 'a', title: 'Adventure overlay fix', createdAt: startMs + 150, updatedAt: startMs + 200, messageCount: 6 },
      // Duplicate ID entry to verify strict deduplication
      { id: 'ws-today', workspace: currentWs, workspaceKey: 'a', title: 'Adventure overlay fix', createdAt: startMs + 150, updatedAt: startMs + 200, messageCount: 6 },
      { id: 'same-name-diff-path', workspace: sameBasenameOtherWs, workspaceKey: 'c', title: 'Different suika repo', createdAt: startMs - 2 * DAY_MS + 12 * HOUR_MS, updatedAt: startMs - 2 * DAY_MS + 12 * HOUR_MS, messageCount: 3 },
      { id: 'ws-yesterday', workspace: currentWs, workspaceKey: 'a', title: 'Balloon physics tuning', createdAt: startMs - 12 * HOUR_MS, updatedAt: startMs - 12 * HOUR_MS, messageCount: 11 }
    ];

    const items = buildSessionPickerItems(sessions, 'ws-today', currentWs);
    const switchItems = items.filter((item) => item.value.type === 'switch');

    // Exact order: current workspace newest-first, then other workspaces newest-first
    assert.deepEqual(
      switchItems.map((item) => item.id),
      ['ws-today', 'ws-yesterday', 'ws-old', 'other-today', 'same-name-diff-path']
    );
    assert.deepEqual(
      switchItems.map((item) => item.section),
      ['workspace', 'workspace', 'workspace', 'all', 'all']
    );
    // Zero duplicates
    assert.equal(new Set(switchItems.map((item) => item.id)).size, switchItems.length);

    // Render modal and confirm BOTH sections have their own headers and Today sub-headers
    const layer = new SessionPickerLayer({
      items,
      currentWorkspace: currentWs,
      activeId: 'ws-today',
      onPick() {}
    });
    layer.list.moveTo(2, 15);
    const rendered = layer.body(90, 24).map(stripAnsi);
    const text = rendered.join('\n');

    assert.ok(text.includes('ALL WORKSPACES'), 'scope row keeps ALL WORKSPACES');
    assert.ok(text.includes('suika-game SESSIONS (3)'), 'workspace section uses detected folder name');
    assert.ok(text.includes('ALL SESSIONS (2)'), 'remaining sessions appear under ALL SESSIONS');

    const wsHeaderLine = rendered.findIndex((line) => line.includes('suika-game SESSIONS (3)'));
    const allHeaderLine = rendered.findIndex((line) => line.includes('ALL SESSIONS (2)'));
    assert.ok(wsHeaderLine > 0 && allHeaderLine > wsHeaderLine, 'workspace section must precede ALL SESSIONS');

    // Both sections have Today items -> TODAY header must appear in BOTH sections
    const todayLines = rendered
      .map((line, idx) => ({ line, idx }))
      .filter(({ line }) => /^\s+TODAY\s*$/.test(line));
    assert.ok(todayLines.some(({ idx }) => idx > wsHeaderLine && idx < allHeaderLine), 'workspace section must display TODAY');
    assert.ok(todayLines.some(({ idx }) => idx > allHeaderLine), 'ALL SESSIONS must display its own TODAY header');

    // Verify no current workspace session title appears beneath ALL SESSIONS (excluding the 3-row detail footer)
    const belowAll = rendered.slice(allHeaderLine, rendered.length - 3).join('\n');
    assert.ok(!belowAll.includes('Adventure overlay fix'), 'current workspace session must not duplicate in ALL SESSIONS');
    assert.ok(!belowAll.includes('Balloon physics tuning'), 'current workspace session must not duplicate in ALL SESSIONS');
    assert.ok(belowAll.includes('API rate limit fix'), 'other workspace session must appear under ALL SESSIONS');
    assert.ok(belowAll.includes('Different suika repo'), 'same-basename different-path workspace must appear under ALL SESSIONS');
  });

  it('shows dynamic workspace header with Empty state when current workspace has zero sessions', () => {
    const now = Date.now();
    const emptyWs = '/Users/dev/custom-workspace-xyz';
    const otherWs = '/Users/dev/another-repo';

    const sessions = [
      { id: 's-other-1', workspace: otherWs, workspaceKey: 'o', title: 'Refactor auth middleware', createdAt: now - 30 * 60000, updatedAt: now - 30 * 60000, messageCount: 5 },
      { id: 's-other-2', workspace: otherWs, workspaceKey: 'o', title: 'Add integration tests', createdAt: now - 2 * DAY_MS, updatedAt: now - 2 * DAY_MS, messageCount: 9 }
    ];

    const items = buildSessionPickerItems(sessions, 's-other-1', emptyWs);
    const layer = new SessionPickerLayer({
      items,
      currentWorkspace: emptyWs,
      activeId: 's-other-1',
      onPick() {}
    });

    const rendered = layer.body(86, 20).map(stripAnsi);
    const text = rendered.join('\n');
    assert.ok(text.includes('custom-workspace-xyz SESSIONS (0)'), 'empty workspace header must use detected workspace name');
    assert.ok(text.includes('Empty — no sessions in this workspace yet'), 'must render explicit Empty notice');
    assert.ok(text.includes('ALL SESSIONS (2)'), 'must render ALL SESSIONS below empty workspace');
    const emptyIdx = rendered.findIndex((line) => line.includes('Empty'));
    const allIdx = rendered.findIndex((line) => line.includes('ALL SESSIONS (2)'));
    assert.ok(emptyIdx > 0 && allIdx > emptyIdx, 'Empty workspace block must precede ALL SESSIONS');

    // Pressing Tab to THIS WORKSPACE keeps the Empty workspace section visible without ALL SESSIONS
    assert.equal(layer.key({ name: 'tab' }), 'handled');
    const wsOnlyText = layer.body(86, 18).map(stripAnsi).join('\n');
    assert.ok(wsOnlyText.includes('THIS WORKSPACE'));
    assert.ok(wsOnlyText.includes('custom-workspace-xyz SESSIONS (0)'));
    assert.ok(wsOnlyText.includes('Empty — no sessions in this workspace yet'));
    assert.ok(!wsOnlyText.includes('ALL SESSIONS'));

    // Switching back to ALL WORKSPACES restores ALL SESSIONS
    assert.equal(layer.key({ name: 'tab' }), 'handled');
    const restoredText = layer.body(86, 20).map(stripAnsi).join('\n');
    assert.ok(restoredText.includes('ALL SESSIONS (2)'));

    // Active search hides static Empty placeholder and shows matching sessions cleanly
    layer.list.query = 'auth';
    layer.list.refilter();
    const searchText = layer.body(86, 18).map(stripAnsi).join('\n');
    assert.ok(searchText.includes('Refactor auth middleware'));
    assert.ok(!searchText.includes('Empty — no sessions in this workspace yet'));
  });

  it('shows Empty workspace cleanly when there are zero sessions anywhere on the machine', () => {
    const items = buildSessionPickerItems([], null, '/Users/dev/brand-new-service');
    const layer = new SessionPickerLayer({
      items,
      currentWorkspace: '/Users/dev/brand-new-service',
      activeId: null,
      onPick() {}
    });
    const rendered = layer.body(80, 14).map(stripAnsi);
    const text = rendered.join('\n');
    assert.ok(text.includes('brand-new-service SESSIONS (0)'));
    assert.ok(text.includes('Empty — no sessions in this workspace yet'));
    assert.ok(!text.includes('ALL SESSIONS'));
  });

  it('guarantees zero orphaned headers, width bounds, and selection visibility across tight viewports and paging', () => {
    const now = Date.now();
    const emptyWs = '/work/empty-zone';
    const sessions = Array.from({ length: 24 }, (_, idx) => ({
      id: `s-${idx}`,
      workspace: idx % 3 === 0 ? '/work/other-a' : '/work/other-b',
      workspaceKey: `k-${idx % 3}`,
      title: `Task number ${idx}`,
      createdAt: now - idx * 12 * HOUR_MS,
      updatedAt: now - idx * 12 * HOUR_MS,
      messageCount: idx + 1
    }));
    const items = buildSessionPickerItems(sessions, 's-0', emptyWs);
    const layer = new SessionPickerLayer({
      items,
      currentWorkspace: emptyWs,
      activeId: 's-0',
      onPick() {}
    });

    for (const width of [24, 34, 48, 84]) {
      for (const height of [7, 9, 12, 20]) {
        for (const target of [0, 1, 2, 10, items.length - 1]) {
          layer.list.selected = target;
          layer.list.offset = 0;
          const rows = layer.body(width, height);
          assert.equal(rows.length, height);
          for (const row of rows) {
            assert.ok(!row.includes('\n') && !row.includes('\r'));
            assert.ok(visibleWidth(row) <= width, `overflow at ${width}x${height}: "${stripAnsi(row)}"`);
          }
          // When list body has at least 1 row, selection must be visible in the list window
          if (height >= 7) {
            const listWindow = rows.slice(3, height - 3).map(stripAnsi);
            assert.ok(listWindow.some((line) => line.trimStart().startsWith('▸') || line.trimStart().startsWith('>')),
              `selection marker missing for target=${target} at ${width}x${height}`);
            const nonEmptyLast = [...listWindow].reverse().find((line) => line.trim().length > 0) || '';
            assert.ok(!/^\s*(ACTIONS|TODAY|YESTERDAY|ALL SESSIONS \(\d+\)|empty-zone SESSIONS \(\d+\))\s*$/.test(nonEmptyLast),
              `orphaned header at ${width}x${height} target=${target}: "${nonEmptyLast}"`);
          }
        }
      }
    }

    // PageDown and PageUp navigate smoothly without throwing
    layer.list.selected = 0;
    layer.list.offset = 0;
    layer.body(80, 16);
    assert.equal(layer.key({ name: 'pagedown' }), 'handled');
    assert.ok(layer.list.selected > 0);
    assert.equal(layer.key({ name: 'pageup' }), 'handled');
    assert.equal(layer.list.selected, 0);
  });

  it('partitionSessionPickerItems deduplicates and groups raw items idempotently', () => {
    const raw = [
      { id: '__NEW_SESSION__', label: '+ New', category: 'Actions', description: '', value: { type: 'new' as const } },
      { id: 'other-1', label: 'Other', category: 'Today', description: '', value: { type: 'switch' as const, id: 'other-1', workspace: '/ws/other', title: 'Other', messageCount: 2, updatedAt: Date.now() } },
      { id: 'ws-1', label: 'Current', category: 'Today', description: '', value: { type: 'switch' as const, id: 'ws-1', workspace: '/ws/current', title: 'Current', messageCount: 3, updatedAt: Date.now() } },
      { id: 'ws-1', label: 'Current dup', category: 'Today', description: '', value: { type: 'switch' as const, id: 'ws-1', workspace: '/ws/current', title: 'Current', messageCount: 3, updatedAt: Date.now() } }
    ];
    const part = partitionSessionPickerItems(raw, '/ws/current');
    assert.equal(part.workspaceCount, 1);
    assert.equal(part.otherCount, 1);
    assert.deepEqual(part.ordered.map((item) => item.id), ['__NEW_SESSION__', 'ws-1', 'other-1']);
  });

  it('runInteractiveSessionPicker detects workspace from loop/prompt and focuses New session when workspace is empty', async () => {
    const emptyWs = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-empty-ws-'));
    const otherWs = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-other-ws-'));
    const otherSession = createSession(otherWs, 'Work in other project', true);
    saveSessionMessages(otherSession.id, [{ role: 'user', content: 'implement billing webhook' }]);

    try {
      let openedSelected = -1;
      let openedWorkspace = '';
      const prompt = {
        root: emptyWs,
        openLayer(layer: SessionPickerLayer) {
          openedSelected = layer.list.selected;
          openedWorkspace = layer.currentWorkspace;
          const rendered = layer.body(84, 18).map(stripAnsi).join('\n');
          assert.ok(rendered.includes(`${path.basename(emptyWs)} SESSIONS (0)`));
          assert.ok(rendered.includes('Empty — no sessions in this workspace yet'));
          assert.ok(rendered.includes('ALL SESSIONS'));
          layer.onPick(null);
        }
      };

      const msg = await runInteractiveSessionPicker(prompt as any, {});
      assert.match(msg, /Cancelled/);
      assert.equal(openedWorkspace, emptyWs);
      assert.equal(openedSelected, 0, 'empty workspace should start focused on + New Session so Empty banner is visible');
    } finally {
      deleteSession(otherSession.id);
      fs.rmSync(emptyWs, { recursive: true, force: true });
      fs.rmSync(otherWs, { recursive: true, force: true });
    }
  });

  it('formatSessionsTextReport groups current workspace first with Empty fallback and zero duplication', () => {
    const now = Date.now();
    const ws = '/Users/dev/suika-game';
    const other = '/Users/dev/api-server';
    const rows = [
      { id: 's_a', workspace: ws, workspaceKey: '1', title: 'Sprite polish', createdAt: now - 5 * 60000, updatedAt: now - 5 * 60000, messageCount: 4 },
      { id: 's_b', workspace: other, workspaceKey: '2', title: 'DB migration', createdAt: now - 2 * HOUR_MS, updatedAt: now - 2 * HOUR_MS, messageCount: 3 }
    ];

    const withWs = formatSessionsTextReport(rows, 's_a', ws);
    assert.ok(withWs.includes('suika-game SESSIONS (1)'));
    assert.ok(withWs.includes('ALL SESSIONS (1)'));
    assert.equal(withWs.split('Sprite polish').length - 1, 1, 'workspace session must not duplicate in text report');
    assert.ok(withWs.indexOf('Sprite polish') < withWs.indexOf('ALL SESSIONS (1)'));
    assert.ok(withWs.indexOf('ALL SESSIONS (1)') < withWs.indexOf('DB migration'));

    const emptyReport = formatSessionsTextReport(rows, 's_a', '/Users/dev/empty-app');
    assert.ok(emptyReport.includes('empty-app SESSIONS (0)'));
    assert.ok(emptyReport.includes('Empty — no sessions in this workspace yet'));
    assert.ok(emptyReport.includes('ALL SESSIONS (2)'));
  });
});
