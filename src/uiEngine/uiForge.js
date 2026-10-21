/*
 * Copyright (c) 2011-2024 Thesys Inc.
 * SPDX-License-Identifier: MIT
 *
 * Adapted for Causyne UI Forge — Generative Component & Design Engine.
 */
/**
 * Generate semantic, modern HTML + CSS component code under Causyne UI Forge.
 */
export function generateHtmlComponent(spec) {
    const isDark = spec.theme !== 'light';
    const cardBg = isDark ? 'rgba(30, 41, 59, 0.75)' : 'rgba(255, 255, 255, 0.95)';
    const border = isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.1)';
    const text = isDark ? '#f8fafc' : '#0f172a';
    const textMuted = isDark ? '#94a3b8' : '#64748b';
    const accent = '#6366f1';
    const accentHover = '#4f46e5';
    const css = `
/* Causyne UI Forge Generated Styles - Responsive, Accessible & Performant */
.causyne-ui-root {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: ${text};
  line-height: 1.5;
  box-sizing: border-box;
}
.causyne-ui-root * { box-sizing: border-box; margin: 0; padding: 0; }
.causyne-ui-card {
  background: ${cardBg};
  backdrop-filter: blur(12px);
  border: 1px solid ${border};
  border-radius: 12px;
  padding: 24px;
  box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}
.causyne-ui-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 20px 30px -10px rgba(0, 0, 0, 0.3);
}
.causyne-ui-header { margin-bottom: 16px; }
.causyne-ui-title { font-size: 1.25rem; font-weight: 600; letter-spacing: -0.02em; }
.causyne-ui-desc { font-size: 0.875rem; color: ${textMuted}; margin-top: 4px; }
.causyne-ui-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin: 16px 0; }
.causyne-ui-stat-box {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid ${border};
  border-radius: 8px;
  padding: 16px;
}
.causyne-ui-stat-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: ${textMuted}; }
.causyne-ui-stat-value { font-size: 1.75rem; font-weight: 700; color: ${accent}; margin-top: 4px; }
.causyne-ui-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.15s ease;
}
.causyne-ui-btn-primary { background: ${accent}; color: #ffffff; }
.causyne-ui-btn-primary:hover { background: ${accentHover}; }
.causyne-ui-btn-secondary { background: transparent; border-color: ${border}; color: ${text}; }
.causyne-ui-btn-secondary:hover { background: rgba(255, 255, 255, 0.05); }
.causyne-ui-actions { display: flex; gap: 8px; margin-top: 20px; justify-content: flex-end; }
`.trim();
    let html = '';
    const title = spec.title || 'Component';
    const desc = spec.description || '';
    if (spec.type === 'dashboard-stats' || (spec.items && spec.items.length > 0)) {
        const itemsHtml = (spec.items || [])
            .map((item) => `
    <div class="causyne-ui-stat-box">
      <div class="causyne-ui-stat-label">${escapeHtml(item.label)}</div>
      <div class="causyne-ui-stat-value">${escapeHtml(String(item.value ?? '—'))}</div>
      ${item.description ? `<div class="causyne-ui-desc">${escapeHtml(item.description)}</div>` : ''}
    </div>`)
            .join('\n');
        html = `
<div class="causyne-ui-root">
  <div class="causyne-ui-card">
    <div class="causyne-ui-header">
      <h3 class="causyne-ui-title">${escapeHtml(title)}</h3>
      ${desc ? `<p class="causyne-ui-desc">${escapeHtml(desc)}</p>` : ''}
    </div>
    <div class="causyne-ui-grid">
${itemsHtml}
    </div>
    ${renderActions(spec.actions)}
  </div>
</div>`.trim();
    }
    else {
        html = `
<div class="causyne-ui-root">
  <div class="causyne-ui-card">
    <div class="causyne-ui-header">
      <h3 class="causyne-ui-title">${escapeHtml(title)}</h3>
      ${desc ? `<p class="causyne-ui-desc">${escapeHtml(desc)}</p>` : ''}
    </div>
    ${renderActions(spec.actions)}
  </div>
</div>`.trim();
    }
    return { html, css };
}
function renderActions(actions) {
    if (!actions || actions.length === 0)
        return '';
    const btns = actions
        .map((a) => `<button class="causyne-ui-btn ${a.primary ? 'causyne-ui-btn-primary' : 'causyne-ui-btn-secondary'}" data-action="${escapeHtml(a.action)}">${escapeHtml(a.label)}</button>`)
        .join('\n      ');
    return `
    <div class="causyne-ui-actions">
      ${btns}
    </div>`;
}
function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
/**
 * Generate full self-contained preview document.
 */
export function generatePreviewHtml(html, css, theme = 'dark') {
    const bg = theme === 'dark' ? '#0b0f19' : '#f1f5f9';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Causyne UI Forge Preview</title>
  <style>
    body {
      margin: 0;
      padding: 40px 20px;
      min-height: 100vh;
      background: ${bg};
      display: flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
    }
    ${css}
  </style>
</head>
<body>
  ${html}
</body>
</html>`;
}
/**
 * Generate React + Tailwind component code under Causyne UI Forge.
 */
export function generateReactComponent(spec) {
    const compName = (spec.name || 'CausyneCard').replace(/[^a-zA-Z0-9]/g, '');
    const title = spec.title || 'Component';
    const desc = spec.description || '';
    return `import React from 'react';

export interface ${compName}Props {
  title?: string;
  description?: string;
}

export const ${compName}: React.FC<${compName}Props> = ({
  title = "${title}",
  description = "${desc}"
}) => {
  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-900/80 p-6 backdrop-blur-md shadow-xl transition-all hover:shadow-2xl">
      <div className="mb-4">
        <h3 className="text-xl font-semibold tracking-tight text-white">{title}</h3>
        {description && <p className="mt-1 text-sm text-slate-400">{description}</p>}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 my-4">
        ${(spec.items || [])
        .map((item) => `
        <div key="${item.id || item.label}" className="rounded-lg border border-slate-800 bg-slate-800/40 p-4">
          <div className="text-xs font-medium uppercase tracking-wider text-slate-400">${item.label}</div>
          <div className="mt-1 text-2xl font-bold text-indigo-400">${item.value ?? '—'}</div>
          ${item.description ? `<p className="mt-1 text-xs text-slate-500">${item.description}</p>` : ''}
        </div>`)
        .join('')}
      </div>
      ${(spec.actions && spec.actions.length > 0)
        ? `
      <div className="mt-6 flex justify-end gap-3">
        ${spec.actions
            .map((a) => `
        <button className="px-4 py-2 text-sm font-medium rounded-lg transition-colors ${a.primary
            ? 'bg-indigo-600 text-white hover:bg-indigo-500'
            : 'border border-slate-700 text-slate-300 hover:bg-slate-800'}">
          ${a.label}
        </button>`)
            .join('')}
      </div>`
        : ''}
    </div>
  );
};

export default ${compName};
`;
}
