import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { StageSurface } from '../src/tui/stageSurface.js';
import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';
import {
  formatPreviewCardMarkdown,
  renderTurnPreviewCard,
  overlayTurnPreviewCard,
  type SessionTurn
} from '../src/tui/turnRail.js';

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
});
