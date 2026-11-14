import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { coldObserver } from './observer/coldObserver.js';
import { isVerificationCommand, type ToolOutcome } from './observer/evidence.js';

export type ObservationStatus =
  | 'progressing'
  | 'needs-tool'
  | 'needs-approval'
  | 'needs-repair'
  | 'ready-to-verify'
  | 'verified'
  | 'blocked';

export type VerificationDomain = 'code' | 'docs' | 'creative' | 'research' | 'local_web';

export interface Observation {
  status: ObservationStatus;
  evidenceRefs: string[];
  failureKey?: string;
  nextAction?: string;
  confidence?: number;
  domain?: VerificationDomain;
  message?: string;
  verified: boolean;
}

export interface CodeVerificationRequest {
  workspaceRoot: string;
  testCommand?: string;
  buildCommand?: string;
  changedFiles?: string[];
}

export interface DocsVerificationRequest {
  workspaceRoot: string;
  filePath: string;
  requiredHeadings?: string[];
}

export interface CreativeVerificationRequest {
  workspaceRoot: string;
  artifactPath: string;
  minBytes?: number;
}

export interface LocalWebVerificationRequest {
  endpoint: string;
  expectedStatus?: number;
  timeoutMs?: number;
}

export interface TaskObservationContext {
  taskId: string;
  workspaceRoot: string;
  userGoal: string;
  agentClaim?: string;
  currentStep?: string;
  toolHistory: readonly ToolOutcome[];
}

export function extractClaimedLocalUrls(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s)>'"`]+/gi) || [];
  const unique = new Set<string>();
  for (const raw of matches) {
    let end = raw.length;
    while (end > 0) {
      const ch = raw[end - 1]!;
      if ('.,;:!?'.includes(ch)) {
        end--;
        continue;
      }
      if (ch === ']') {
        const prefix = raw.slice(0, end);
        const opens = prefix.split('[').length - 1;
        const closes = prefix.split(']').length - 1;
        if (closes > opens) {
          end--;
          continue;
        }
      }
      break;
    }
    const cleaned = raw.slice(0, end);
    if (!cleaned) continue;
    try {
      const url = new URL(cleaned);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) continue;
      unique.add(cleaned);
    } catch {
      // Ignore malformed and lookalike URLs rather than verifying a false localhost claim.
    }
  }
  return [...unique];
}

const FILE_MUTATION_TOOLS = new Set([
  'fs_write', 'fs_edit', 'MultiEdit', 'fs_delete', 'fs_move',
  'write_file', 'write_to_file', 'edit_file', 'replace_file_content',
  'multi_replace_file_content', 'write', 'edit', 'multiedit'
]);

function isWorkspaceArtifact(workspaceRoot: string, targetPath: string): boolean {
  try {
    const root = fs.realpathSync(workspaceRoot);
    const target = fs.realpathSync(targetPath);
    const relative = path.relative(root, target);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

export class CausyneObserver {
  /**
   * Evaluates the current state of a task after a tool outcome or at a step boundary.
   */
  public evaluate(context: TaskObservationContext): Observation {
    const evidenceRefs: string[] = [];
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

    if (lastOutcome.path) evidenceRefs.push(lastOutcome.path);
    if (lastOutcome.command) evidenceRefs.push(`cmd:${lastOutcome.command.slice(0, 100)}`);

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
        const lastMutationIndex = outcomes.findLastIndex(o => FILE_MUTATION_TOOLS.has(o.tool));
        const hasMutations = lastMutationIndex >= 0;
        const verifications = outcomes.slice(lastMutationIndex + 1).filter(o =>
          o.rendered === true ||
          o.tool === 'verify_local_web' ||
          Boolean(o.command && isVerificationCommand(o.command))
        );
        const lastVerif = verifications[verifications.length - 1];
        const hasPassingVerification = Boolean(
          lastVerif && lastVerif.success && (lastVerif.exitCode == null || lastVerif.exitCode === 0)
        );

        if (!hasPassingVerification) {
          return {
            status: hasMutations ? 'ready-to-verify' : 'progressing',
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
  public verifyCode(req: CodeVerificationRequest): { verified: boolean; error?: string; evidence: string } {
    if (!req.changedFiles?.length) return { verified: false, error: 'No code deliverables supplied.', evidence: 'no_files' };
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
  public verifyDocs(req: DocsDocsVerificationRequest): { verified: boolean; missingHeadings: string[] } {
    const fullPath = path.isAbsolute(req.filePath) ? req.filePath : path.join(req.workspaceRoot, req.filePath);
    if (!fs.existsSync(fullPath)) {
      return { verified: false, missingHeadings: req.requiredHeadings || [] };
    }

    if (!isWorkspaceArtifact(req.workspaceRoot, fullPath)) return { verified: false, missingHeadings: req.requiredHeadings || [] };
    if (!fs.statSync(fullPath).isFile()) return { verified: false, missingHeadings: req.requiredHeadings || [] };
    const content = fs.readFileSync(fullPath, 'utf8');
    const missing: string[] = [];

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
  public verifyCreative(req: CreativeVerificationRequest): { verified: boolean; bytes: number; error?: string } {
    const fullPath = path.isAbsolute(req.artifactPath) ? req.artifactPath : path.join(req.workspaceRoot, req.artifactPath);
    if (!fs.existsSync(fullPath)) {
      return { verified: false, bytes: 0, error: `Media asset not found: ${req.artifactPath}` };
    }

    if (!isWorkspaceArtifact(req.workspaceRoot, fullPath)) return { verified: false, bytes: 0, error: 'Media artifact is outside the workspace.' };
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) return { verified: false, bytes: 0, error: 'Media artifact must be a regular file.' };
    const minBytes = req.minBytes ?? 100;
    if (!Number.isSafeInteger(minBytes) || minBytes < 0) return { verified: false, bytes: stat.size, error: 'Invalid minimum artifact size.' };
    if (stat.size < minBytes) {
      return { verified: false, bytes: stat.size, error: `Media asset too small (${stat.size} bytes < ${minBytes} bytes)` };
    }

    return { verified: true, bytes: stat.size };
  }

  /**
   * Verifies local web deliverability via loopback HTTP GET.
   */
  public async verifyLocalWeb(req: LocalWebVerificationRequest): Promise<{ verified: boolean; statusCode?: number; error?: string }> {
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
          const result: { verified: boolean; statusCode?: number; error?: string } = { verified: Boolean(ok) };
          if (typeof res.statusCode === 'number') result.statusCode = res.statusCode;
          if (!ok) result.error = `HTTP ${res.statusCode ?? 'unknown'}`;
          resolve(result);
        });

        clientReq.on('error', (err) => {
          resolve({ verified: false, error: err.message });
        });

        clientReq.on('timeout', () => {
          clientReq.destroy();
          resolve({ verified: false, error: 'Connection timed out' });
        });
      } catch (e: any) {
        resolve({ verified: false, error: e.message });
      }
    });
  }

  /**
   * Delegate to coldObserver for overconfidence and loop verification checks.
   */
  public async auditTurnVerification(turnState: {
    taskId?: string;
    userPrompt: string;
    agentClaim: string;
    toolHistory: readonly ToolOutcome[];
    stepsCompleted: number;
  }) {
    return coldObserver.auditTurnVerification(turnState);
  }
}

export type DocsDocsVerificationRequest = DocsVerificationRequest;
export const defaultObserver = new CausyneObserver();
