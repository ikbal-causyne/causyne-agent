/**
 * Causyne Agent — GitHub PR & CI Inspection Workflow (Phase B4)
 *
 * Inspects branch status, open Pull Requests, failing CI logs, and drafts
 * truthful, diff-grounded PR summaries using argv-only `git` and `gh` calls
 * (`shell: false`), redacting secrets and terminal escape sequences.
 */
import { execFileSync } from 'node:child_process';
import { redactTextSecrets } from './providers/byokHttp.js';
import { safeDisplay } from './tui/text.js';
import { resolveGitRepoRoot } from './worktreeManager.js';
const SAFE_RUN_ID_RE = /^\d{1,20}$/;
const SAFE_BRANCH_RE = /^[a-zA-Z0-9._/-]{1,128}$/;
const MAX_CI_LOG_CHARS = 24 * 1024;
function execSafeTool(bin, args, cwd, timeoutMs = 20_000) {
    return execFileSync(bin, [...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 8 * 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true
    });
}
export function detectDefaultBranch(repoRoot) {
    try {
        const sym = execSafeTool('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoRoot, 5_000).trim();
        const cleaned = sym.startsWith('origin/') ? sym.slice('origin/'.length) : sym;
        if (cleaned && SAFE_BRANCH_RE.test(cleaned))
            return cleaned;
    }
    catch { /* origin/HEAD not set */ }
    for (const candidate of ['main', 'master']) {
        try {
            execSafeTool('git', ['rev-parse', '--verify', `refs/heads/${candidate}`], repoRoot, 5_000);
            return candidate;
        }
        catch { /* try next */ }
    }
    return 'main';
}
export function inspectPrStatus(workspaceDir) {
    const repoRoot = resolveGitRepoRoot(workspaceDir);
    if (!repoRoot) {
        throw new Error('Current workspace is not inside a Git repository.');
    }
    let branch = 'HEAD';
    try {
        branch = execSafeTool('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot).trim() || 'HEAD';
    }
    catch { /* ignore */ }
    let dirtyCount = 0;
    try {
        const porcelain = execSafeTool('git', ['status', '--porcelain'], repoRoot).trim();
        dirtyCount = porcelain ? porcelain.split(/\r?\n/).length : 0;
    }
    catch { /* ignore */ }
    let ahead = 0;
    let behind = 0;
    try {
        const counts = execSafeTool('git', ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], repoRoot).trim();
        const parts = counts.split(/\s+/);
        behind = Number.parseInt(parts[0] || '0', 10) || 0;
        ahead = Number.parseInt(parts[1] || '0', 10) || 0;
    }
    catch { /* no upstream tracking branch */ }
    let ghAvailable = false;
    try {
        execSafeTool('gh', ['--version'], repoRoot, 5_000);
        ghAvailable = true;
    }
    catch {
        ghAvailable = false;
    }
    let glabAvailable = false;
    try {
        execSafeTool('glab', ['--version'], repoRoot, 5_000);
        glabAvailable = true;
    }
    catch {
        glabAvailable = false;
    }
    if (!ghAvailable && !glabAvailable) {
        return {
            repoRoot,
            branch,
            dirtyCount,
            ahead,
            behind,
            ghAvailable: false,
            glabAvailable: false,
            forge: 'none',
            pr: null,
            note: 'Neither GitHub CLI (`gh`) nor GitLab CLI (`glab`) is installed on PATH.'
        };
    }
    if (!ghAvailable && glabAvailable) {
        try {
            const raw = execSafeTool('glab', ['mr', 'view', '--output', 'json'], repoRoot, 15_000);
            const parsed = JSON.parse(raw);
            return {
                repoRoot,
                branch,
                dirtyCount,
                ahead,
                behind,
                ghAvailable: false,
                glabAvailable: true,
                forge: 'gitlab',
                pr: {
                    number: Number(parsed.iid ?? parsed.id) || 0,
                    title: safeDisplay(String(parsed.title || '')),
                    state: safeDisplay(String(parsed.state || 'OPEN').toUpperCase()),
                    url: safeDisplay(String(parsed.web_url || '')),
                    baseRefName: safeDisplay(String(parsed.target_branch || '')),
                    headRefName: safeDisplay(String(parsed.source_branch || branch)),
                    checksPassed: 0,
                    checksFailed: 0,
                    checksPending: 0
                }
            };
        }
        catch {
            return {
                repoRoot,
                branch,
                dirtyCount,
                ahead,
                behind,
                ghAvailable: false,
                glabAvailable: true,
                forge: 'gitlab',
                pr: null,
                note: `No open GitLab merge request found for branch "${safeDisplay(branch)}".`
            };
        }
    }
    try {
        const raw = execSafeTool('gh', [
            'pr', 'view', '--json', 'number,title,state,url,baseRefName,headRefName,statusCheckRollup'
        ], repoRoot, 15_000);
        const parsed = JSON.parse(raw);
        const checks = Array.isArray(parsed.statusCheckRollup) ? parsed.statusCheckRollup : [];
        let checksPassed = 0;
        let checksFailed = 0;
        let checksPending = 0;
        for (const c of checks) {
            if (!c || typeof c !== 'object')
                continue;
            const rec = c;
            const conclusion = String(rec.conclusion || rec.state || '').toUpperCase();
            if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED') {
                checksPassed++;
            }
            else if (conclusion === 'FAILURE' || conclusion === 'ERROR' || conclusion === 'TIMED_OUT' || conclusion === 'CANCELLED') {
                checksFailed++;
            }
            else {
                checksPending++;
            }
        }
        return {
            repoRoot,
            branch,
            dirtyCount,
            ahead,
            behind,
            ghAvailable: true,
            pr: {
                number: Number(parsed.number) || 0,
                title: safeDisplay(String(parsed.title || '')),
                state: safeDisplay(String(parsed.state || 'UNKNOWN')),
                url: safeDisplay(String(parsed.url || '')),
                baseRefName: safeDisplay(String(parsed.baseRefName || '')),
                headRefName: safeDisplay(String(parsed.headRefName || branch)),
                checksPassed,
                checksFailed,
                checksPending
            }
        };
    }
    catch {
        return {
            repoRoot,
            branch,
            dirtyCount,
            ahead,
            behind,
            ghAvailable: true,
            pr: null,
            note: `No open pull request found for branch "${safeDisplay(branch)}".`
        };
    }
}
export function fetchFailedCiLogs(workspaceDir, runId) {
    const repoRoot = resolveGitRepoRoot(workspaceDir);
    if (!repoRoot) {
        return { ok: false, runId: null, output: 'Current workspace is not inside a Git repository.' };
    }
    let targetRunId = typeof runId === 'string' ? runId.trim() : '';
    if (targetRunId && !SAFE_RUN_ID_RE.test(targetRunId)) {
        return { ok: false, runId: null, output: `Invalid workflow run ID "${safeDisplay(targetRunId)}". Expected digits only.` };
    }
    if (!targetRunId) {
        try {
            const listJson = execSafeTool('gh', [
                'run', 'list', '--status', 'failure', '--limit', '1', '--json', 'databaseId'
            ], repoRoot, 15_000);
            const runs = JSON.parse(listJson);
            const firstId = runs[0]?.databaseId;
            if (firstId !== undefined && SAFE_RUN_ID_RE.test(String(firstId))) {
                targetRunId = String(firstId);
            }
        }
        catch (err) {
            return {
                ok: false,
                runId: null,
                output: `Could not query GitHub Actions runs via \`gh\`: ${safeDisplay(err instanceof Error ? err.message : String(err))}`
            };
        }
    }
    if (!targetRunId) {
        return { ok: true, runId: null, output: 'No recent failed GitHub Actions workflow runs found.' };
    }
    try {
        const rawLogs = execSafeTool('gh', ['run', 'view', targetRunId, '--log-failed'], repoRoot, 25_000);
        const cleaned = safeDisplay(redactTextSecrets(rawLogs));
        const bounded = cleaned.length > MAX_CI_LOG_CHARS
            ? cleaned.slice(-MAX_CI_LOG_CHARS)
            : cleaned;
        return {
            ok: true,
            runId: targetRunId,
            output: bounded || `Workflow run ${targetRunId} returned empty failure logs.`
        };
    }
    catch (err) {
        return {
            ok: false,
            runId: targetRunId,
            output: `Failed to fetch failure logs for run ${targetRunId}: ${safeDisplay(err instanceof Error ? err.message : String(err))}`
        };
    }
}
export function preparePrDraft(workspaceDir, baseBranch) {
    const repoRoot = resolveGitRepoRoot(workspaceDir);
    if (!repoRoot) {
        throw new Error('Current workspace is not inside a Git repository.');
    }
    const safeBase = typeof baseBranch === 'string' && baseBranch.trim()
        ? baseBranch.trim()
        : detectDefaultBranch(repoRoot);
    if (safeBase.startsWith('-') || !SAFE_BRANCH_RE.test(safeBase)) {
        throw new Error(`Invalid base branch "${safeDisplay(safeBase)}".`);
    }
    const headBranch = execSafeTool('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot).trim() || 'HEAD';
    let commitSubjects = [];
    let changedFiles = [];
    let diffStat = '';
    try {
        const logOut = execSafeTool('git', ['log', `${safeBase}..HEAD`, '--pretty=format:%s', '-n', '50'], repoRoot).trim();
        commitSubjects = logOut ? logOut.split(/\r?\n/).filter(Boolean) : [];
        const filesOut = execSafeTool('git', ['diff', '--name-only', `${safeBase}...HEAD`], repoRoot).trim();
        changedFiles = filesOut ? filesOut.split(/\r?\n/).filter(Boolean) : [];
        diffStat = execSafeTool('git', ['diff', '--stat', `${safeBase}...HEAD`], repoRoot).trim();
    }
    catch {
        // Fallback to working tree changes when base branch does not exist locally
        const filesOut = execSafeTool('git', ['diff', '--name-only'], repoRoot).trim();
        changedFiles = filesOut ? filesOut.split(/\r?\n/).filter(Boolean) : [];
        diffStat = execSafeTool('git', ['diff', '--stat'], repoRoot).trim();
    }
    const title = commitSubjects.length === 1
        ? safeDisplay(commitSubjects[0]).slice(0, 72)
        : safeDisplay(`${headBranch} (${changedFiles.length} file(s) changed)`).slice(0, 72);
    const bodyLines = [
        '## Summary',
        '',
        `- Branch: \`${safeDisplay(headBranch)}\` -> \`${safeDisplay(safeBase)}\``,
        `- Commits: ${commitSubjects.length}`,
        `- Changed files: ${changedFiles.length}`,
        ''
    ];
    if (commitSubjects.length > 0) {
        bodyLines.push('## Commits', '');
        for (const subject of commitSubjects.slice(0, 20)) {
            bodyLines.push(`- ${safeDisplay(subject)}`);
        }
        bodyLines.push('');
    }
    if (diffStat) {
        bodyLines.push('## Diff Summary', '', '```text', safeDisplay(diffStat).slice(0, 4000), '```');
    }
    return {
        title,
        body: bodyLines.join('\n'),
        baseBranch: safeBase,
        headBranch,
        commitCount: commitSubjects.length,
        changedFiles
    };
}
export function postPrComment(workspaceDir, body) {
    const repoRoot = resolveGitRepoRoot(workspaceDir);
    if (!repoRoot) {
        return { ok: false, output: 'Current workspace is not inside a Git repository.' };
    }
    const cleaned = redactTextSecrets(String(body ?? '')).trim();
    if (!cleaned) {
        return { ok: false, output: 'PR comment body cannot be empty.' };
    }
    try {
        const out = execSafeTool('gh', ['pr', 'comment', '--body', cleaned], repoRoot, 20_000);
        return { ok: true, output: safeDisplay(out.trim() || 'Posted PR comment.') };
    }
    catch (err) {
        return { ok: false, output: `Failed to post PR comment: ${safeDisplay(err instanceof Error ? err.message : String(err))}` };
    }
}
export function formatPrStatusReport(status) {
    const lines = [
        'Pull Request & Branch Status',
        `  Branch     : ${safeDisplay(status.branch)} (ahead ${status.ahead}, behind ${status.behind}, uncommitted ${status.dirtyCount})`,
        `  GitHub CLI : ${status.ghAvailable ? 'available' : 'not installed'}`
    ];
    if (status.pr) {
        lines.push(`  PR         : #${status.pr.number} [${status.pr.state}] ${status.pr.title}`);
        lines.push(`  Flow       : ${status.pr.headRefName} -> ${status.pr.baseRefName}`);
        lines.push(`  Checks     : ${status.pr.checksPassed} passed, ${status.pr.checksFailed} failed, ${status.pr.checksPending} pending`);
        lines.push(`  URL        : ${status.pr.url}`);
    }
    else if (status.note) {
        lines.push(`  Note       : ${status.note}`);
    }
    return lines.join('\n');
}
