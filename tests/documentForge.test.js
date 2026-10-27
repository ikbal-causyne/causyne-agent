import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  compileDocumentHtml
} from '../src/documentEngine/documentForge.js';
import {
  formatScreenplayHtml,
  formatShotListHtml,
  analyzeVoiceOverTiming
} from '../src/documentEngine/screenplayFormatter.js';
import {
  auditTextContent,
  auditBudgetArithmetic
} from '../src/documentEngine/antiSlopAuditor.js';
import { documentForgeTool } from '../src/tools/documentForge.js';
import { TOOL_DEFINITIONS, toolRegistry } from '../src/tools/registry.js';

test('document forge: anti-slop audit catches long em-dashes and AI cliches', () => {
  const badText = `
In today's digital landscape, innovation is crucial — without question.
We will draft the proposal [Insert interviewee name here] for this document.
In conclusion, this project is a testament to cultural heritage and delves into deep themes.
`;

  const audit = auditTextContent(badText);
  assert.equal(audit.clean, false);
  const rules = audit.findings.map((f) => f.rule);
  assert.ok(rules.includes('no_long_em_dash'), 'Should catch long em-dash');
  assert.ok(rules.includes('no_ungrounded_placeholders'), 'Should catch placeholder brackets');
  assert.ok(rules.includes('anti_ai_slop_phrase_en'), 'Should catch English AI tropes');

  const goodText = 'Field documentation of traditional craft was conducted with visual ethnographic methods.';
  const cleanAudit = auditTextContent(goodText);
  assert.equal(cleanAudit.clean, true);
  assert.equal(cleanAudit.findings.length, 0);
});

test('document forge: budget arithmetic validates line items and gross-up taxes', () => {
  const spec = {
    categories: [
      {
        code: 'A',
        name: 'Pre-Production',
        items: [
          { name: 'Initial Research', volume: 1, frequency: 1, unitPrice: 2000000, total: 2000000 },
          { name: 'Location Scouting', volume: 2, frequency: 1, unitPrice: 1500000, total: 3000000 }
        ],
        subtotal: 5000000
      },
      {
        code: 'B',
        name: 'Production',
        items: [
          { name: 'Camera Rental', volume: 5, frequency: 1, unitPrice: 1000000, total: 5000000 }
        ],
        subtotal: 5000000
      }
    ],
    grossUpTaxRate: 0.025,
    targetGross: Math.round(10000000 / 0.975)
  };

  const res = auditBudgetArithmetic(spec);
  assert.equal(res.valid, true);
  assert.equal(res.totalCalculated, 10000000);
  assert.equal(res.grossCalculated, Math.round(10000000 / 0.975));
  assert.equal(res.differenceFromTarget, 0);

  // Mismatch case
  const badSpec = {
    categories: [
      {
        code: 'A',
        name: 'Production',
        items: [
          { name: 'Honorarium', volume: 3, frequency: 2, unitPrice: 1000000, total: 5000000 } // should be 6M
        ]
      }
    ]
  };
  const badRes = auditBudgetArithmetic(badSpec);
  assert.equal(badRes.valid, false);
  assert.ok(badRes.itemErrors.length > 0);
});

test('document forge: compiles formal HTML/CSS with editorial palette and A4 pagination', () => {
  const spec = {
    title: 'The Final Detonation: Archiving Traditional Technology',
    subtitle: 'Technical Documentation of Endangered Heritage Techniques',
    categoryOrKicker: 'GLOBAL HERITAGE INITIATIVE 2026',
    authorOrProposer: 'Elena Vance',
    palette: 'editorial_dair',
    includeCover: true,
    sections: [
      {
        title: 'Background',
        paragraphs: ['Traditional acoustic resonance systems utilize aged timber harvested during dry seasons.'],
        callout: 'Field research was concentrated across the valley workshops.'
      },
      {
        title: 'Funding Structure',
        table: {
          headers: ['Description', 'Quantity', 'Cost'],
          rows: [['Aged Timber Nodes', '10 Stalks', '$500.00']]
        }
      }
    ]
  };

  const compiled = compileDocumentHtml(spec);
  assert.ok(compiled.html.includes('The Final Detonation'));
  assert.ok(compiled.html.includes('Elena Vance'));
  assert.ok(compiled.html.includes('Prepared by: <strong>Elena Vance</strong>'));
  assert.ok(compiled.html.includes('cover-band-top'));
  assert.ok(compiled.css.includes('size: A4 portrait'));
  assert.ok(compiled.css.includes('--primary: #78281F'));
  assert.ok(compiled.css.includes('--accent: #D4AB0D'));
  assert.ok(compiled.css.includes('page: cover'));
});

