import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { StageSurface } from '../src/tui/stageSurface.js';
import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';
import {
  formatPreviewCardMarkdown,
  renderTurnPreviewCard,
  overlayTurnPreviewCard,
  handleTurnRailMouse,
  type SessionTurn
} from '../src/tui/turnRail.js';
import { handleScrollbarMouse } from '../src/tui/scrollInteraction.js';

function createSink(columns = 120, rows = 35) {
  const chunks: string[] = [];
  return {
    columns,
    rows,
    isTTY: true,
    write(text: string) {
      chunks.push(text);
      return true;
    },
    on() {},
    removeListener() {},
    text: () => chunks.join(''),
    reset: () => { chunks.length = 0; },
    chunks
  };
}

describe('Turn Rail & Chat Interface Symmetry, Spacing and Markdown Rendering', () => {
  test('formatPreviewCardMarkdown cleans markdown syntax tokens from assistant summaries and prompts', () => {
    const raw = '### Google Play Store Android App Bundle (.aab) Ready The production-ready **Android App Bundle (`.aab`)** has been built, mi...';
    const cleaned = formatPreviewCardMarkdown(raw);

    assert.ok(!cleaned.includes('###'), 'Heading markers must be stripped');
    assert.ok(!cleaned.includes('**'), 'Bold markdown asterisks must be stripped');
    assert.ok(!cleaned.includes('`'), 'Inline code backticks must be stripped');
    assert.ok(cleaned.includes('Google Play Store Android App Bundle (.aab) Ready'), 'Clean heading text preserved');
    assert.ok(cleaned.includes('Android App Bundle (.aab) has been built'), 'Clean body text preserved');
  });

  test('renderTurnPreviewCard renders clean formatted text without raw markdown artifacts', () => {
    const turn: SessionTurn = {
      turnIndex: 9,
      totalTurns: 9,
      userPrompt: 'now build **aab** for me to uploud to the `playstore`',
      assistantSummary: '### Google Play Store Android App Bundle (.aab) Ready\nThe production-ready **Android App Bundle (`.aab`)** has been built, mi...',
      timestamp: Date.now(),
      formattedDate: '7:19 AM',
      frameId: 9,
      startRow: 40
    };

    const card = renderTurnPreviewCard(turn, 52);
    const plain = card.map(stripAnsi).join('\n');

    assert.ok(!plain.includes('###'), 'Preview card body must not display raw ###');
    assert.ok(!plain.includes('**'), 'Preview card body must not display raw **');
    assert.ok(!plain.includes('`'), 'Preview card body must not display raw `');
    assert.ok(plain.includes('9 of 9'), 'Turn counter is present');
    assert.ok(plain.includes('7:19 AM'), 'Timestamp is present');
  });

  test('renderTurnPreviewCard wraps multi-line prompt and summary flush-left with zero hanging indent', () => {
    const turn: SessionTurn = {
      turnIndex: 9,
      totalTurns: 9,
      userPrompt: 'now build aab for me to uploud to the playstore',
      assistantSummary: 'Google Play Store Android App Bundle (.aab) Ready The production-ready Android App Bundle (.aab) has been built, minified with R8,',
      timestamp: Date.now(),
      formattedDate: '2:37 PM',
      frameId: 9,
      startRow: 40
    };

    const card = renderTurnPreviewCard(turn, 46);
    // Find prompt line 2 (which contains "playstore")
    const promptLine2 = card.find(r => stripAnsi(r).includes('playstore'));
    assert.ok(promptLine2, 'Prompt continuation line should exist');
    const plainP2 = stripAnsi(promptLine2);
    // Inside the card, line starts with "│ " followed by text flush-left
    assert.ok(!plainP2.includes('│   playstore'), `Prompt line 2 must not have 2-space hanging indent: "${plainP2}"`);

    // Find summary line 2
    const summaryLine2 = card.find(r => stripAnsi(r).includes('Ready The'));
    assert.ok(summaryLine2, 'Summary continuation line should exist');
    const plainS2 = stripAnsi(summaryLine2);
    assert.ok(!plainS2.includes('│   Ready'), `Summary line 2 must not have 2-space hanging indent: "${plainS2}"`);
  });

  test('renderTurnPreviewCard verifies image 4 test case is completely flush-left without hanging indent', () => {
    const turn: SessionTurn = {
      turnIndex: 1,
      totalTurns: 2,
      userPrompt: 'improve this game make this game better first in ui/ux aspect make sure the game must ...',
      assistantSummary: null,
      timestamp: Date.now(),
      formattedDate: '2:21 PM',
      frameId: 1,
      startRow: 10
    };

    const card = renderTurnPreviewCard(turn, 46);
    const line2 = card.find(r => stripAnsi(r).includes('in ui/ux'));
    assert.ok(line2, 'Prompt continuation line 2 should exist');
    const plain = stripAnsi(line2);
    assert.ok(!plain.startsWith('│  '), `Must not have multi-space hanging indent: "${plain}"`);
    assert.ok(plain.startsWith('│ first in ui/ux'), `Must start flush-left against border padding: "${plain}"`);
  });

  test('overlayTurnPreviewCard never leaks underlying severed tool arrows or characters into left margin', () => {
    const baseRows = [
      ' • ▸ 01 run         find /workspace/app/src/main -type f                              |',
      ' •   ✓                                                                                |',
      ' • ▸ 02 read        ui/MainActivity.kt                                                |',
      ' ●                                                                                    |',
      ' • ▸ 03 read        ui/RemoteViewModel.kt                                             |',
      ' •   ✓                                                                                |',
      ' • ▸ 04 read        network/Discovery.kt                                              |',
      ' •   ✓                                                                                |',
      ' • ▸ 05 read        network/Client.kt                                                 |'
    ];

    const card = [
      '╭──────────────────────────────────────────────╮',
      '│ now build aab for me to uploud to the playst │',
      '│                                              │',
      '│ Google Play Store Android App Bundle (.aab)  │',
      '│ Ready The production-ready Android App Bundl │',
      '│                                              │',
      '│ 9 of 9                               7:19 AM │',
      '╰──────────────────────────────────────────────╯'
    ];

    const screenWidth = 85;
    const overlaid = overlayTurnPreviewCard(baseRows, card, 4, 1, screenWidth);
    assert.equal(overlaid.length, baseRows.length);

    for (let i = 0; i < card.length; i++) {
      const row = overlaid[i]!;
      const plain = stripAnsi(row);

      // Card must align flush-left with transcript content baseline (starts at Column 3)
      const cardBorderIndex = plain.search(/[╭│╰]/);
      assert.equal(cardBorderIndex, 3, `Card border should start flush at column 3, got ${cardBorderIndex}`);

      // Crucial: The margin before the card (columns 0..2) must NEVER contain severed '▸' or '>' arrows!
      const marginBeforeCard = plain.slice(0, 3);
      assert.ok(!/[▸>]/.test(marginBeforeCard), `Margin before card row ${i} must not contain severed arrow: "${marginBeforeCard}"`);

      // Column 0 is air space, Column 1 holds turn dot (or space), Column 2 is breathing space before card
      assert.equal(marginBeforeCard[0], ' ', 'Column 0 must be outer air space');
      assert.ok(marginBeforeCard[1] === '•' || marginBeforeCard[1] === '●' || marginBeforeCard[1] === '.' || marginBeforeCard[1] === ' ', 'Column 1 is dot or space');
      assert.equal(marginBeforeCard[2], ' ', 'Column 2 must be 1 clean space of breathing room');
    }
  });

  test('attachRail provides symmetrical flush alignment for user bar, tool arrow and assistant header', () => {
    const out = createSink(120, 35);
    const surface = new StageSurface({ out, env: { CAUSYNE_RAIL: '1', CAUSYNE_SIDEBAR: '0' } });
    surface.open();

    try {
      const renderer = new ChatRenderer({ out, transcript: surface.transcript });

      // Add user message
      renderer.renderUserMessage('kemudian sekarang how i can connect to my hisense tv ?');

      // Add tool start
      renderer.onStepStart({ tool: 'run', args: { command: 'find /workspace/app/src/main -type f' } });

      // Add tool complete
      renderer.onStepComplete({ success: true, elapsed: '120ms' });

      // Add assistant message
      renderer.renderAssistantMessage('Untuk menghubungkan aplikasi VidaaRemote ke Hisense Smart TV Anda, ikuti langkah-langkah berikut:\n\n---\n\n1. Satu Jaringan Wi-Fi yang Sama:\n   * Pastikan fitur *AP Isolation* di router mati.\n');

      surface.present(['status'], { row: 0, col: 0 });
      const band = surface.stage.prev;

      // Find user bar row
      const userRow = band.find((r: string) => stripAnsi(r).includes('kemudian sekarang'));
      assert.ok(userRow, 'User row should exist in painted band');
      const plainUser = stripAnsi(userRow);
      const userBarCol = plainUser.search(/[┃|]/);
      assert.equal(userBarCol, 3, `User message accent bar must align flush at Column 3, got ${userBarCol}`);

      // Find tool step start row
      const toolRow = band.find((r: string) => stripAnsi(r).includes('01') && stripAnsi(r).includes('run'));
      assert.ok(toolRow, 'Tool step start row should exist in painted band');
      const plainTool = stripAnsi(toolRow);
      const toolArrowCol = plainTool.search(/[▸>]/);
      assert.equal(toolArrowCol, 3, `Tool arrow must align flush at Column 3, got ${toolArrowCol}`);

      // Find assistant header row
      const assistantHeaderRow = band.find((r: string) => stripAnsi(r).includes('Causyne'));
      assert.ok(assistantHeaderRow, 'Assistant header row should exist in painted band');
      const plainAssistant = stripAnsi(assistantHeaderRow);
      const assistantArrowCol = plainAssistant.search(/[▸>]/);
      assert.equal(assistantArrowCol, 3, `Assistant arrow must align flush at Column 3, got ${assistantArrowCol}`);

      // Symmetrical parallel alignment verified: All three key anchors align at Column 3!
      assert.equal(userBarCol, toolArrowCol, 'User accent bar and tool arrow are parallel flush');
      assert.equal(toolArrowCol, assistantArrowCol, 'Tool arrow and assistant header are parallel flush');

      // Assistant body text must be cleanly indented at Column 5 (not jammed at Column 2)
      const bodyRow = band.find((r: string) => stripAnsi(r).includes('Untuk menghubungkan aplikasi'));
      assert.ok(bodyRow, 'Assistant body text row should exist');
      const plainBody = stripAnsi(bodyRow);
      const bodyCol = plainBody.indexOf('Untuk');
      assert.equal(bodyCol, 5, `Assistant body text must start at Column 5 with 3 columns of breathing space from dot, got ${bodyCol}`);
    } finally {
      surface.close();
    }
  });

  test('renderMarkdown in chatRenderer transforms italics, horizontal rules, and table dividers cleanly', () => {
    const out = createSink(120, 35);
    const renderer = new ChatRenderer({ out });

    // Verify markdown renderer produces no raw '---' or unformatted asterisks
    renderer.renderAssistantMessage('Fitur *AP Isolation* / *Client Isolation* di router.\n\n---\n\n| Item | Nilai |\n| :--- | :--- |\n| APK  | 1.2 MB |\n');

    const output = out.text();
    // Raw '---' should be replaced with a rendered rule line
    assert.ok(!output.includes('\n---\n'), 'Raw horizontal rule --- must not be rendered literally');
    // Raw table separator should be rendered cleanly
    assert.ok(!output.includes('| :--- |'), 'Raw table separator | :--- | must not be rendered literally');
    // Clean text present
    assert.ok(output.includes('AP Isolation'), 'Text inside italics preserved and formatted');
  });

  test('overlayTurnPreviewCard preserves rightmost overview rail glyph and never outputs stray brackets', () => {
    // 110 columns wide baseRows with right overview rail character '│'
    const baseRows = [
      ' • > Task :app:compileReleaseArtProfile                                                                 │',
      ' • > Task :app:optimizeReleaseResources                                                                 │',
      ' • > Task :app:packageRelease                                                                         > │',
      ' • > Task :app:createReleaseApkListingFileRedirect                                                      │',
      ' • > Task :app:assembleRelease                                                                          │',
      ' ● ` ... output truncated — ctrl+o to expand                                                              │'
    ];
    const card = [
      '╭──────────────────────────────────────────────────╮',
      '│ 2 of 13                                 12:50 AM │',
      '│ Building the native Kotlin VIDAA Remote app      │',
      '│ assembleDebug                                    │',
      '╰──────────────────────────────────────────────────╯'
    ];

    // Overlay onto rows where screenWidth is 111 (mainWidth) and visibleWidth(baseRow) is 110
    const overlaid = overlayTurnPreviewCard(baseRows, card, 2, 1, 111);
    assert.equal(overlaid.length, baseRows.length);

    for (let i = 0; i < overlaid.length; i++) {
      const row = overlaid[i]!;
      const plain = stripAnsi(row);
      // Row must never start with stray '[' or ']'
      assert.ok(!/^\s*[\[\]]/.test(plain), `Row ${i} must not start with stray bracket: "${plain}"`);
      // Row must never have isolated stray ']' at column 109
      assert.ok(!plain.endsWith(']'), `Row ${i} must not end with stray closing bracket: "${plain}"`);
      // Rightmost non-space character must be the overview rail glyph ('│' or '>')
      const trimmedEnd = plain.trimEnd();
      const lastChar = trimmedEnd[trimmedEnd.length - 1];
      assert.ok(lastChar === '│' || lastChar === '>', `Row ${i} must preserve overview rail glyph: "${plain}"`);
    }
  });

  test('attachRail preserves formatting without double indentation when row has leading ANSI escapes before spaces', () => {
    const out = createSink(120, 35);
    const surface = new StageSurface({ out, env: { CAUSYNE_RAIL: '1', CAUSYNE_SIDEBAR: '0' } });
    surface.open();

    try {
      const renderer = new ChatRenderer({ out, transcript: surface.transcript });
      renderer.renderUserMessage('test turn');
      renderer.renderAssistantMessage('Response');

      // Add a row that starts with ANSI background color before 3 spaces
      surface.transcript.append({
        kind: 'result',
        produce: () => ['\x1b[48;2;35;35;40m   Indented styled command output line\x1b[0m']
      });

      surface.present(['status'], { row: 0, col: 0 });
      const band = surface.stage.prev;
      const foundRow = band.find((r: string) => stripAnsi(r).includes('Indented styled command output'));
      assert.ok(foundRow, 'Styled row must exist');

      const plain = stripAnsi(foundRow);
      // The text 'Indented' must start at Column 3 (not Column 6!)
      const col = plain.indexOf('Indented');
      assert.equal(col, 3, `Styled row must align at Column 3, got ${col}: "${plain}"`);
    } finally {
      surface.close();
    }
  });

  test('handleScrollbarMouse respects sidebar layout and registers overview rail clicks at mainWidth', () => {
    let scrolledPosition: number | null = null;
    let followingResumed = false;

    const mockViewport = {
      scrollTop: 50,
      height: 30,
      maxScrollTop: () => 100,
      scrollTo: (pos: number) => { scrolledPosition = pos; return pos; },
      toBottom: () => { followingResumed = true; return 100; }
    };

    const mockSurface = {
      stage: {
        height: 35,
        width: () => 200
      },
      width: 200,
      railEnabled: () => true,
      activeTurnIndex: 3
    };

    const mockHost = {
      out: { rows: 40 },
      draw: () => {},
      notice: ''
    };

    // Click at col 155 (overview rail in 200-column window: 200 - 42 - 1 = 157 mainWidth)
    const railClickEvent = {
      name: 'mouse',
      mouse: { x: 155, y: 15, button: 0, pressed: true }
    };
    const railHandled = handleScrollbarMouse(railClickEvent, mockViewport as any, mockSurface as any, mockHost as any);
    assert.equal(railHandled, true, 'Click on overview rail column 155 must be handled');
    assert.ok(scrolledPosition !== null, 'Viewport must be scrolled by rail click');

    // Click inside the sidebar (col 175) must NOT be captured by the scrollbar
    const sidebarClickEvent = {
      name: 'mouse',
      mouse: { x: 175, y: 15, button: 0, pressed: true }
    };
    const sidebarHandled = handleScrollbarMouse(sidebarClickEvent, mockViewport as any, mockSurface as any, mockHost as any);
    assert.equal(sidebarHandled, false, 'Click inside sidebar column 175 must not trigger scrollbar');
  });

  test('handleTurnRailMouse maintains smooth hover hit testing up to column 5', () => {
    let scheduled = false;
    const mockSurface = {
      turnRailLayout: {
        railX: 1,
        stageTop: 0,
        viewportHeight: 30,
        dotRows: new Map([[1, 2], [2, 5]]),
        rowToTurn: new Map([[2, 1], [5, 2]]),
        turns: [
          { turnIndex: 1, totalTurns: 2, userPrompt: 'T1', assistantSummary: 'A1', timestamp: 1, formattedDate: '10:00', frameId: 1, startRow: 0 },
          { turnIndex: 2, totalTurns: 2, userPrompt: 'T2', assistantSummary: 'A2', timestamp: 2, formattedDate: '10:05', frameId: 2, startRow: 20 }
        ]
      },
      hoveredTurnIndex: null,
      hoveredTurnAnchorY: null
    };

    const mockHost = {
      scheduleDraw: () => { scheduled = true; },
      draw: () => {}
    };

    // Cursor at column 4, row 5 (comfortably in the gutter beside dot 2)
    const hoverEvent = {
      mouse: { x: 4, y: 5, button: 0, pressed: false },
      sequence: '\x1b[<35;5;6M'
    };
    const handled = handleTurnRailMouse(hoverEvent, mockSurface, mockHost);
    assert.equal(handled, true, 'Hover at column 4 should be within rail gutter hit zone');
    assert.equal(mockSurface.hoveredTurnIndex, 2, 'Turn 2 should be hovered');
  });
});
