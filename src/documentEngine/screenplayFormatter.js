/*
 * Copyright (c) 2026 Causyne.
 * SPDX-License-Identifier: BUSL-1.1
 *
 * Hollywood Standard Screenplay & Production Shot List Formatter.
 * Enforces industry Courier 12pt specifications, 1-page-per-minute timing,
 * director's shot list grids, and voice-over (VO) timing synchronization.
 */
/**
 * Generate industry-standard Hollywood Screenplay HTML + CSS.
 * Courier 12pt, 1.5in left margin, centered character cues, constrained dialogue width.
 */
export function formatScreenplayHtml(spec) {
    const css = `
/* Hollywood Industry Standard Screenplay Layout */
@page {
  size: letter portrait;
  margin: 1.0in 1.0in 1.0in 1.5in;
  @top-right {
    content: counter(page) ".";
    font-family: "Courier Prime", "Courier Final Draft", Courier, monospace;
    font-size: 10pt;
  }
}
@page :first {
  @top-right { content: normal; }
}

html {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

body {
  margin: 0;
  padding: 0;
  font-family: "Courier Prime", "Courier Final Draft", Courier, monospace;
  font-size: 12pt;
  line-height: 1.0;
  color: #000000;
  background: #ffffff;
}

.script-title-page {
  page-break-after: always;
  height: 9.0in;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  text-align: center;
}
.script-title {
  font-size: 18pt;
  font-weight: bold;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-bottom: 24pt;
}
.script-by {
  font-size: 12pt;
  margin-bottom: 12pt;
}
.script-author {
  font-size: 12pt;
  text-transform: uppercase;
  margin-bottom: 48pt;
}

.element-scene_heading {
  font-weight: bold;
  text-transform: uppercase;
  margin-top: 18pt;
  margin-bottom: 10pt;
  page-break-after: avoid;
}

.element-action {
  margin-bottom: 12pt;
  line-height: 1.25;
  text-align: left;
}

.element-character {
  text-transform: uppercase;
  margin-left: 2.2in;
  margin-top: 14pt;
  margin-bottom: 0;
  page-break-after: avoid;
}

.element-parenthetical {
  margin-left: 1.6in;
  width: 2.5in;
  margin-top: 0;
  margin-bottom: 0;
  page-break-after: avoid;
}

.element-dialogue {
  margin-left: 1.0in;
  width: 3.5in;
  line-height: 1.2;
  margin-top: 2pt;
  margin-bottom: 12pt;
}

.element-transition {
  text-transform: uppercase;
  text-align: right;
  margin-top: 14pt;
  margin-bottom: 14pt;
  page-break-after: avoid;
}
`.trim();
    let bodyContent = '';
    if (spec.title) {
        bodyContent += `
<div class="script-title-page">
  <div class="script-title">${escapeHtml(spec.title)}</div>
  <div class="script-by">written by</div>
  <div class="script-author">${escapeHtml(spec.author || 'Anonymous')}</div>
  ${spec.contact ? `<div style="margin-top: auto; font-size: 10pt;">${escapeHtml(spec.contact)}</div>` : ''}
</div>`;
    }
    bodyContent += '<div class="script-body">';
    for (const el of spec.elements) {
        const escaped = escapeHtml(el.text);
        switch (el.type) {
            case 'scene_heading':
                bodyContent += `\n<div class="element-scene_heading">${escaped}</div>`;
                break;
            case 'action':
                bodyContent += `\n<div class="element-action">${escaped}</div>`;
                break;
            case 'character':
                bodyContent += `\n<div class="element-character">${escaped}</div>`;
                break;
            case 'parenthetical':
                bodyContent += `\n<div class="element-parenthetical">(${escaped.replace(/^\(|\)$/g, '')})</div>`;
                break;
            case 'dialogue':
                bodyContent += `\n<div class="element-dialogue">${escaped}</div>`;
                break;
            case 'transition':
                bodyContent += `\n<div class="element-transition">${escaped}</div>`;
                break;
        }
    }
    bodyContent += '\n</div>';
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(spec.title)}</title>
  <style>
${css}
  </style>
