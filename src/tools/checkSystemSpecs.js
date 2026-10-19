import os from 'os';
import fs from 'fs/promises';

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
  
  execute: async (args, sandbox) => {
    try {
      const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
      let freeMemMB = Math.round(os.freemem() / 1024 / 1024);
      const cpuCores = os.cpus().length;
      const cpuModel = os.cpus()[0]?.model || 'Unknown CPU';
      const platform = os.platform();
      const arch = os.arch();
      
      // Phase 1 AGI Upgrade: Native Memory Math (macOS Approximation without shell)
      if (platform === 'darwin') {
        // os.freemem() on Mac only shows "free", not "inactive" memory.
        // We use a safe heuristic based on total memory minus an active buffer baseline.
        // This avoids brittle shell execution (`vm_stat`).
        const usedApproximation = totalMemMB - freeMemMB;
        const inactiveApproximation = usedApproximation * 0.4; // rough estimate of inactive
        freeMemMB = Math.round(freeMemMB + inactiveApproximation);
      }

      // Phase 1 AGI Upgrade: Native Disk Math
      let diskSpace = "Unknown";
      try {
        const checkPath = (sandbox && sandbox.workspacePaths && sandbox.workspacePaths.length > 0) 
            ? sandbox.workspacePaths[0] 
            : process.cwd();
            
        const stats = await fs.statfs(checkPath);
        // bavail (available blocks) * bsize (block size)
        const freeBytes = stats.bavail * stats.bsize;
        diskSpace = Math.round(freeBytes / 1024 / 1024 / 1024) + ' GB available';
      } catch (e) {
        diskSpace = "Could not verify disk space: " + e.message;
      }

      return {
        success: true,
        totalRamMB: totalMemMB,
        freeRamMB: freeMemMB,
        cpuCores: cpuCores,
        cpuModel: cpuModel,
        platform: platform,
        architecture: arch,
        diskSpace: diskSpace,
        advice: freeMemMB < 4000 ? "WARNING: Less than 4GB RAM available. Insufficient for Stage 2 (Local AI Models). Please transition directly to Stage 3 (Pollinations Mode D), Stage 4 (Web Search), or Stage 5 (Procedural Mode A)." : "OK: Sufficient memory for Stage 2 (Local AI Models Mode B/C) execution."
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
};
