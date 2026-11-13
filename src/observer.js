import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { coldObserver } from './observer/coldObserver.js';
export function extractClaimedLocalUrls(text) {
    if (!text)
        return [];
    const matches = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+(?:\/[^\s)>'"`\]]*)?/gi) || [];
    const unique = new Set();
    for (const raw of matches) {
        let end = raw.length;
        while (end > 0 && '.,;:!?'.includes(raw[end - 1])) {
            end--;
        }
        const cleaned = raw.slice(0, end);
        if (cleaned)
            unique.add(cleaned);
    }
    return [...unique];
}
function isWorkspaceArtifact(workspaceRoot, targetPath) {
    try {
        const root = fs.realpathSync(workspaceRoot);
        const target = fs.realpathSync(targetPath);
        const relative = path.relative(root, target);
        return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    }
    catch {
        return false;
    }
}
export class CausyneObserver {
    /**
     * Evaluates the current state of a task after a tool outcome or at a step boundary.
     */
    evaluate(context) {
        const evidenceRefs = [];
        const outcomes = context.toolHistory || [];
        if (outcomes.length === 0) {
            return {
                status: 'progressing',
                evidenceRefs,
                verified: false,
                confidence: 0.5,
                nextAction: 'Execute the first planned step.'
            };
        }
        const lastOutcome = outcomes[outcomes.length - 1];
        if (!lastOutcome) {
            return {
                status: 'progressing',
                evidenceRefs,
                verified: false,
                confidence: 0.5
            };
        }
        if (lastOutcome.path)
            evidenceRefs.push(lastOutcome.path);
        if (lastOutcome.command)
            evidenceRefs.push(`cmd:${lastOutcome.command.slice(0, 100)}`);
        // Check for explicit failures that need repair or approval
        if (!lastOutcome.success) {
            const err = lastOutcome.error || 'Unknown tool failure';
            const isAuthOrPerm = /permission|denied|unauthorized|approval required|eacces/i.test(err);
            const failureKey = createHash('sha256')
                .update(`${lastOutcome.tool}\0${lastOutcome.command || lastOutcome.path || ''}\0${err}`)
                .digest('hex')
                .slice(0, 16);
            if (isAuthOrPerm) {
                return {
                    status: 'needs-approval',
                    evidenceRefs,
                    failureKey,
                    verified: false,
                    confidence: 0.9,
                    message: `Permission or authentication required: ${err}`,
                    nextAction: 'Request human approval or provide required credentials.'
                };
            }
            return {
                status: 'needs-repair',
                evidenceRefs,
                failureKey,
                verified: false,
                confidence: 0.85,
                message: `Tool ${lastOutcome.tool} failed: ${err}`,
                nextAction: 'Analyze error diagnostic and apply corrective repair.'
            };
        }
        // Check if the agent claims completion
        if (context.agentClaim && context.agentClaim.trim()) {
            // Negative completion statements must not be promoted to verified outcomes.
            const claim = context.agentClaim.toLowerCase().replace(/\b(?:not|never|isn't|wasn't|haven't|hasn't)\s+(?:(?:yet|fully|actually|successfully)\s+)?(?:done|complete|completed|finished|implemented|fixed|verified)\b/gi, '');
            const claimsCompletion = /\b(?:done|complete|completed|finished|implemented|fixed|verified)\b|\b(?:is\s+(?:running|live|available|listening|served)\s+(?:at|on)|application\s+is\s+running)\b/i.test(claim);
            if (claimsCompletion) {
                // Run deterministic verification checks based on domain
                const hasMutations = outcomes.some(o => ['fs_write', 'fs_edit', 'MultiEdit', 'write_file', 'edit_file'].includes(o.tool));
                const hasPassingVerification = outcomes.slice(outcomes.findLastIndex(o => ['fs_write', 'fs_edit', 'MultiEdit', 'write_file', 'edit_file'].includes(o.tool)) + 1).some(o => o.success && (o.exitCode == null || o.exitCode === 0) && (o.rendered === true ||
                    o.tool === 'verify_local_web' ||
                    (o.command && /\b(?:test|build|check|typecheck|vitest|jest|pytest)\b/i.test(o.command))));
                if (!hasPassingVerification) {
                    return {
                        status: 'ready-to-verify',
                        evidenceRefs,
                        verified: false,
                        confidence: 0.6,
                        message: hasMutations ? 'Mutations performed but automated test/build verification has not yet run.' : 'Completion claimed without supporting verification evidence.',
                        nextAction: 'Run targeted verification tests or build checks to confirm completion.'
                    };
                }
                return {
                    status: 'verified',
                    evidenceRefs,
                    verified: true,
                    confidence: 0.95,
                    message: 'Task completed with supporting tool evidence.'
                };
            }
        }
        return {
            status: 'progressing',
            evidenceRefs,
            verified: false,
            confidence: 0.75,
            nextAction: 'Continue with next step in implementation plan.'
        };
    }
    /**
     * Deterministically verifies code deliverables (targeted test, build, syntax).
     */
    verifyCode(req) {
        if (!req.changedFiles?.length)
            return { verified: false, error: 'No code deliverables supplied.', evidence: 'no_files' };
        if (req.changedFiles && req.changedFiles.length > 0) {
            for (const file of req.changedFiles) {
                const fullPath = path.isAbsolute(file) ? file : path.join(req.workspaceRoot, file);
                if (!fs.existsSync(fullPath)) {
                    return {
                        verified: false,
                        error: `Target deliverable ${file} does not exist on disk.`,
                        evidence: 'file_missing'
                    };
                }
                if (!isWorkspaceArtifact(req.workspaceRoot, fullPath)) {
                    return { verified: false, error: `Target deliverable ${file} is outside the workspace.`, evidence: 'outside_workspace' };
                }
                if (!fs.statSync(fullPath).isFile() || fs.statSync(fullPath).size === 0) {
                    return { verified: false, error: `Target deliverable ${file} is not a non-empty file.`, evidence: 'invalid_file' };
                }
            }
        }
        return {
            verified: true,
            evidence: `Verified ${req.changedFiles?.length ?? 0} file(s) present and non-empty.`
        };
    }
    /**
     * Verifies documentation deliverables (headings, required sections).
     */
    verifyDocs(req) {
        const fullPath = path.isAbsolute(req.filePath) ? req.filePath : path.join(req.workspaceRoot, req.filePath);
        if (!fs.existsSync(fullPath)) {
            return { verified: false, missingHeadings: req.requiredHeadings || [] };
        }
        if (!isWorkspaceArtifact(req.workspaceRoot, fullPath))
            return { verified: false, missingHeadings: req.requiredHeadings || [] };
        if (!fs.statSync(fullPath).isFile())
            return { verified: false, missingHeadings: req.requiredHeadings || [] };
        const content = fs.readFileSync(fullPath, 'utf8');
        const missing = [];
        for (const heading of req.requiredHeadings || []) {
            const headingPattern = new RegExp(`^#+\\s+.*${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'im');
            if (!headingPattern.test(content)) {
                missing.push(heading);
            }
        }
        return {
            verified: missing.length === 0,
            missingHeadings: missing
        };
    }
    /**
     * Verifies creative/visual deliverables (asset exists and is not 0 bytes).
     */
    verifyCreative(req) {
        const fullPath = path.isAbsolute(req.artifactPath) ? req.artifactPath : path.join(req.workspaceRoot, req.artifactPath);
        if (!fs.existsSync(fullPath)) {
            return { verified: false, bytes: 0, error: `Media asset not found: ${req.artifactPath}` };
        }
        if (!isWorkspaceArtifact(req.workspaceRoot, fullPath))
            return { verified: false, bytes: 0, error: 'Media artifact is outside the workspace.' };
        const stat = fs.statSync(fullPath);
        if (!stat.isFile())
            return { verified: false, bytes: 0, error: 'Media artifact must be a regular file.' };
        const minBytes = req.minBytes ?? 100;
        if (!Number.isSafeInteger(minBytes) || minBytes < 0)
            return { verified: false, bytes: stat.size, error: 'Invalid minimum artifact size.' };
        if (stat.size < minBytes) {
            return { verified: false, bytes: stat.size, error: `Media asset too small (${stat.size} bytes < ${minBytes} bytes)` };
        }
        return { verified: true, bytes: stat.size };
    }
    /**
     * Verifies local web deliverability via loopback HTTP GET.
     */
    async verifyLocalWeb(req) {
        return new Promise((resolve) => {
            try {
                const url = new URL(req.endpoint);
                // Security gate: only loopback is permitted for local verification
                if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
                    resolve({ verified: false, error: 'Only local loopback endpoints (127.0.0.1, localhost) may be verified.' });
                    return;
                }
                if (url.username || url.password) {
                    resolve({ verified: false, error: 'Local verification URL must not contain credentials.' });
                    return;
                }
                const clientReq = http.get(req.endpoint, { timeout: req.timeoutMs ?? 3000 }, (res) => {
                    res.resume();
                    const expected = req.expectedStatus ?? 200;
                    const ok = req.expectedStatus === undefined
                        ? (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300)
                        : res.statusCode === expected;
                    const result = { verified: Boolean(ok) };
                    if (typeof res.statusCode === 'number')
                        result.statusCode = res.statusCode;
                    if (!ok)
                        result.error = `HTTP ${res.statusCode ?? 'unknown'}`;
                    resolve(result);
                });
                clientReq.on('error', (err) => {
                    resolve({ verified: false, error: err.message });
                });
                clientReq.on('timeout', () => {
                    clientReq.destroy();
                    resolve({ verified: false, error: 'Connection timed out' });
                });
            }
            catch (e) {
                resolve({ verified: false, error: e.message });
            }
        });
    }
    /**
     * Delegate to coldObserver for overconfidence and loop verification checks.
     */
    async auditTurnVerification(turnState) {
        return coldObserver.auditTurnVerification(turnState);
    }
}
export const defaultObserver = new CausyneObserver();