test('document forge: formats Hollywood screenplay to standard Courier 12pt layout', () => {
  const spec = {
    title: 'THE LAST DETONATION',
    author: 'ALEX RIVERS',
    elements: [
      { type: 'scene_heading', text: 'INT. WORKSHOP - DAY' },
      { type: 'action', text: 'Smoke rises from a freshly hollowed bamboo tube. Old hands carefully measure sulfur.' },
      { type: 'character', text: 'MAESTRO' },
      { type: 'parenthetical', text: 'whispering reverence' },
      { type: 'dialogue', text: 'The bamboo must breathe before it sings.' },
      { type: 'transition', text: 'FADE OUT.' }
    ]
  };

  const script = formatScreenplayHtml(spec);
  assert.ok(script.html.includes('THE LAST DETONATION'));
  assert.ok(script.html.includes('INT. WORKSHOP - DAY'));
  assert.ok(script.html.includes('MAESTRO'));
  assert.ok(script.html.includes('(whispering reverence)'));
  assert.ok(script.html.includes('FADE OUT.'));
  assert.ok(script.css.includes('font-family: "Courier Prime"'));
  assert.ok(script.css.includes('margin: 1.0in 1.0in 1.0in 1.5in'));
});

test('document forge: generates production shot list with duration sums', () => {
  const shots = [
    {
      shotNumber: 1,
      scene: 'SC-01',
      framing: 'WS',
      angle: 'Eye-level',
      movement: 'Static',
      lens: '24mm',
      subject: 'Bamboo Grove',
      action: 'Morning fog drifts through tall bamboo stalks.',
      audioOrSfx: 'Wind rustle, distant bird call',
      durationSeconds: 4
    },
    {
      shotNumber: 2,
      scene: 'SC-01',
      framing: 'CU',
      angle: 'Low-angle',
      movement: 'Pan',
      lens: '85mm',
      subject: 'Machete on node',
      action: 'Carving the node edge cleanly.',
      audioOrSfx: 'Crisp wood chop SFX',
      durationSeconds: 3
    }
  ];

  const shotList = formatShotListHtml('Echoes Doc', shots);
  assert.ok(shotList.html.includes('Echoes Doc — Production Shot List'));
  assert.ok(shotList.html.includes('Total Shots: 2 | Est. Duration: 7s'));
  assert.ok(shotList.html.includes('Morning fog drifts'));
  assert.ok(shotList.css.includes('size: A4 landscape'));
});

test('document forge: analyzes VO pacing and detects WPM rate', () => {
  const blocks = [
    {
      id: 'VO1',
      timecode: '00-10s',
      text: 'This dedicated scientist has won the prestigious Nobel Prize in Physics for building a massive neutrino observatory deep within the ice of Antarctica.',
      targetDurationSeconds: 10
    },
    {
      id: 'VO2',
      timecode: '10-20s',
      text: 'Deep under the polar ice sheet scientists drilled eighty-six holes reaching nearly three times deeper than the highest skyscraper on earth to detect mysterious high energy ghost particles called neutrinos across the entire cosmos today.',
      targetDurationSeconds: 10
    }
  ];

  const analysis = analyzeVoiceOverTiming(blocks);
  assert.equal(analysis.blocks.length, 2);
  assert.equal(analysis.blocks[0].status, 'optimal'); // ~90-100 WPM
  assert.equal(analysis.blocks[1].status, 'too_fast'); // ~168 WPM
  assert.ok(analysis.totalWords > 30);
  assert.equal(analysis.totalDurationSeconds, 20);
});

test('document forge: tool schema and registry integration', async () => {
  assert.ok(toolRegistry.document_forge, 'document_forge missing from toolRegistry');
  const def = TOOL_DEFINITIONS.find((t) => t.name === 'document_forge');
  assert.ok(def, 'document_forge missing from TOOL_DEFINITIONS');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-docforge-test-'));
  try {
    const outHtml = path.join(tempDir, 'test_script.html');
    const res = await documentForgeTool.execute({
      action: 'format_screenplay',
      screenplaySpec: {
        title: 'AGENT TEST',
        elements: [{ type: 'scene_heading', text: 'EXT. STREET - NIGHT' }]
      },
      outputPath: outHtml
    });

    assert.ok(res.success);
    assert.ok(fs.existsSync(outHtml));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
