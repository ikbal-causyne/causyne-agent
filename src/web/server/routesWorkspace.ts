import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { atomicWriteFileSync } from '../../infra/atomicWriter.js';
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  renameSession
} from '../../sessionJournal.js';
import { collectWorkingTreeDiff } from '../../diffReview.js';
import { auditLog } from '../../auditLog.js';
import { redactProviderSecrets } from '../../providers/byokHttp.js';
import { isIgnoredByCausyneIgnore } from '../../ignoreRules.js';
import { listCommands, parseCommand, runCommand } from '../../commands.js';
import { listGroups } from '../../checkpoints.js';
import { listCompiledSkills } from '../../skillsManager.js';
import { serverStatus } from '../../mcp/mcpRegistry.js';
import { listAllPeers } from '../../acp/peerProfiles.js';
import { listWorktrees } from '../../worktreeManager.js';
import { backgroundTaskManager } from '../../backgroundTasks.js';
import { causyneBrowser } from '../../browser/causyneBrowser.js';
import { SAFE_SESSION_ID_RE, readJsonBody, sendJson } from './security.js';
import {
  MAX_FILE_READ_BYTES,
  MAX_FILE_WRITE_BYTES,
  buildSynthesizedWriteHunk,
  formatByteSize,
  listWorkspaceEntries,
  packLocalHtmlPreview,
  readLastGitCommitDiffForFile,
  resolveWorkspaceRelativePath,
  workspaceMatchesSession
} from './workspaceFiles.js';
import {
  extractSessionDisplayMessages,
  extractSessionFileEvidence,
  extractSessionTouchedFiles,
  parseSessionIdRoute,
  parseSessionStreamRoute
} from './sessionTranscript.js';
import type { SessionFileEvidence, SkybridgeContext } from './types.js';

