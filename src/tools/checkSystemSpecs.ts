import os from 'node:os';
import fs from 'node:fs/promises';
import { getErrorMessage, type ToolWorkspaceContext } from './toolPathSafety.js';

export interface SystemSpecsResult {
  success: boolean;
  totalRamMB?: number | undefined;
  freeRamMB?: number | undefined;
  cpuCores?: number | undefined;
  cpuModel?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  architecture?: string | undefined;
  diskSpace?: string | undefined;
  advice?: string | undefined;
  error?: string | undefined;
}

export const checkSystemSpecs = {
  schema: {
    name: 'check_system_specs',
    description: 'Check the hardware specifications of the local machine (RAM, CPU, OS, Disk Space) to evaluate if it can run heavyweight local AI models.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },

  execute: async (_args?: Record<string, unknown>, sandbox?: ToolWorkspaceContext): Promise<SystemSpecsResult> => {
    try {
      const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
      let freeMemMB = Math.round(os.freemem() / 1024 / 1024);
      const cpus = os.cpus();
      const cpuCores = cpus.length;
      const cpuModel = cpus[0]?.model || 'Unknown CPU';
      const platform = os.platform();
      const arch = os.arch();

      if (platform === 'darwin') {
        const usedApproximation = totalMemMB - freeMemMB;
        const inactiveApproximation = usedApproximation * 0.4;
        freeMemMB = Math.round(freeMemMB + inactiveApproximation);
      }

      let diskSpace = 'Unknown';
      try {
        const candidatePath = sandbox?.workspacePaths?.[0];
        const checkPath = typeof candidatePath === 'string' && candidatePath.trim()
          ? candidatePath
          : process.cwd();
        const stats = await fs.statfs(checkPath);
        const freeBytes = stats.bavail * stats.bsize;
        diskSpace = Math.round(freeBytes / 1024 / 1024 / 1024) + ' GB available';
      } catch (e: unknown) {
        diskSpace = 'Could not verify disk space: ' + getErrorMessage(e);
      }

      return {
        success: true,
        totalRamMB: totalMemMB,
        freeRamMB: freeMemMB,
        cpuCores,
        cpuModel,
        platform,
        architecture: arch,
        diskSpace,
        advice: freeMemMB < 4000
          ? 'WARNING: Less than 4GB RAM available. Insufficient for Stage 2 (Local AI Models). Please transition directly to Stage 3 (Pollinations Mode D), Stage 4 (Web Search), or Stage 5 (Procedural Mode A).'
          : 'OK: Sufficient memory for Stage 2 (Local AI Models Mode B/C) execution.'
      };
    } catch (err: unknown) {
      return { success: false, error: getErrorMessage(err) };
    }
  }
};
