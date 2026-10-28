import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { causyneHome } from '../utils/paths.js';

export interface ToolOutputStoreConfig {
  maxChars: number;
  maxLines: number;
  maxBytes: number;
  headLines: number;
  tailLines: number;
  storageDir: string;
}

export interface StoredOutputResult {
  contentForModel: string;
  isTruncated: boolean;
  totalLines: number;
  totalBytes: number;
  contentHash: string;
  diskPath?: string;
}

function sanitizeIdentifier(id: string): string {
  const cleaned = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned.length > 0 ? cleaned.slice(0, 64) : 'tool';
}

export class ToolOutputStore {
  private config: ToolOutputStoreConfig;

  constructor(customConfig?: Partial<ToolOutputStoreConfig>) {
    this.config = {
      maxChars: customConfig?.maxChars ?? 2500,
      maxLines: customConfig?.maxLines ?? 100,
      maxBytes: customConfig?.maxBytes ?? 50 * 1024,
      headLines: customConfig?.headLines ?? 35,
      tailLines: customConfig?.tailLines ?? 35,
      storageDir: customConfig?.storageDir ?? path.join(causyneHome(), 'tool-output')
    };
  }

  public getConfig(): Readonly<ToolOutputStoreConfig> {
    return { ...this.config };
  }

  public processToolOutput(sessionId: string, toolCallId: string, rawOutput: string): StoredOutputResult {
    const text = typeof rawOutput === 'string' ? rawOutput : String(rawOutput ?? '');
    const totalBytes = Buffer.byteLength(text, 'utf8');
    const lines = text.split('\n');
    const totalLines = lines.length;
    const contentHash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

    if (text.length <= this.config.maxChars && totalLines <= this.config.maxLines && totalBytes <= this.config.maxBytes) {
      return {
        contentForModel: text,
        isTruncated: false,
        totalLines,
        totalBytes,
        contentHash
      };
    }

    const safeSession = sanitizeIdentifier(sessionId);
    const safeToolId = sanitizeIdentifier(toolCallId);
    const sessionDir = path.join(this.config.storageDir, safeSession);
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

    const diskPath = path.join(sessionDir, `${safeToolId}_${contentHash}.log`);
    fs.writeFileSync(diskPath, text, { encoding: 'utf8', mode: 0o600 });

    const head = lines.slice(0, this.config.headLines).join('\n');
    const tail = lines.slice(-this.config.tailLines).join('\n');
    const omittedLines = Math.max(0, totalLines - (this.config.headLines + this.config.tailLines));

    const contentForModel = [
      head,
      `\n[... Causyne ToolOutputStore: ${omittedLines} lines (${Math.max(1, Math.round(totalBytes / 1024))} KB) truncated. Content Hash: ${contentHash} ...]`,
      `[... Full log persisted to: ${diskPath} ...]`,
      `[... To inspect exact lines without bloating prompt, run: sed -n '<start>,<end>p' "${diskPath}" ...]\n`,
      tail
    ].join('\n');

    return {
      contentForModel,
      isTruncated: true,
      totalLines,
      totalBytes,
      contentHash,
      diskPath
    };
  }

  public readSlice(diskPath: string, startLine: number, endLine: number): string {
    const resolvedPath = path.resolve(diskPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`ToolOutputStore: Log file not found at ${resolvedPath}`);
    }
    const lines = fs.readFileSync(resolvedPath, 'utf8').split('\n');
    const clampedStart = Math.max(1, Math.min(startLine, lines.length));
    const clampedEnd = Math.max(clampedStart, Math.min(endLine, lines.length));
    return lines.slice(clampedStart - 1, clampedEnd).join('\n');
  }

  public pruneOldOutputs(maxAgeMs = 7 * 24 * 60 * 60 * 1000): number {
    if (!fs.existsSync(this.config.storageDir)) return 0;
    let pruned = 0;
    const now = Date.now();
    try {
      const sessions = fs.readdirSync(this.config.storageDir);
      for (const session of sessions) {
        const sessionPath = path.join(this.config.storageDir, session);
        const stat = fs.statSync(sessionPath);
        if (stat.isDirectory()) {
          const files = fs.readdirSync(sessionPath);
          for (const file of files) {
            const filePath = path.join(sessionPath, file);
            const fileStat = fs.statSync(filePath);
            if (now - fileStat.mtimeMs > maxAgeMs) {
              fs.unlinkSync(filePath);
              pruned++;
            }
          }
          if (fs.readdirSync(sessionPath).length === 0) {
            fs.rmdirSync(sessionPath);
          }
        }
      }
    } catch {
      // Non-fatal cleanup
    }
    return pruned;
  }
}

export const defaultToolOutputStore = new ToolOutputStore();

export function processToolOutputWithStore(
  sessionId: string,
  toolCallId: string,
  rawOutput: string,
  store = defaultToolOutputStore
): StoredOutputResult {
  return store.processToolOutput(sessionId, toolCallId, rawOutput);
}