</head>
<body>
${bodyContent}
</body>
</html>`;
    return { html, css };
}
/**
 * Format Production Shot List as print-ready HTML table.
 */
export function formatShotListHtml(title, shots) {
    const css = `
@page {
  size: A4 landscape;
  margin: 15mm;
  @bottom-right {
    content: "Page " counter(page) " of " counter(pages);
    font-size: 9pt;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
}
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 9.5pt;
  color: #111827;
  margin: 0;
  padding: 0;
}
.header {
  margin-bottom: 16px;
  border-bottom: 2px solid #0f172a;
  padding-bottom: 8px;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.title {
  font-size: 16pt;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.subtitle {
  font-size: 10pt;
  color: #4b5563;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 8px;
}
th {
  background: #0f172a;
  color: #ffffff;
  font-weight: 600;
  text-align: left;
  padding: 8px 10px;
  font-size: 8.5pt;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
td {
  padding: 8px 10px;
  border-bottom: 1px solid #e2e8f0;
  vertical-align: top;
  line-height: 1.4;
}
tr:nth-child(even) td {
  background: #f8fafc;
}
tr {
  page-break-inside: avoid;
}
.badge {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 7.5pt;
  font-weight: 600;
  background: #e0e7ff;
  color: #3730a3;
}
`.trim();
    let totalDuration = 0;
    const rows = shots
        .map((s) => {
        totalDuration += s.durationSeconds;
        return `
    <tr>
      <td style="font-weight: bold; width: 40px;">${escapeHtml(String(s.shotNumber))}</td>
      <td style="width: 70px;">${escapeHtml(s.scene || '-')}</td>
      <td style="width: 70px;"><span class="badge">${escapeHtml(s.framing)}</span></td>
      <td style="width: 90px;">${escapeHtml(s.angle || 'Eye-level')}</td>
      <td style="width: 90px;">${escapeHtml(s.movement || 'Static')}</td>
      <td style="width: 60px;">${escapeHtml(s.lens || '-')}</td>
      <td><strong>${escapeHtml(s.subject)}</strong> — ${escapeHtml(s.action)}</td>
      <td style="width: 160px; font-size: 8.5pt; color: #475569;">${escapeHtml(s.audioOrSfx || '-')}</td>
      <td style="text-align: right; font-weight: 600; width: 50px;">${s.durationSeconds}s</td>
    </tr>`;
    })
        .join('');
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)} - Shot List</title>
  <style>${css}</style>
</head>
<body>
  <div class="header">
    <div class="title">${escapeHtml(title)} — Production Shot List</div>
    <div class="subtitle">Total Shots: ${shots.length} | Est. Duration: ${totalDuration}s (${(totalDuration / 60).toFixed(1)} min)</div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Shot</th>
        <th>Scene</th>
        <th>Framing</th>
        <th>Angle</th>
        <th>Movement</th>
        <th>Lens</th>
        <th>Subject & Action Description</th>
        <th>Audio / SFX Cue</th>
        <th style="text-align: right;">Dur</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>`;
    return { html, css };
}
/**
 * Analyze Voice-Over / Dubbing blocks for Word-Per-Minute (WPM) cadence.
 * Target: 130-155 WPM for natural documentary/commercial narration.
 */
export function analyzeVoiceOverTiming(blocks) {
    let totalWords = 0;
    let totalDuration = 0;
    const analyzed = blocks.map((b) => {
        const words = b.text.trim().split(/\s+/).filter(Boolean).length;
        totalWords += words;
        totalDuration += b.targetDurationSeconds;
        const minutes = b.targetDurationSeconds / 60;
        const wpm = minutes > 0 ? Math.round(words / minutes) : 0;
        let status = 'optimal';
        if (wpm > 165)
            status = 'too_fast';
        else if (wpm < 115)
            status = 'too_slow';
        return {
            id: b.id,
            timecode: b.timecode,
            text: b.text,
            wordCount: words,
            targetDurationSeconds: b.targetDurationSeconds,
            wpm,
            status
        };
    });
    const avgMinutes = totalDuration / 60;
    const averageWpm = avgMinutes > 0 ? Math.round(totalWords / avgMinutes) : 0;
    return {
        blocks: analyzed,
        totalWords,
        totalDurationSeconds: totalDuration,
        averageWpm
    };
}
function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
