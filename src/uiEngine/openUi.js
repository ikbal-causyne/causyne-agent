/*
 * Copyright (c) 2011-2024 Thesys Inc.
 * SPDX-License-Identifier: MIT
 *
 * Adapted for Causyne Agent Generative UI & Component Engine.
 */
/**
 * Generate semantic, modern HTML + CSS component code.
 */
export function generateHtmlComponent(spec) {
    const isDark = spec.theme !== 'light';
    const bg = isDark ? '#0f172a' : '#f8fafc';
    const cardBg = isDark ? 'rgba(30, 41, 59, 0.7)' : 'rgba(255, 255, 255, 0.9)';
    const border = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
    const text = isDark ? '#f8fafc' : '#0f172a';
    const textMuted = isDark ? '#94a3b8' : '#64748b';
    const accent = '#6366f1';
    const accentHover = '#4f46e5';
    const css = `
/* OpenUI Generated Component Styles - Responsive & Accessible */
.openui-root {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: ${text};
  line-height: 1.5;
  box-sizing: border-box;
}
.openui-root * { box-sizing: border-box; margin: 0; padding: 0; }
.openui-card {
  background: ${cardBg};
  backdrop-filter: blur(12px);
  border: 1px solid ${border};
  border-radius: 12px;
  padding: 24px;
  box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}
.openui-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 20px 30px -10px rgba(0, 0, 0, 0.3);
}
.openui-header { margin-bottom: 16px; }
.openui-title { font-size: 1.25rem; font-weight: 600; letter-spacing: -0.02em; }
.openui-desc { font-size: 0.875rem; color: ${textMuted}; margin-top: 4px; }
.openui-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin: 16px 0; }
.openui-stat-box {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid ${border};
  border-radius: 8px;
  padding: 16px;
}
.openui-stat-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: ${textMuted}; }
.openui-stat-value { font-size: 1.75rem; font-weight: 700; color: ${accent}; margin-top: 4px; }
.openui-btn {
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
.openui-btn-primary { background: ${accent}; color: #ffffff; }
.openui-btn-primary:hover { background: ${accentHover}; }
.openui-btn-secondary { background: transparent; border-color: ${border}; color: ${text}; }
.openui-btn-secondary:hover { background: rgba(255, 255, 255, 0.05); }
.openui-actions { display: flex; gap: 8px; margin-top: 20px; justify-content: flex-end; }
`.trim();
    let html = '';
    const title = spec.title || 'Component';
    const desc = spec.description || '';
    if (spec.type === 'dashboard-stats' || (spec.items && spec.items.length > 0)) {
        const itemsHtml = (spec.items || [])
            .map((item) => `
    <div class="openui-stat-box">
      <div class="openui-stat-label">${escapeHtml(item.label)}</div>
      <div class="openui-stat-value">${escapeHtml(String(item.value ?? '—'))}</div>
      ${item.description ? `<div class="openui-desc">${escapeHtml(item.description)}</div>` : ''}
    </div>`)
            .join('\n');
        html = `
<div class="openui-root">
  <div class="openui-card">
    <div class="openui-header">
      <h3 class="openui-title">${escapeHtml(title)}</h3>
      ${desc ? `<p class="openui-desc">${escapeHtml(desc)}</p>` : ''}
    </div>
    <div class="openui-grid">
${itemsHtml}
    </div>
    ${renderActions(spec.actions)}
  </div>
</div>`.trim();
    }
    else {
        // General card or form
        html = `
<div class="openui-root">
  <div class="openui-card">
    <div class="openui-header">
      <h3 class="openui-title">${escapeHtml(title)}</h3>
      ${desc ? `<p class="openui-desc">${escapeHtml(desc)}</p>` : ''}
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
        .map((a) => `<button class="openui-btn ${a.primary ? 'openui-btn-primary' : 'openui-btn-secondary'}" data-action="${escapeHtml(a.action)}">${escapeHtml(a.label)}</button>`)
        .join('\n      ');
    return `
    <div class="openui-actions">
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
  <title>OpenUI Component Preview</title>
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
 * Generate React + Tailwind component code.
 */
export function generateReactComponent(spec) {
    const compName = (spec.name || 'GeneratedCard').replace(/[^a-zA-Z0-9]/g, '');
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
