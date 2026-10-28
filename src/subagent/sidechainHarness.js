import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from '../utils/paths.js';
function sanitizeSubagentId(id) {
    const cleaned = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    return cleaned.length > 0 ? cleaned.slice(0, 120) : 'subagent';
}
export class SidechainSubagentHarness {
    spec;
    sidechainLogPath;
    constructor(spec, customStorageDir) {
        this.spec = {
            ...spec,
            maxSteps: spec.maxSteps ?? 15,
            tokenBudget: spec.tokenBudget ?? 60_000
        };
        const baseDir = customStorageDir ?? path.join(causyneHome(), 'sidechains');
        fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
        const safeName = sanitizeSubagentId(spec.subagentId);
        this.sidechainLogPath = path.join(baseDir, `${safeName}.jsonl`);
    }
    recordStep(stepData) {
        const serialized = JSON.stringify({
            timestamp: Date.now(),
            subagentId: this.spec.subagentId,
            ...stepData
        }) + '\n';
        fs.appendFileSync(this.sidechainLogPath, serialized, 'utf8');
    }
    readTranscript() {
        if (!fs.existsSync(this.sidechainLogPath))
            return [];
        const lines = fs.readFileSync(this.sidechainLogPath, 'utf8').split('\n').filter(Boolean);
        const parsed = [];
        for (const line of lines) {
            try {
                parsed.push(JSON.parse(line));
            }
            catch {
                // Skip corrupted line
            }
        }
        return parsed;
    }
    formatSummaryForParent(summary) {
        const files = summary.modifiedFiles.length > 0
            ? summary.modifiedFiles.map(f => `  - \`${f}\``).join('\n')
            : '  - None';
        const observations = summary.verifiedObservations.length > 0
            ? summary.verifiedObservations.map(o => `  - ${o}`).join('\n')
            : '  - None';
        const artifacts = summary.outputArtifacts.length > 0
            ? summary.outputArtifacts.map(a => `  - \`${a}\``).join('\n')
            : '  - None';
        return [
            `### Subagent [${this.spec.subagentId}] Execution Report`,
            `- **Status:** ${summary.status}`,
            `- **Total Steps:** ${summary.totalSteps} (Sidechain log: ${this.sidechainLogPath})`,
            `- **Tokens Consumed:** ${summary.tokensConsumed.toLocaleString()}`,
            `- **Modified Files:**\n${files}`,
            `- **Key Verified Facts:**\n${observations}`,
            `- **Output Artifacts:**\n${artifacts}`,
            summary.error ? `- **Error Details:** ${summary.error}` : ''
        ].filter(Boolean).join('\n');
    }
}
