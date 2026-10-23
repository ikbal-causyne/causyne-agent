// Continuum Scanner: orchestrates dynamic discovery across all peer agent adapters.
// Authorship: Strict TypeScript (Causyne Agent).

import type { ContinuumAdapter, ContinuumSessionSummary, ContinuumSessionDetail, ContinuumFilterOptions } from './types.js';
import { AntigravityAdapter } from './adapters/antigravity.js';
import { OpenCodeAdapter } from './adapters/opencode.js';
import { CodexAdapter } from './adapters/codex.js';
import { ClaudeCodeAdapter } from './adapters/claudeCode.js';
import { CausyneAdapter } from './adapters/causyne.js';

export class ContinuumScanner {
  private readonly adapters: ContinuumAdapter[];

  constructor(customAdapters?: ContinuumAdapter[]) {
    this.adapters = customAdapters || [
      new AntigravityAdapter(),
      new OpenCodeAdapter(),
      new CodexAdapter(),
      new ClaudeCodeAdapter(),
      new CausyneAdapter()
    ];
  }

  getAllAdapters(): readonly ContinuumAdapter[] {
    return this.adapters;
  }

  getAvailableAdapters(): ContinuumAdapter[] {
    return this.adapters.filter(a => a.isAvailable());
  }

  async scanAll(options: ContinuumFilterOptions = {}): Promise<ContinuumSessionSummary[]> {
    return this.scanAllSessions(options);
  }

  async scanAllSessions(options: ContinuumFilterOptions = {}): Promise<ContinuumSessionSummary[]> {
    const activeAdapters = this.getAvailableAdapters().filter(a => {
      if (!options.platform || options.platform === 'all') return true;
      return a.platform === options.platform;
    });

    const results = await Promise.allSettled(
      activeAdapters.map(adapter => adapter.listSessions(options.limit ?? 50))
    );

    let all: ContinuumSessionSummary[] = [];
    for (const res of results) {
      if (res.status === 'fulfilled' && Array.isArray(res.value)) {
        all.push(...res.value);
      }
    }

    // Filter by text query if provided
    if (options.query && options.query.trim()) {
      const q = options.query.toLowerCase().trim();
      all = all.filter(s =>
        s.title.toLowerCase().includes(q) ||
        s.snippet.toLowerCase().includes(q) ||
        s.workspacePath.toLowerCase().includes(q) ||
        s.sourceLabel.toLowerCase().includes(q)
      );
    }

    // Filter by workspace if specified
    if (options.workspaceFilter && options.workspaceFilter.trim()) {
      const wf = options.workspaceFilter.toLowerCase().trim();
      all = all.filter(s => s.workspacePath.toLowerCase().includes(wf));
    }

    // Sort by most recently updated
    all.sort((a, b) => b.updatedAt - a.updatedAt);

    if (options.limit && options.limit > 0) {
      return all.slice(0, options.limit);
    }
    return all;
  }

  async fetchSession(id: string): Promise<ContinuumSessionDetail | null> {
    const colonIndex = id.indexOf(':');
    if (colonIndex === -1) {
      // Try all adapters sequentially
      for (const adapter of this.getAvailableAdapters()) {
        const detail = await adapter.getSession(id);
        if (detail) return detail;
      }
      return null;
    }

    const platformPrefix = id.slice(0, colonIndex).toLowerCase();
    const adapter = this.adapters.find(a =>
      a.platform === platformPrefix ||
      (platformPrefix === 'claude' && a.platform === 'claude_code') ||
      (platformPrefix === 'agy' && a.platform === 'antigravity')
    );
    if (adapter) {
      return adapter.getSession(id);
    }

    for (const a of this.getAvailableAdapters()) {
      const detail = await a.getSession(id);
      if (detail) return detail;
    }
    return null;
  }
}
