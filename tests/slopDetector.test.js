// P6 — the anti-AI-slop gate (Vision §7, ENFORCED).
//
// Until now the mandate was prompt-only: the playbook told the model what not to
// do, and the web guard made it LOOK at the result — but the model was the sole
// judge of what it saw, and one that just emitted a purple gradient hero does not
// reliably call its own work generic.
//
// The hardest requirement here is NOT catching slop. It is not crying wolf. A
// guard with false positives gets switched off, which is the exact lesson
// .agents/rules.json ZM-09 records about the malware guards. So roughly half of
// these tests assert that good, deliberate design passes clean.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeSource,
  analyzeFiles,
  isScannableFile,
  verdictFor,
  formatFindings,
  BORDERLINE_SCORE,
  SLOP_SCORE
} from '../src/slopDetector.js';
import { DESIGN_MOVEMENTS, getMovement, suggestMovements, formatMovementBrief } from '../src/designPalettes.js';

// The archetype: every signature at once.
const SLOP_PAGE = `<!DOCTYPE html><html><head><style>
body { font-family: system-ui, -apple-system, sans-serif; }
.hero { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); text-align: center; padding: 120px 0; }
.hero h1 { background: linear-gradient(135deg, #667eea, #764ba2); -webkit-background-clip: text; }
.card { box-shadow: 0 10px 30px rgba(0,0,0,0.1); border-radius: 12px; }
</style></head><body>
<section class="hero"><h1>Elevate Your Workflow</h1>
<a>Get Started</a><a>Learn More</a></section>
<div class="feature">🚀 Fast</div><div class="feature">✨ Beautiful</div><div class="feature">💡 Smart</div>
</body></html>`;

// Deliberate, committed design — brutalism.
const BRUTALIST_PAGE = `<!DOCTYPE html><html><head>
<link href="https://fonts.googleapis.com/css2?family=Archivo+Black" rel="stylesheet">
<style>
body { font-family: 'Courier New', monospace; background: #E8E8E3; color: #000; }
h1 { font-family: 'Archivo Black', Impact, sans-serif; font-size: 5rem; border-bottom: 4px solid #000; }
.entry { border: 3px solid #000; padding: 1rem; }
a { color: #0000EE; }
</style></head><body>
<h1>Ledger of Rainfall, 1974-2024</h1>
<p>Daily precipitation readings taken at the Kew station, transcribed from the paper logs.</p>
<div class="entry">1974-03-02 — 4.1mm</div>
</body></html>`;

describe('it catches the house style', () => {
  test('the archetypal generated landing page is scored as slop', () => {
    const result = analyzeSource(SLOP_PAGE);
    assert.equal(result.verdict, 'slop');
    assert.ok(result.score >= SLOP_SCORE, `scored only ${result.score}`);
  });

  test('it names the specific signatures rather than just complaining', () => {
    const ids = analyzeSource(SLOP_PAGE).findings.map(f => f.id);
    for (const expected of [
      'notorious-gradient-hexes',
      'purple-blue-gradient',
      'generic-marketing-copy',
      'emoji-as-icons',
      'default-typography',
      'cookie-cutter-layout'
    ]) {
      assert.ok(ids.includes(expected), `expected signature ${expected}`);
    }
  });

  test('every finding carries evidence and a concrete fix', () => {
    for (const finding of analyzeSource(SLOP_PAGE).findings) {
      assert.ok(finding.evidence && finding.evidence.length > 10, `${finding.id} has no evidence`);
      assert.ok(finding.fix && finding.fix.length > 20, `${finding.id} has no actionable fix`);
      assert.ok(Number.isFinite(finding.weight) && finding.weight > 0, `${finding.id} has no weight`);
    }
  });

  test('the stock gradient hexes are caught verbatim', () => {
    const css = '.a { background: linear-gradient(90deg, #667eea, #764ba2); }';
    assert.ok(analyzeSource(css).findings.some(f => f.id === 'notorious-gradient-hexes'));
  });
});

describe('it does NOT cry wolf', () => {
  test('committed brutalist design scores clean', () => {
    const result = analyzeSource(BRUTALIST_PAGE);
    assert.equal(result.verdict, 'clean');
    assert.equal(result.score, 0);
  });

  test('a deliberate purple brand identity is not condemned', () => {
    // A publication whose identity genuinely IS violet. It uses a purple
    // gradient — and that alone must not reach the blocking threshold, or the
    // gate would be telling real designers their taste is wrong.
    const page = `<html><head>
      <link href="https://fonts.googleapis.com/css2?family=Playfair+Display" rel="stylesheet">
      <style>
      body { font-family: 'Source Serif Pro', Georgia, serif; background: #FBF9F4; color: #1A1614; }
      h1 { font-family: 'Playfair Display', serif; font-size: 4.5rem; }
      .masthead { background: linear-gradient(160deg, #4C1D95, #2E1065); color: #F5F0FF; }
      </style></head><body>
      <div class="masthead"><h1>The Violet Review</h1>
      <p>Quarterly essays on typography, printed in Bristol since 1988.</p></div>
      <article><p>Issue 47 examines the return of metal type in small-press publishing.</p></article>
      </body></html>`;

    const result = analyzeSource(page);
    assert.notEqual(result.verdict, 'slop', `a real purple identity was flagged as slop (score ${result.score})`);
  });

  test('a plain document with no styling at all scores clean', () => {
    const result = analyzeSource('<html><body><h1>Notes</h1><p>Some text.</p></body></html>');
    assert.equal(result.score, 0);
  });

  test('one emoji in prose is not an icon set', () => {
    const page = '<html><body><p>Shipping today 🚀 — the release notes are below.</p></body></html>';
    assert.ok(!analyzeSource(page).findings.some(f => f.id === 'emoji-as-icons'));
  });

  test('a CSS fragment that sets no font is not a typography failure', () => {
    const css = '.grid { display: grid; gap: 1rem; }';
    assert.ok(!analyzeSource(css).findings.some(f => f.id === 'default-typography'));
  });

  test('a system-font stack that also loads a real typeface is fine', () => {
    const css = `@import url('https://fonts.googleapis.com/css2?family=Inter');
      body { font-family: Inter, system-ui, sans-serif; }`;
    assert.ok(!analyzeSource(css).findings.some(f => f.id === 'default-typography'));
  });

  test('a non-purple gradient is not a signature', () => {
    const css = '.warm { background: linear-gradient(120deg, #D62828, #F77F00); }';
    assert.ok(!analyzeSource(css).findings.some(f => f.id === 'purple-blue-gradient'));
  });

  test('a single hero section alone is not the cookie-cutter skeleton', () => {
    const page = '<html><body><section class="hero"><h1>Rainfall</h1></section></body></html>';
    assert.ok(!analyzeSource(page).findings.some(f => f.id === 'cookie-cutter-layout'));
  });
});

