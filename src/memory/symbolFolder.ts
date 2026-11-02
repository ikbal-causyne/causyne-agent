/**
 * @file src/memory/symbolFolder.ts
 * Structural Code Symbol Folding (`foldSourceFileOutline`) for Causyne Agent.
 *
 * Extracts top-level and class-member symbol signatures (including multi-line
 * function and method signatures), JSDoc summaries, and exact `[lineStart, lineEnd]`
 * line spans while folding implementation bodies. Allows the agent to inspect a
 * 1,500-line file in ~120 tokens and then read only the exact `[lineStart, lineEnd]`
 * slice with `fs_read`.
 *
 * Authorship: Strict TypeScript (Causyne Agent).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FoldedFileOutline, FoldedSymbolEntry, FoldedSymbolKind } from './episodicTypes.js';

const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.kt': 'kotlin',
  '.java': 'java'
};

interface RawPattern {
  readonly kind: FoldedSymbolKind;
  readonly regex: RegExp;
  readonly nameGroup: number;
}

const TS_JS_PATTERNS: readonly RawPattern[] = [
  {
    kind: 'function',
    regex: /^(\s*)(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]*>)?\s*\(/,
    nameGroup: 5
  },
  {
    kind: 'class',
    regex: /^(\s*)(export\s+)?(default\s+)?(abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+[^{]+)?/,
    nameGroup: 5
  },
  {
    kind: 'interface',
    regex: /^(\s*)(export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+[^{]+)?/,
    nameGroup: 3
  },
  {
    kind: 'type',
    regex: /^(\s*)(export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]*>)?\s*=/,
    nameGroup: 3
  },
  {
    kind: 'enum',
    regex: /^(\s*)(export\s+)?(const\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    nameGroup: 4
  },
  {
    kind: 'const',
    regex: /^(\s*)(export\s+)(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*[^=]+)?\s*=/,
    nameGroup: 3
  },
  {
    kind: 'method',
    regex: /^(\s{2,4})(?:(?:public|private|protected|static|readonly|override|async)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]*>)?\s*\(/,
    nameGroup: 2
  }
];

const PYTHON_PATTERNS: readonly RawPattern[] = [
  {
    kind: 'class',
    regex: /^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*:/,
    nameGroup: 2
  },
  {
    kind: 'function',
    regex: /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    nameGroup: 2
  }
];

const GO_RUST_PATTERNS: readonly RawPattern[] = [
  {
    kind: 'function',
    regex: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:func|fn)\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/,
    nameGroup: 2
  },
  {
    kind: 'class',
    regex: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct|struct\s+([A-Za-z_][A-Za-z0-9_]*))/,
    nameGroup: 2
  }
];

const RESERVED_METHOD_NAMES: ReadonlySet<string> = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'try', 'else', 'do', 'super', 'import', 'require'
]);

function extractPrecedingDocComment(lines: readonly string[], lineIndex: number): string | undefined {
  let idx = lineIndex - 1;
  while (idx >= 0 && (lines[idx] ?? '').trim() === '') {
    idx--;
  }
  if (idx < 0) return undefined;
  const line = (lines[idx] ?? '').trim();
  if (line.endsWith('*/')) {
    const docLines: string[] = [];
    while (idx >= 0) {
      const current = (lines[idx] ?? '').trim();
      const cleaned = current
        .replace(/^\/\*\*?/, '')
        .replace(/\*\/$/, '')
        .replace(/^\*\s?/, '')
        .trim();
      if (cleaned && !cleaned.startsWith('@')) {
        docLines.unshift(cleaned);
      }
      if (current.startsWith('/*')) break;
      idx--;
    }
    const summary = docLines.join(' ').trim();
    return summary ? summary.slice(0, 110) : undefined;
  }
  if (line.startsWith('//') || line.startsWith('#')) {
    const cleaned = line.replace(/^(?:\/\/+|#+)\s*/, '').trim();
    return cleaned ? cleaned.slice(0, 110) : undefined;
  }
  return undefined;
}

/**
 * Collapse a single-line or multi-line declaration header into a concise one-line signature.
 */
function extractCollapsedSignature(lines: readonly string[], startIndex: number, kind: FoldedSymbolKind): string {
  const firstLine = (lines[startIndex] ?? '').trim();
  if (kind !== 'function' && kind !== 'method') {
    return firstLine.replace(/\s*\{$/, '').slice(0, 100);
  }
  let combined = '';
  let parenDepth = 0;
  let seenOpenParen = false;
  const maxLookahead = Math.min(lines.length, startIndex + 12);
  for (let i = startIndex; i < maxLookahead; i++) {
    const part = (lines[i] ?? '').trim();
    combined += (combined ? ' ' : '') + part;
    for (let c = 0; c < part.length; c++) {
      const ch = part[c];
      if (ch === '(') {
        parenDepth += 1;
        seenOpenParen = true;
      } else if (ch === ')') {
        parenDepth -= 1;
      }
    }
    if (seenOpenParen && parenDepth <= 0) {
      break;
    }
  }
  return combined
    .replace(/\s+/g, ' ')
    .replace(/\s*\{[^)]*$/, '')
    .trim()
    .slice(0, 110);
}

function findBraceBlockEnd(lines: readonly string[], startIndex: number, kind: FoldedSymbolKind): number {
  const isCallable = kind === 'function' || kind === 'method';
  let inBlockComment = false;
  let parenDepth = 0;
  let seenParamsOpen = false;
  let seenParamsClose = !isCallable;
  let typeBraceDepth = 0;
  let bodyDepth = 0;
  let bodyOpened = false;
  let lastNonWs = '';

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i] ?? '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inTemplate = false;

    for (let c = 0; c < line.length; c++) {
      const ch = line[c] ?? '';
      const next = line[c + 1] ?? '';

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          c += 1;
        }
        continue;
      }

      if (ch === '\\') {
        c += 1;
        continue;
      }

      if (inSingleQuote) {
        if (ch === '\'') inSingleQuote = false;
        continue;
      }
      if (inDoubleQuote) {
        if (ch === '"') inDoubleQuote = false;
        continue;
      }
      if (inTemplate) {
        if (ch === '`') inTemplate = false;
        continue;
      }

      if (ch === '/' && next === '/') {
        break;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        c += 1;
        continue;
      }
      if (ch === '\'') {
        inSingleQuote = true;
        if (seenParamsClose && !bodyOpened && typeBraceDepth === 0) lastNonWs = ch;
        continue;
      }
      if (ch === '"') {
        inDoubleQuote = true;
        if (seenParamsClose && !bodyOpened && typeBraceDepth === 0) lastNonWs = ch;
        continue;
      }
      if (ch === '`') {
        inTemplate = true;
        if (seenParamsClose && !bodyOpened && typeBraceDepth === 0) lastNonWs = ch;
        continue;
      }

      if (!seenParamsClose) {
        if (ch === '(') {
          parenDepth += 1;
          seenParamsOpen = true;
        } else if (ch === ')') {
          parenDepth -= 1;
          if (seenParamsOpen && parenDepth <= 0) {
            seenParamsClose = true;
            parenDepth = 0;
            lastNonWs = ')';
          }
        }
        continue;
      }

      if (!bodyOpened) {
        if (typeBraceDepth > 0) {
          if (ch === '{') {
            typeBraceDepth += 1;
          } else if (ch === '}') {
            typeBraceDepth -= 1;
            if (typeBraceDepth <= 0) {
              typeBraceDepth = 0;
              lastNonWs = '}';
            }
          }
          continue;
        }

        if (ch === '(') {
          parenDepth += 1;
          lastNonWs = '(';
        } else if (ch === ')') {
          parenDepth = Math.max(0, parenDepth - 1);
          lastNonWs = ')';
        } else if (ch === '{') {
          if (
            isCallable &&
            (parenDepth > 0 ||
              lastNonWs === ':' ||
              lastNonWs === '|' ||
              lastNonWs === '&' ||
              lastNonWs === '<' ||
              lastNonWs === ',' ||
              lastNonWs === '=')
          ) {
            typeBraceDepth = 1;
          } else {
            bodyOpened = true;
            bodyDepth = 1;
          }
        } else if (ch === ';' && parenDepth === 0) {
          return i + 1;
        } else if (!/\s/.test(ch)) {
          lastNonWs = ch;
        }
      } else {
        if (ch === '{') {
          bodyDepth += 1;
        } else if (ch === '}') {
          bodyDepth -= 1;
          if (bodyDepth <= 0) {
            return i + 1;
          }
        }
      }
    }
  }
  return Math.min(lines.length, startIndex + 1);
}