export async function handleWorkspaceRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsedUrl: URL,
  ctx: SkybridgeContext
): Promise<boolean> {
  const pathname = parsedUrl.pathname;
  const { workspaceRoot } = ctx;

  if (req.method === 'GET' && pathname === '/api/sessions') {
    const all = listSessions();
    const scoped = all.filter((row) => workspaceMatchesSession(row.workspace, workspaceRoot));
    sendJson(res, 200, {
      ok: true,
      sessions: scoped.slice(0, 50).map((row) => {
        const run = ctx.activeRuns.get(row.id);
        const isRunning = Boolean(run && (run.status === 'running' || run.status === 'awaiting_client'));
        return {
          id: row.id,
          title: row.title,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          messageCount: row.messageCount,
          running: isRunning,
          awaitingClient: Boolean(run && run.status === 'awaiting_client')
        };
      })
    });
    return true;
  }

  const sessionStreamId = parseSessionStreamRoute(pathname);
  if (req.method === 'GET' && sessionStreamId) {
    const run = ctx.activeRuns.get(sessionStreamId);
    if (!run || (run.status !== 'running' && run.status !== 'awaiting_client')) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(`${JSON.stringify({ type: 'idle', sessionId: sessionStreamId })}\n`);
      return true;
    }
    ctx.attachRunStream(req, res, run, true);
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/sessions') {
    const body = await readJsonBody(req);
    const rawTitle = typeof body.title === 'string' ? body.title.trim().slice(0, 80) : '';
    const created = createSession(workspaceRoot, rawTitle || 'Untitled', false);
    sendJson(res, 201, {
      ok: true,
      session: {
        id: created.id,
        title: created.title,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        messageCount: 0,
        messages: []
      }
    });
    return true;
  }

  const sessionIdParam = parseSessionIdRoute(pathname);
  if (sessionIdParam) {
    const existing = getSession(sessionIdParam);
    if (!existing || !workspaceMatchesSession(existing.workspace, workspaceRoot)) {
      sendJson(res, 404, { error: 'Session not found in this workspace.' });
      return true;
    }
    if (req.method === 'GET') {
      const persistedTouched = extractSessionTouchedFiles(existing.messages, workspaceRoot);
      const liveTouched = [...(ctx.sessionTouchedFilesMap.get(existing.id) ?? [])];
      const touchedFiles = [...new Set([...persistedTouched, ...liveTouched])].sort();
      const activeRun = ctx.activeRuns.get(existing.id);
      const isRunning = Boolean(activeRun && (activeRun.status === 'running' || activeRun.status === 'awaiting_client'));
      sendJson(res, 200, {
        ok: true,
        session: {
          id: existing.id,
          title: existing.title,
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
          messageCount: existing.messages.length,
          messages: extractSessionDisplayMessages(existing.messages),
          touchedFiles,
          running: isRunning,
          awaitingClient: Boolean(activeRun && activeRun.status === 'awaiting_client'),
          activeRun: isRunning && activeRun ? {
            taskId: activeRun.taskId,
            status: activeRun.status,
            prompt: activeRun.prompt,
            startedAt: activeRun.startedAt
          } : null
        }
      });
      return true;
    }
    if (req.method === 'PATCH') {
      const body = await readJsonBody(req);
      const nextTitle = typeof body.title === 'string' ? body.title.trim().slice(0, 80) : '';
      if (!nextTitle) {
        sendJson(res, 400, { error: 'A non-empty session title is required.' });
        return true;
      }
      const updated = renameSession(existing.id, nextTitle);
      if (!updated) {
        sendJson(res, 400, { error: 'Could not rename session.' });
        return true;
      }
      sendJson(res, 200, { ok: true, id: existing.id, title: nextTitle });
      return true;
    }
    if (req.method === 'DELETE') {
      const removed = deleteSession(existing.id);
      sendJson(res, removed ? 200 : 404, { ok: removed, id: existing.id });
      return true;
    }
  }

  if (req.method === 'GET' && pathname === '/api/files') {
    const dir = parsedUrl.searchParams.get('dir') || '';
    const q = parsedUrl.searchParams.get('q') || '';
    const entries = listWorkspaceEntries(workspaceRoot, dir, q);
    const parentDir = dir ? path.posix.dirname(dir.replace(/\\/g, '/')) : '';
    sendJson(res, 200, {
      ok: true,
      dir,
      parentDir: parentDir === '.' ? '' : parentDir,
      entries
    });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/file') {
    const rel = parsedUrl.searchParams.get('path') || '';
    const abs = resolveWorkspaceRelativePath(workspaceRoot, rel);
    if (!abs) {
      sendJson(res, 403, { error: 'Path is outside the locked workspace boundary.' });
      return true;
    }
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      sendJson(res, 403, { error: 'Only regular workspace files can be read.' });
      return true;
    }
    if (stat.size > MAX_FILE_READ_BYTES) {
      sendJson(res, 413, { error: `File exceeds ${MAX_FILE_READ_BYTES} byte preview limit.` });
      return true;
    }
    const content = fs.readFileSync(abs, 'utf8');
    sendJson(res, 200, {
      ok: true,
      path: path.relative(workspaceRoot, abs).split(path.sep).join('/'),
      size: stat.size,
      content
    });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/file/pack-html') {
    const rel = parsedUrl.searchParams.get('path') || '';
    const packed = packLocalHtmlPreview(workspaceRoot, rel);
    sendJson(res, 200, {
      ok: true,
      path: rel,
      packedAssets: packed.packedAssets,
      totalBytes: packed.totalBytes,
      html: packed.html
    });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/file') {
    const body = await readJsonBody(req, MAX_FILE_WRITE_BYTES);
    const rel = typeof body.path === 'string' ? body.path : '';
    const content = typeof body.content === 'string' ? body.content : null;
    if (!rel || content === null) {
      sendJson(res, 400, { error: 'Both `path` and string `content` are required.' });
      return true;
    }
    const abs = resolveWorkspaceRelativePath(workspaceRoot, rel);
    if (!abs) {
      sendJson(res, 403, { error: 'Refusing write outside locked workspace boundary.' });
      return true;
    }
    const relNormalized = path.relative(workspaceRoot, abs).split(path.sep).join('/');
    if (isIgnoredByCausyneIgnore(abs, workspaceRoot, false)) {
      sendJson(res, 403, { error: 'File path is blocked by .causyneignore.' });
      return true;
    }
    const byteCount = Buffer.byteLength(content, 'utf8');
    if (byteCount > MAX_FILE_WRITE_BYTES) {
      sendJson(res, 413, { error: 'File content exceeds maximum write limit.' });
      return true;
    }
    atomicWriteFileSync(abs, content);
    if (typeof body.sessionId === 'string') {
      ctx.recordSessionTouchedFile(body.sessionId.trim(), relNormalized);
    }
    auditLog.log({ event: 'skybridge_file_write', path: relNormalized, bytes: byteCount });
    sendJson(res, 200, { ok: true, path: relNormalized, bytes: byteCount });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/diff') {
    handleDiffRequest(res, parsedUrl, ctx);
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/commands') {
    const commands = listCommands('terminal').map((cmd) => ({
      name: cmd.name,
      aliases: cmd.aliases ?? [],
      usage: cmd.usage,
      description: cmd.description
    }));
    sendJson(res, 200, { ok: true, commands });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/command') {
    const body = await readJsonBody(req);
    let cmdName = '';
    let cmdArgv: string[] = [];
    if (typeof body.input === 'string' && body.input.trim()) {
      const rawLine = body.input.trim().startsWith('/') ? body.input.trim() : `/${body.input.trim()}`;
      const parsed = parseCommand(rawLine);
      if (!parsed) {
        sendJson(res, 400, { error: 'Invalid CLI slash command syntax.' });
        return true;
      }
      cmdName = parsed.name;
      cmdArgv = parsed.argv;
    } else if (typeof body.name === 'string' && body.name.trim()) {
      cmdName = body.name.trim().toLowerCase();
      cmdArgv = Array.isArray(body.argv) ? body.argv.map((x: unknown) => String(x ?? '')) : [];
    } else {
      sendJson(res, 400, { error: 'Command input or name is required.' });
      return true;
    }
    if (cmdName === 'exit' || cmdName === 'quit') {
      sendJson(res, 200, {
        ok: true,
        command: cmdName,
        title: 'Exit',
        output: 'Press Ctrl+C in the terminal running `causyne web` to stop the local Skybridge server cleanly.'
      });
      return true;
    }
    const prevCwd = process.cwd();
    let result: Awaited<ReturnType<typeof runCommand>>;
    try {
      if (prevCwd !== workspaceRoot) process.chdir(workspaceRoot);
      result = await runCommand(cmdName, cmdArgv, {
        surface: 'terminal',
        workspaceRoot,
        cwd: workspaceRoot
      });
    } finally {
      try { if (process.cwd() !== prevCwd) process.chdir(prevCwd); } catch { /* ignore */ }
    }
    auditLog.log({ event: 'skybridge_cli_command', command: cmdName, ok: Boolean(result.ok) });
    sendJson(res, 200, {
      ok: Boolean(result.ok),
      command: cmdName,
      title: typeof result.title === 'string' ? result.title : `/${cmdName}`,
      effect: typeof result.effect === 'string' ? result.effect : null,
      output: redactProviderSecrets(String(result.output || ''))
    });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/cli/overview') {
    const checkpoints = listGroups(12).map((g) => ({
      id: g.taskId,
      createdAt: g.ts,
      label: g.prompt || g.taskId,
      fileCount: Array.isArray(g.fileEntries) ? g.fileEntries.length : 0
    }));
    const skills = listCompiledSkills();
    const mcpServers = serverStatus().map((s) => ({
      name: s.name,
      connected: Boolean((s as any).connected),
      granted: Boolean((s as any).granted),
      toolsCount: typeof (s as any).toolsCount === 'number' ? (s as any).toolsCount : 0
    }));
    const peers = listAllPeers().map((p) => ({
      name: p.id,
      label: p.label,
      command: p.command
    }));
    const tasks = backgroundTaskManager.list().slice(0, 20).map((t) => ({
      id: t.taskId,
      label: t.label,
      command: t.command,
      status: t.status,
      startedAt: t.startedAt
    }));
    let worktrees: Array<{ path: string; branch: string; managed: boolean }> = [];
    try {
      worktrees = listWorktrees(workspaceRoot).map((w) => ({
        path: w.path,
        branch: w.branch || 'detached',
        managed: Boolean(w.managed)
      }));
    } catch {
      worktrees = [];
    }
    sendJson(res, 200, {
      ok: true,
      commandsCount: listCommands('terminal').length,
      skillsCount: skills.length,
      checkpoints,
      mcpServers,
      peers,
      tasks,
      worktrees,
      browserActive: causyneBrowser({ workspace: workspaceRoot }).isActive(),
      browserControlOwner: ctx.getBrowserControlOwner()
    });
    return true;
  }

  return false;
}