describe('thresholds are deliberately loose', () => {
  test('one mid-weight signal is a choice, not a verdict', () => {
    assert.equal(verdictFor(20), 'clean');
    assert.equal(verdictFor(BORDERLINE_SCORE), 'borderline');
    assert.equal(verdictFor(SLOP_SCORE), 'slop');
  });

  test('borderline never blocks — only "slop" does', () => {
    assert.ok(BORDERLINE_SCORE < SLOP_SCORE, 'there must be room between noticing and blocking');
  });
});

describe('multi-file analysis', () => {
  test('signals split across HTML and CSS are combined', () => {
    // The real shape of a project: the gradient lives in the stylesheet, the
    // copy in the markup. Judged separately, neither might cross the line.
    const result = analyzeFiles([
      { path: '/tmp/site/style.css', content: '.hero { background: linear-gradient(135deg, #667eea, #764ba2); }' },
      { path: '/tmp/site/index.html', content: '<section class="hero"><h1>Elevate Your Business</h1><a>Get Started</a><a>Learn More</a></section><div class="feature">a</div><div class="feature">b</div><div class="card">c</div>' }
    ]);
    assert.equal(result.verdict, 'slop');
    assert.equal(result.scanned.length, 2);
    assert.ok(result.findings.some(f => f.path.endsWith('style.css')));
  });

  test('non-rendered files are skipped, not scored', () => {
    assert.equal(isScannableFile('index.html'), true);
    assert.equal(isScannableFile('app.tsx'), true);
    assert.equal(isScannableFile('style.css'), true);
    assert.equal(isScannableFile('README.md'), false);
    assert.equal(isScannableFile('server.py'), false);

    const result = analyzeFiles([{ path: '/tmp/notes.md', content: 'Elevate your workflow 🚀✨💡' }]);
    assert.equal(result.scanned.length, 0);
    assert.equal(result.score, 0);
  });

  test('malformed input is survived, not thrown on', () => {
    assert.doesNotThrow(() => analyzeSource(null));
    assert.doesNotThrow(() => analyzeSource(undefined));
    assert.doesNotThrow(() => analyzeFiles(null));
    assert.doesNotThrow(() => analyzeFiles([null, { path: 'a.css' }]));
    assert.equal(analyzeSource(null).score, 0);
  });
});

describe('the corrective message is usable', () => {
  test('it states the score, the signatures and what to do instead', () => {
    const result = analyzeSource(SLOP_PAGE);
    const message = formatFindings(result, formatMovementBrief(suggestMovements([], 3)));

    assert.match(message, /ANTI-SLOP GATE/);
    assert.match(message, new RegExp(String(result.score)));
    assert.match(message, /Detected signatures/);
    assert.match(message, /Commit to ONE of these movements/);
    assert.match(message, /Do not simply swap one gradient for another/);
  });
});

describe('the positive half: curated design data', () => {
  test('every movement carries principles, a full palette and type', () => {
    assert.ok(DESIGN_MOVEMENTS.length >= 6, 'a handful of options is not diversity');
    for (const movement of DESIGN_MOVEMENTS) {
      assert.ok(movement.id && movement.name && movement.principles);
      for (const role of ['background', 'surface', 'ink', 'accent', 'muted']) {
        assert.match(movement.palette[role], /^#[0-9A-Fa-f]{6}$/, `${movement.id}.${role}`);
      }
      assert.ok(movement.fonts.display && movement.fonts.body);
    }
  });

  test('no movement ships the very palette the detector bans', () => {
    // The catalogue is what the agent is pushed toward. It would be absurd for
    // the suggested alternative to trip the gate.
    for (const movement of DESIGN_MOVEMENTS) {
      const css = Object.values(movement.palette).join(' ');
      const result = analyzeSource(`.x { background: linear-gradient(90deg, ${css}); }`);
      assert.ok(
        !result.findings.some(f => f.id === 'notorious-gradient-hexes'),
        `${movement.id} uses a banned stock colour`
      );
    }
  });

  test('suggestions steer away from what was used recently', () => {
    const recent = DESIGN_MOVEMENTS.slice(0, 2).map(m => m.id);
    const suggested = suggestMovements(recent, 3).map(m => m.id);
    for (const id of recent) {
      assert.ok(!suggested.includes(id), `${id} was just used and should not be suggested again`);
    }
  });

  test('getMovement resolves and fails cleanly', () => {
    assert.equal(getMovement('brutalist').name, 'Brutalism');
    assert.equal(getMovement('nope'), null);
  });
});
