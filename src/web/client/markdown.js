import { copyText } from './dom.js';
import { state } from './state.js';
import { isSafeHttpUrl, parseWorkspaceFileHref } from './validators.js';
let markdownCallbacks = {
    openFile: () => { },
    openInCanvas: () => { },
    openBrowserArtifact: () => { }
};
export function configureMarkdownCallbacks(cbs) {
    markdownCallbacks = cbs;
}
export function createInlineFileChip(label, fileInfo) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `md-file-chip${fileInfo.relPath ? '' : ' is-static'}`;
    btn.title = fileInfo.fullPath + fileInfo.lineBadge;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p1.setAttribute('d', 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z');
    const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    p2.setAttribute('points', '14 2 14 8 20 8');
    svg.appendChild(p1);
    svg.appendChild(p2);
    btn.appendChild(svg);
    const nameEl = document.createElement('span');
    nameEl.className = 'md-file-chip-name';
    const cleanLabel = String(label || '').replace(/^`|`$/g, '').trim();
    const showLabel = (cleanLabel && !cleanLabel.startsWith('/Users/') && !cleanLabel.startsWith('/home/'))
        ? cleanLabel
        : fileInfo.display;
    nameEl.textContent = showLabel;
    btn.appendChild(nameEl);
    if (fileInfo.lineBadge) {
        const ln = document.createElement('span');
        ln.className = 'md-file-chip-line';
        ln.textContent = fileInfo.lineBadge;
        btn.appendChild(ln);
    }
    if (fileInfo.relPath) {
        const targetRel = fileInfo.relPath;
        btn.addEventListener('click', () => { void markdownCallbacks.openFile(targetRel); });
    }
    return btn;
}
export function appendInlineNodes(parent, text) {
    let i = 0;
    const len = text.length;
    let buf = '';
    const flush = () => {
        if (buf) {
            parent.appendChild(document.createTextNode(buf));
            buf = '';
        }
    };
    while (i < len) {
        if (text[i] === '`') {
            const end = text.indexOf('`', i + 1);
            if (end > i + 1) {
                flush();
                const c = document.createElement('code');
                c.className = 'inline-code';
                c.textContent = text.slice(i + 1, end);
                parent.appendChild(c);
                i = end + 1;
                continue;
            }
        }
        if (text[i] === '*' && text[i + 1] === '*') {
            const end = text.indexOf('**', i + 2);
            if (end > i + 2) {
                flush();
                const s = document.createElement('strong');
                appendInlineNodes(s, text.slice(i + 2, end));
                parent.appendChild(s);
                i = end + 2;
                continue;
            }
        }
        if (text[i] === '*' && text[i + 1] !== ' ' && text[i + 1] !== '*') {
            const end = text.indexOf('*', i + 1);
            if (end > i + 1 && text[end - 1] !== ' ') {
                flush();
                const em = document.createElement('em');
                em.textContent = text.slice(i + 1, end);
                parent.appendChild(em);
                i = end + 1;
                continue;
            }
        }
        if (text[i] === '[') {
            const mid = text.indexOf('](', i + 1);
            const end = mid > -1 ? text.indexOf(')', mid + 2) : -1;
            if (mid > i + 1 && end > mid + 2) {
                const label = text.slice(i + 1, mid);
                const href = text.slice(mid + 2, end).trim();
                if (isSafeHttpUrl(href)) {
                    flush();
                    const a = document.createElement('a');
                    a.href = href;
                    a.target = '_blank';
                    a.rel = 'noopener noreferrer';
                    a.textContent = label.replace(/^`|`$/g, '');
                    parent.appendChild(a);
                    i = end + 1;
                    continue;
                }
                const fileInfo = parseWorkspaceFileHref(href, state.workspaceRoot);
                if (fileInfo) {
                    flush();
                    parent.appendChild(createInlineFileChip(label, fileInfo));
                    i = end + 1;
                    continue;
                }
            }
        }
        if (text[i] === 'h' && (text.startsWith('http://', i) || text.startsWith('https://', i))) {
            let j = i;
            while (j < len && !/[\s<>"'`\[\]]/.test(text[j] || ''))
                j += 1;
            let rawUrl = text.slice(i, j);
            let trail = '';
            while (rawUrl.length > 0 && /[.,;:!?)]/.test(rawUrl[rawUrl.length - 1] || '')) {
                trail = (rawUrl[rawUrl.length - 1] || '') + trail;
                rawUrl = rawUrl.slice(0, -1);
            }
            if (isSafeHttpUrl(rawUrl)) {
                flush();
                const a = document.createElement('a');
                a.href = rawUrl;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.textContent = rawUrl;
                parent.appendChild(a);
                if (trail)
                    buf += trail;
                i = j;
                continue;
            }
        }
        buf += text[i] || '';
        i += 1;
    }
    flush();
}
function createCodeCard(lang, codeText) {
    const normLang = String(lang || '').toLowerCase();
    const card = document.createElement('div');
    card.className = 'code-card';
    const head = document.createElement('div');
    head.className = 'code-head';
    const langSpan = document.createElement('span');
    const lineCount = codeText ? codeText.split('\n').length : 0;
    langSpan.textContent = `${lang || 'code'} · ${lineCount} lines`;
    const actions = document.createElement('div');
    actions.className = 'code-head-actions';
    if (normLang === 'html' || normLang === 'svg') {
        const prevBtn = document.createElement('button');
        prevBtn.type = 'button';
        prevBtn.className = 'code-btn';
        prevBtn.textContent = 'Live Preview';
        prevBtn.addEventListener('click', () => markdownCallbacks.openBrowserArtifact(`snippet.${normLang}`, codeText));
        actions.appendChild(prevBtn);
    }
    const canvasBtn = document.createElement('button');
    canvasBtn.type = 'button';
    canvasBtn.className = 'code-btn';
    canvasBtn.textContent = 'Open in Canvas';
    canvasBtn.addEventListener('click', () => {
        const ext = normLang && /^[a-z0-9]{1,8}$/.test(normLang) ? normLang : 'txt';
        markdownCallbacks.openInCanvas(`snippet.${ext}`, codeText, normLang === 'md' || normLang === 'markdown' || normLang === 'html' || normLang === 'svg');
    });
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'code-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => copyText(codeText, copyBtn));
    actions.appendChild(canvasBtn);
    actions.appendChild(copyBtn);
    head.appendChild(langSpan);
    head.appendChild(actions);
    const pre = document.createElement('pre');
    pre.className = 'code-pre';
    const codeEl = document.createElement('code');
    codeEl.textContent = codeText;
    pre.appendChild(codeEl);
    card.appendChild(head);
    card.appendChild(pre);
    return card;
}
function parseTableRow(line) {
    let trimmed = line.trim();
    if (trimmed.startsWith('|'))
        trimmed = trimmed.slice(1);
    if (trimmed.endsWith('|'))
        trimmed = trimmed.slice(0, -1);
    return trimmed.split('|').map((c) => c.trim());
}
function isTableDivider(line) {
    const cells = parseTableRow(line);
    if (cells.length === 0)
        return false;
    for (const c of cells) {
        if (!/^:?-{2,}:?$/.test(c))
            return false;
    }
    return true;
}
export function renderMarkdownInto(container, source, streaming) {
    container.textContent = '';
    const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
    let i = 0;
    while (i < lines.length) {
        const line = lines[i] ?? '';
        if (!line.trim()) {
            i += 1;
            continue;
        }
        if (line.trimStart().startsWith('```')) {
            const lang = line.trimStart().slice(3).trim().split(/\s+/)[0] || '';
            const codeLines = [];
            i += 1;
            while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith('```')) {
                codeLines.push(lines[i] ?? '');
                i += 1;
            }
            if (i < lines.length)
                i += 1;
            container.appendChild(createCodeCard(lang, codeLines.join('\n')));
            continue;
        }
        if (/^#{1,4}\s+/.test(line)) {
            const match = line.match(/^#+/);
            const level = Math.min(4, match ? match[0].length : 1);
            const h = document.createElement(`h${level}`);
            appendInlineNodes(h, line.slice(level).trim());
            container.appendChild(h);
            i += 1;
            continue;
        }
        if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
            container.appendChild(document.createElement('hr'));
            i += 1;
            continue;
        }
        if (line.trimStart().startsWith('> ')) {
            const bq = document.createElement('blockquote');
            const parts = [];
            while (i < lines.length && (lines[i] ?? '').trimStart().startsWith('> ')) {
                parts.push((lines[i] ?? '').trimStart().slice(2));
                i += 1;
            }
            appendInlineNodes(bq, parts.join(' '));
            container.appendChild(bq);
            continue;
        }
        if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1] ?? '')) {
            const wrap = document.createElement('div');
            wrap.className = 'md-table-wrap';
            const table = document.createElement('table');
            table.className = 'md-table';
            const thead = document.createElement('thead');
            const hr = document.createElement('tr');
            for (const hCell of parseTableRow(line)) {
                const th = document.createElement('th');
                appendInlineNodes(th, hCell);
                hr.appendChild(th);
            }
            thead.appendChild(hr);
            table.appendChild(thead);
            const tbody = document.createElement('tbody');
            i += 2;
            while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim()) {
                const tr = document.createElement('tr');
                for (const bCell of parseTableRow(lines[i] ?? '')) {
                    const td = document.createElement('td');
                    appendInlineNodes(td, bCell);
                    tr.appendChild(td);
                }
                tbody.appendChild(tr);
                i += 1;
            }
            table.appendChild(tbody);
            wrap.appendChild(table);
            container.appendChild(wrap);
            continue;
        }
        if (/^\s*[-*+]\s+/.test(line)) {
            const ul = document.createElement('ul');
            while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? '')) {
                const li = document.createElement('li');
                appendInlineNodes(li, (lines[i] ?? '').replace(/^\s*[-*+]\s+/, ''));
                ul.appendChild(li);
                i += 1;
            }
            container.appendChild(ul);
            continue;
        }
        if (/^\s*\d+\.\s+/.test(line)) {
            const ol = document.createElement('ol');
            while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? '')) {
                const li = document.createElement('li');
                appendInlineNodes(li, (lines[i] ?? '').replace(/^\s*\d+\.\s+/, ''));
                ol.appendChild(li);
                i += 1;
            }
            container.appendChild(ol);
            continue;
        }
        const paraLines = [];
        while (i < lines.length
            && (lines[i] ?? '').trim()
            && !(lines[i] ?? '').trimStart().startsWith('```')
            && !/^#{1,4}\s+/.test(lines[i] ?? '')
            && !/^\s*[-*+]\s+/.test(lines[i] ?? '')
            && !/^\s*\d+\.\s+/.test(lines[i] ?? '')
            && !(lines[i] ?? '').trimStart().startsWith('> ')) {
            paraLines.push(lines[i] ?? '');
            i += 1;
        }
        const p = document.createElement('p');
        appendInlineNodes(p, paraLines.join(' '));
        container.appendChild(p);
    }
    if (streaming) {
        const cursor = document.createElement('span');
        cursor.className = 'streaming-cursor';
        container.appendChild(cursor);
    }
}