function handleDiffRequest(
  res: http.ServerResponse,
  parsedUrl: URL,
  ctx: SkybridgeContext
): void {
  const { workspaceRoot } = ctx;
  const staged = parsedUrl.searchParams.get('staged') === '1';
  const rawSessionId = (parsedUrl.searchParams.get('sessionId') || '').trim();
  const sessionId = SAFE_SESSION_ID_RE.test(rawSessionId) ? rawSessionId : '';
  const rawScope = (parsedUrl.searchParams.get('scope') || '').trim().toLowerCase();
  const scope: 'session' | 'workspace' = rawScope === 'session' && sessionId ? 'session' : 'workspace';

  const sessionEvidenceMap = new Map<string, SessionFileEvidence>();
  if (sessionId) {
    const sess = getSession(sessionId);
    if (sess && workspaceMatchesSession(sess.workspace, workspaceRoot)) {
      for (const [p, ev] of extractSessionFileEvidence(sess.messages, workspaceRoot)) {
        sessionEvidenceMap.set(p, ev);
      }
    }
    for (const p of ctx.sessionTouchedFilesMap.get(sessionId) ?? []) {
      if (!sessionEvidenceMap.has(p)) {
        sessionEvidenceMap.set(p, {
          path: p,
          status: 'modified',
          additions: 0,
          deletions: 0,
          hunks: []
        });
      }
    }
  }

  const buildNonGitSessionEntry = (rel: string, ev: SessionFileEvidence | undefined, isGit: boolean) => {
    const abs = resolveWorkspaceRelativePath(workspaceRoot, rel);
    let existsOnDisk = false;
    let diskSize = 0;
    let diskHunks: Array<{ header: string; lines: string[] }> = [];
    let diskAdditions = 0;
    let diskDeletions = 0;
    let fromLastCommit = false;
    if (abs) {
      try {
        const st = fs.lstatSync(abs);
        if (!st.isSymbolicLink() && st.isFile()) {
          existsOnDisk = true;
          diskSize = st.size;
          if (isGit && (!ev || ev.hunks.length === 0)) {
            const commitDiff = readLastGitCommitDiffForFile(workspaceRoot, rel);
            if (commitDiff) {
              diskHunks = commitDiff.hunks;
              diskAdditions = commitDiff.additions;
              diskDeletions = commitDiff.deletions;
              fromLastCommit = true;
            }
          }
          if (diskHunks.length === 0 && st.size > 0 && st.size <= 48 * 1024 && (!ev || ev.hunks.length === 0)) {
            const buf = fs.readFileSync(abs);
            if (!buf.includes(0)) {
              const synth = buildSynthesizedWriteHunk(buf.toString('utf8'));
              diskHunks = synth.hunks;
              diskAdditions = synth.additions;
            }
          }
        }
      } catch {
        existsOnDisk = false;
      }
    }
    const hunks = ev && ev.hunks.length > 0 ? ev.hunks : diskHunks;
    const additions = ev && ev.additions > 0 ? ev.additions : diskAdditions;
    const deletions = ev && ev.deletions > 0 ? ev.deletions : diskDeletions;
    const status = fromLastCommit && diskDeletions > 0
      ? 'modified'
      : (ev?.status ?? (existsOnDisk ? 'modified' : 'added'));
    let note: string | undefined;
    if (existsOnDisk) {
      if (fromLastCommit) {
        note = 'Latest committed diff on disk';
      } else if (hunks.length === 0) {
        note = diskSize > 0
          ? `On disk (${formatByteSize(diskSize)}) · ${isGit ? 'committed or binary asset' : 'workspace file'}`
          : (isGit ? 'Clean on disk' : 'Touched in this conversation');
      }
    } else {
      const sizeLabel = ev?.bytesWritten ? ` (${formatByteSize(ev.bytesWritten)})` : '';
      note = `Written in this chat${sizeLabel} · no longer on disk`;
    }
    return {
      path: rel,
      status,
      additions,
      deletions,
      inGitDiff: false,
      existsOnDisk,
      note,
      hunks
    };
  };

  try {
    const report = collectWorkingTreeDiff(workspaceRoot, { staged });
    const mappedWorkspaceFiles = report.files.slice(0, 60).map((f) => {
      const abs = resolveWorkspaceRelativePath(workspaceRoot, f.displayPath);
      let existsOnDisk = f.status !== 'deleted';
      let note: string | undefined;
      if (abs && f.hunks.length === 0 && f.status !== 'deleted') {
        try {
          const st = fs.lstatSync(abs);
          existsOnDisk = st.isFile();
          if (existsOnDisk) note = `Binary or large asset (${formatByteSize(st.size)})`;
        } catch {
          existsOnDisk = false;
        }
      }
      return {
        path: f.displayPath,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        inGitDiff: true,
        existsOnDisk,
        note,
        hunks: f.hunks.slice(0, 20).map((h) => ({
          header: h.header,
          lines: h.lines.slice(0, 200)
        }))
      };
    });
    const matchedSessionGitFiles = mappedWorkspaceFiles.filter((f) => sessionEvidenceMap.has(f.path));
    const matchedPaths = new Set(matchedSessionGitFiles.map((f) => f.path));
    const extraSessionFiles = [...sessionEvidenceMap.keys()]
      .sort()
      .filter((rel) => !matchedPaths.has(rel))
      .map((rel) => buildNonGitSessionEntry(rel, sessionEvidenceMap.get(rel), true));
    const sessionFiles = [...matchedSessionGitFiles, ...extraSessionFiles];
    const returnedFiles = scope === 'session' ? sessionFiles : mappedWorkspaceFiles;
    const totalAdditions = scope === 'session'
      ? returnedFiles.reduce((sum, f) => sum + f.additions, 0)
      : report.totalAdditions;
    const totalDeletions = scope === 'session'
      ? returnedFiles.reduce((sum, f) => sum + f.deletions, 0)
      : report.totalDeletions;
    sendJson(res, 200, {
      ok: true,
      isGitRepo: true,
      scope,
      sessionId: sessionId || null,
      staged: report.staged,
      workspaceFileCount: mappedWorkspaceFiles.length,
      sessionFileCount: sessionFiles.length,
      totalAdditions,
      totalDeletions,
      truncated: report.truncated,
      files: returnedFiles
    });
  } catch {
    const fallbackSessionFiles = [...sessionEvidenceMap.keys()]
      .sort()
      .map((rel) => buildNonGitSessionEntry(rel, sessionEvidenceMap.get(rel), false));
    sendJson(res, 200, {
      ok: true,
      isGitRepo: false,
      scope,
      sessionId: sessionId || null,
      staged,
      workspaceFileCount: 0,
      sessionFileCount: fallbackSessionFiles.length,
      totalAdditions: fallbackSessionFiles.reduce((sum, f) => sum + f.additions, 0),
      totalDeletions: fallbackSessionFiles.reduce((sum, f) => sum + f.deletions, 0),
      truncated: false,
      files: scope === 'session' ? fallbackSessionFiles : []
    });
  }
}
