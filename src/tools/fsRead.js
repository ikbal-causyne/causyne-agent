import fs from 'fs';
import readline from 'readline';
import path from 'path';
import os from 'os';

// Phase 3 AGI Upgrade: Fast Binary Detection
async function isBinary(filePath) {
  try {
    const fd = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(1024);
    const { bytesRead } = await fd.read(buffer, 0, 1024, 0);
    await fd.close();

    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true; // Null byte indicates binary
    }
    return false;
  } catch (e) {
    return false;
  }
}

export const fsRead = {
  schema: {
    name: 'fs.read',
    description: 'Read file contents intelligently. Automatically pages large files to protect Context Window.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'number' },
        endLine: { type: 'number' }
      },
      required: ['path']
    }
  },
  async execute(args) {
    try {
      const target = args.path.replace(/^~\//, os.homedir() + '/');

      if (!fs.existsSync(target)) {
        return { success: false, error: "File does not exist." };
      }

      // Phase 3 AGI Upgrade: Binary Rejection
      if (await isBinary(target)) {
        return { success: false, error: "Cannot read binary file as text. Use viewImage or OCR tools instead." };
      }

      const start = args.startLine ? Math.max(1, args.startLine) : 1;
      let end = args.endLine ? args.endLine : start + 799;

      // Phase 3 AGI Upgrade: Mandatory Paging Limit (800)
      if (end - start + 1 > 800) {
        end = start + 799;
      }

      let currentLine = 1;
      let outputLines = [];
      let totalLines = 0;

      // Phase 3 AGI Upgrade: Stream (no full buffering)
      const rl = readline.createInterface({
        input: fs.createReadStream(target),
        crlfDelay: Infinity
      });

      for await (const line of rl) {
        totalLines++;
        if (currentLine >= start && currentLine <= end) {
          outputLines.push(line);
        }
        currentLine++;
      }

      let finalOutput = outputLines.join('\n');

      if (totalLines > end) {
        finalOutput += `\n\n[WARNING: File truncated at line ${end} out of ${totalLines}. Use { startLine: ${end + 1}, endLine: ${end + 800} } to read more.]`;
      }

      return { success: true, output: finalOutput };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
