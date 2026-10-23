// Claude Code Continuum Adapter: scans projects in ~/.claude/projects.
// Authorship: Strict TypeScript (Causyne Agent).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BaseContinuumAdapter, readBoundedLines } from './base.js';
import type { ContinuumSessionSummary, ContinuumSessionDetail, ContinuumMessage } from '../types.js';
import { cleanUserText, cleanAssistantText, deriveSessionTitle } from '../sanitizer.js';

function extractClaudeText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const block = part as Record<string, unknown>;
          if (block.type === 'text' && typeof block.text === 'string') {
            return block.text;
          }
          if (typeof block.text === 'string') {
            return block.text;
          }
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export class ClaudeCodeAdapter extends BaseContinuumAdapter {
  readonly platform = 'claude_code' as const;
  readonly label = 'Claude Code';

  private readonly projectsDir = path.join(os.homedir(), '.claude/projects');

  isAvailable(): boolean {
    return fs.existsSync(this.projectsDir);
  }

  async listSessions(limit = 100): Promise<ContinuumSessionSummary[]> {
    if (!this.isAvailable()) return [];

    const summaries: ContinuumSessionSummary[] = [];

    try {
      const projectDirs = fs.readdirSync(this.projectsDir);

      for (const pdir of projectDirs) {
        if (pdir.includes('..') || pdir.includes('/') || pdir.includes('\\')) continue;
        const fullPdir = path.join(this.projectsDir, pdir);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPdir);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;

        const files = fs.readdirSync(fullPdir);
        for (const file of files) {
          if (!file.endsWith('.jsonl') || file.includes('..')) continue;
          const fpath = path.join(fullPdir, file);
          try {
            const fstat = fs.statSync(fpath);
            const sessionId = file.replace('.jsonl', '');
            const humanProject = pdir.replace(/^-Users-[^-]+-?/, '').replace(/-/g, ' ');

            summaries.push({
              id: `claude:${pdir}/${sessionId}`,
              sourcePlatform: this.platform,
              sourceLabel: this.label,
              title: `Claude Code: ${humanProject || 'Session'}`,
              workspacePath: pdir.replace(/^-/, '/').replace(/-/g, '/'),
              updatedAt: fstat.mtimeMs,
              messageCount: 1,
              snippet: `Claude Code project session in ${humanProject}`
            });
          } catch {
            // Skip unreadable file
          }
        }
      }
    } catch {
      return [];
    }

    return summaries
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  async getSession(id: string): Promise<ContinuumSessionDetail | null> {
    if (!this.isAvailable()) return null;
    const rawPath = id.startsWith('claude:') ? id.slice('claude:'.length) : id;

    // Security: reject path traversal
    if (!rawPath || rawPath.includes('..') || rawPath.includes('\0') || path.isAbsolute(rawPath)) {
      return null;
    }

    const fpath = path.join(this.projectsDir, `${rawPath}.jsonl`);
    const resolvedPath = path.resolve(fpath);
    if (!resolvedPath.startsWith(path.resolve(this.projectsDir) + path.sep)) {
      return null;
    }

    if (!fs.existsSync(fpath)) return null;

    const messages: ContinuumMessage[] = [];
    let title = `Claude Code Session ${path.basename(rawPath).slice(0, 8)}`;
    let workspace = '';

    try {
      const lines = readBoundedLines(fpath);

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const type = entry.type;

          if (type === 'user') {
            const rawContent = entry.message?.content || entry.content;
            const text = extractClaudeText(rawContent);
            const cleaned = cleanUserText(text);
            if (cleaned) {
              if (messages.length === 0) {
                title = deriveSessionTitle(cleaned, title);
              }
              messages.push({
                role: 'user',
                content: cleaned,
                timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now()
              });
            }
          } else if (type === 'assistant') {
            const rawContent = entry.message?.content || entry.content;
            const text = extractClaudeText(rawContent);
            const cleaned = cleanAssistantText(text);
            if (cleaned) {
              messages.push({
                role: 'assistant',
                content: cleaned,
                timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now()
              });
            }
          }

          if (!workspace && entry.cwd) {
            workspace = String(entry.cwd);
          }
        } catch {
          // Skip torn line
        }
      }
    } catch {
      return null;
    }

    if (messages.length === 0) return null;

    const stat = fs.statSync(fpath);
    return {
      id: `claude:${rawPath}`,
      sourcePlatform: this.platform,
      sourceLabel: this.label,
      title,
      workspacePath: workspace,
      updatedAt: stat.mtimeMs,
      messageCount: messages.length,
      snippet: messages[0]?.content.slice(0, 100) || '',
      messages
    };
  }
}