function findIndentBlockEnd(lines: readonly string[], startIndex: number): number {
  const startLine = lines[startIndex] ?? '';
  const baseIndent = (startLine.match(/^\s*/)?.[0] ?? '').length;
  let lastLine = startIndex + 1;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = (line.match(/^\s*/)?.[0] ?? '').length;
    if (indent <= baseIndent) {
      return lastLine;
    }
    lastLine = i + 1;
  }
  return lastLine;
}

/**
 * Fold a source code string into a compact structural symbol outline.
 */
export function foldSourceContentOutline(
  content: string,
  filePath: string,
  queryFilter?: string
): FoldedFileOutline {
  const ext = path.extname(filePath).toLowerCase();
  const language = LANGUAGE_BY_EXT[ext] ?? 'text';
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;

  let importCount = 0;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('import ') || t.startsWith('from ') || t.startsWith('use ') || t.startsWith('package ')) {
      importCount += 1;
    }
  }

  const patterns = language === 'python'
    ? PYTHON_PATTERNS
    : (language === 'go' || language === 'rust')
      ? GO_RUST_PATTERNS
      : TS_JS_PATTERNS;

  const symbols: FoldedSymbolEntry[] = [];
  const lowerQuery = queryFilter ? queryFilter.toLowerCase().trim() : '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) {
      continue;
    }

    for (const pat of patterns) {
      const m = pat.regex.exec(line);
      if (!m) continue;
      const rawName = m[pat.nameGroup] || m[3] || '';
      if (!rawName || RESERVED_METHOD_NAMES.has(rawName)) continue;

      // For class method pattern, ensure it is not a bodyless call ending in `;`
      if (pat.kind === 'method') {
        const sigCheck = extractCollapsedSignature(lines, i, 'method');
        if (sigCheck.endsWith(';')) continue;
      }

      const exported = /\bexport\b|\bpub\b/.test(line);
      const lineStart = i + 1;
      const lineEnd = language === 'python'
        ? findIndentBlockEnd(lines, i)
        : findBraceBlockEnd(lines, i, pat.kind);
      const signature = extractCollapsedSignature(lines, i, pat.kind);
      const docComment = extractPrecedingDocComment(lines, i);

      // Advance past non-class symbol bodies so statements inside functions/methods aren't misread as methods
      if (pat.kind !== 'class') {
        i = Math.max(i, lineEnd - 1);
      }

      if (lowerQuery) {
        const hay = `${rawName} ${signature} ${docComment ?? ''}`.toLowerCase();
        if (!hay.includes(lowerQuery)) break;
      }

      symbols.push({
        name: rawName,
        kind: pat.kind,
        signature,
        lineStart,
        lineEnd,
        exported,
        ...(docComment ? { docComment } : {})
      });
      break;
    }
  }

  const header = `${path.basename(filePath)} (${language}, ${totalLines} lines, ${importCount} imports, ${symbols.length} symbols)`;
  const bodyLines = symbols.map((sym) => {
    const exp = sym.exported ? 'export ' : '';
    const doc = sym.docComment ? ` — ${sym.docComment}` : '';
    return `  [${sym.lineStart}-${sym.lineEnd}] ${exp}${sym.kind} ${sym.name}${doc}`;
  });

  const renderedOutline = [
    header,
    ...(bodyLines.length > 0 ? bodyLines : ['  (no structural symbols matched)']),
    `Use fs_read with startLine/endLine to unfold a specific [lineStart-lineEnd] symbol.`
  ].join('\n');

  return {
    filePath,
    language,
    totalLines,
    importCount,
    symbols,
    renderedOutline
  };
}

/**
 * Read a file from disk and fold it into a compact structural symbol outline.
 */
export function foldSourceFileOutline(filePath: string, queryFilter?: string): FoldedFileOutline {
  const expanded = filePath.startsWith('~/')
    ? path.join(os.homedir(), filePath.slice(2))
    : filePath;
  const resolved = path.resolve(expanded);
  const content = fs.readFileSync(resolved, 'utf8');
  return foldSourceContentOutline(content, resolved, queryFilter);
}
