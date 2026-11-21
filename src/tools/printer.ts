import { execFile } from 'node:child_process';
import util from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { sanitizeSubprocessEnv } from './subprocessEnv.js';
import {
  getErrorMessage,
  assertSafeWorkspaceInput,
  boundedInteger,
  sanitizeToolError,
  sanitizeToolText,
  type ToolWorkspaceContext
} from './toolPathSafety.js';

function validatePrinterName(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('printerName must be a string');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128 || trimmed.startsWith('-') || /[^a-zA-Z0-9._\- ()]/.test(trimmed)) {
    throw new Error('printerName contains invalid or disallowed characters');
  }
  return trimmed;
}

const execFileAsync = util.promisify(execFile);

export interface PrinterPrintArgs {
  filePath?: string | undefined;
  printerName?: string | undefined;
  copies?: number | undefined;
}

export interface PrinterStatusArgs {
  printerName?: string | undefined;
}

export const printerPrint = {
  schema: {
    name: 'printer.print',
    description: 'Sends a document (PDF, TXT, Word, Image) directly to physical or virtual printers on the host OS with zero human touch or GUI pop-up.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Absolute path to the document or image to be printed.'
        },
        printerName: {
          type: 'string',
          description: 'Optional name of the target physical printer. If omitted, sends to the OS default physical printer.'
        },
        copies: {
          type: 'integer',
          description: 'Number of copies to print (default: 1).'
        }
      },
      required: ['filePath']
    }
  },
  execute: async (args: PrinterPrintArgs = {}, context?: ToolWorkspaceContext): Promise<Record<string, unknown>> => {
    try {
      const safeArgs = args && typeof args === 'object' ? args : {};
      const safePrinter = validatePrinterName(safeArgs.printerName);
      const safeCopies = boundedInteger(safeArgs.copies, 1, 1, 20);
      const printerName = safePrinter;
      const copies = safeCopies;
      const { resolved: resolvedPath } = await assertSafeWorkspaceInput(safeArgs.filePath, context, { maxBytes: 50 * 1024 * 1024 });
      if (resolvedPath.startsWith('\\\\') || resolvedPath.startsWith('//')) {
        return { success: false, error: 'UNC network paths are not permitted for direct printing.' };
      }

      const platform = os.platform();
      const env = sanitizeSubprocessEnv(process.env);

      if (platform === 'darwin' || platform === 'linux') {
        const lpArgs: string[] = [];
        if (safePrinter) {
          lpArgs.push('-d', safePrinter);
        }
        if (safeCopies > 1) {
          lpArgs.push('-n', String(safeCopies));
        }
        lpArgs.push('--', resolvedPath);

        const { stdout, stderr } = await execFileAsync('lp', lpArgs, { timeout: 30_000, maxBuffer: 1024 * 1024, env, windowsHide: true });
        return {
          success: true,
          message: `Document successfully dispatched to CUPS print spooler (${safePrinter || 'Default Printer'}). Zero human touch.`,
          stdout: sanitizeToolText((stdout || '').trim(), 2000),
          stderr: sanitizeToolText((stderr || '').trim(), 2000)
        };
      } else if (platform === 'win32') {
        const ext = path.extname(resolvedPath).toLowerCase();
        const count = Math.max(1, Math.min(20, Math.floor(Number(copies) || 1)));
        const psScript = ['.txt', '.log', '.csv', '.json', '.md'].includes(ext)
          ? `1..${count} | ForEach-Object { if ($env:CAUSYNE_PRINTER_NAME) { Get-Content -LiteralPath $env:CAUSYNE_PRINT_FILE | Out-Printer -Name $env:CAUSYNE_PRINTER_NAME } else { Get-Content -LiteralPath $env:CAUSYNE_PRINT_FILE | Out-Printer } }`
          : `1..${count} | ForEach-Object { Start-Process -FilePath $env:CAUSYNE_PRINT_FILE -Verb Print -WindowStyle Hidden -PassThru | Out-Null }`;

        const { stdout, stderr } = await execFileAsync('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          psScript
        ], {
          env: {
            ...process.env,
            CAUSYNE_PRINT_FILE: resolvedPath,
            CAUSYNE_PRINTER_NAME: printerName || ''
          }
        });

        return {
          success: true,
          message: `Document dispatched to Windows Spooler (${printerName || 'Default Printer'}) via headless zero-touch execution.`,
          stdout: (stdout || '').trim(),
          stderr: (stderr || '').trim()
        };
      } else {
        return {
          success: false,
          error: `Unsupported OS platform for direct physical printing: ${platform}`
        };
      }
    } catch (error: unknown) {
      return {
        success: false,
        error: `Failed to print document: ${getErrorMessage(error)}`
      };
    }
  }
};

export const printerList = {
  schema: {
    name: 'printer.list_printers',
    description: 'Discovers all physical and virtual printers connected to the local system, returning their names, default status, and online availability.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  execute: async (_args?: Record<string, unknown>, _context?: ToolWorkspaceContext): Promise<Record<string, unknown>> => {
    try {
      const platform = os.platform();

      if (platform === 'darwin' || platform === 'linux') {
        const { stdout } = await execFileAsync('lpstat', ['-p', '-d']).catch((e: unknown) => ({
          stdout: String((e as { stdout?: string })?.stdout || '')
        }));
        const lines = (stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);

        let defaultPrinter: string | null = null;
        const printers: Array<{ name: string; status: string; isDefault: boolean; rawDescription: string }> = [];

        for (const line of lines) {
          if (line.startsWith('system default destination:')) {
            defaultPrinter = line.split(':')[1]?.trim() || null;
          } else if (line.startsWith('printer ')) {
            const parts = line.split(' ');
            const name = parts[1] ?? '';
            const isIdle = line.includes('is idle');
            const isPrinting = line.includes('now printing');
            const isDisabled = line.includes('disabled');
            let status = 'Unknown';
            if (isDisabled) status = 'Offline/Disabled';
            else if (isPrinting) status = 'Printing';
            else if (isIdle) status = 'Ready';

            printers.push({
              name,
              status,
              isDefault: name === defaultPrinter,
              rawDescription: line
            });
          }
        }

        printers.forEach((p) => {
          if (p.name === defaultPrinter) p.isDefault = true;
        });

        return {
          success: true,
          platform,
          defaultPrinter,
          printersCount: printers.length,
          printers
        };
      } else if (platform === 'win32') {
        const psScript = 'Get-CimInstance -ClassName Win32_Printer | Select-Object Name, Default, PrinterStatus, WorkOffline | ConvertTo-Json -Compress';

        const { stdout } = await execFileAsync('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          psScript
        ]);

        let raw: Array<Record<string, unknown>> = [];
        try {
          const parsed: unknown = JSON.parse(stdout.trim() || '[]');
          const list = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []);
          raw = list.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
        } catch {
          raw = [];
        }

        const statusMap: Record<number, string> = {
          1: 'Other', 2: 'Unknown', 3: 'Ready', 4: 'Printing', 5: 'Warming Up',
          6: 'Stopped/Offline', 7: 'Offline'
        };

        const printers = raw.map((p) => {
          const code = Number(p.PrinterStatus);
          return {
            name: String(p.Name ?? ''),
            status: p.WorkOffline ? 'Offline' : (statusMap[code] || 'Ready'),
            isDefault: Boolean(p.Default)
          };
        });

        const defaultPrinter = printers.find((p) => p.isDefault)?.name || null;

        return {
          success: true,
          platform,
          defaultPrinter,
          printersCount: printers.length,
          printers
        };
      } else {
        return { success: false, error: `Unsupported OS platform: ${platform}` };
      }
    } catch (error: unknown) {
      return { success: false, error: `Failed to list printers: ${getErrorMessage(error)}` };
    }
  }
};

export const printerStatus = {
  schema: {
    name: 'printer.get_status',
    description: 'Inspects active print jobs and queue health on all connected physical or virtual printers.',
    parameters: {
      type: 'object',
      properties: {
        printerName: {
          type: 'string',
          description: 'Optional printer name to filter queue status.'
        }
      }
    }
  },
  execute: async (args: PrinterStatusArgs = {}, _context?: ToolWorkspaceContext): Promise<Record<string, unknown>> => {
    try {
      const { printerName } = args || {};
      const platform = os.platform();

      if (platform === 'darwin' || platform === 'linux') {
        const lpArgs = printerName ? ['-o', printerName] : ['-o'];
        const { stdout } = await execFileAsync('lpstat', lpArgs).catch((e: unknown) => ({
          stdout: String((e as { stdout?: string })?.stdout || '')
        }));
        const lines = (stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);

        const activeJobs = lines.map((line) => {
          const parts = line.split(' ');
          return {
            jobId: parts[0] ?? '',
            owner: parts[1] || 'Unknown',
            sizeOrStatus: parts.slice(2).join(' ')
          };
        });

        return {
          success: true,
          platform,
          activeJobsCount: activeJobs.length,
          activeJobs
        };
      } else if (platform === 'win32') {
        const psScript = 'Get-CimInstance -ClassName Win32_PrintJob | Where-Object { -not $env:CAUSYNE_PRINTER_FILTER -or $_.Name -like ("*" + $env:CAUSYNE_PRINTER_FILTER + "*") } | Select-Object JobId, Document, Owner, Status | ConvertTo-Json -Compress';

        const { stdout } = await execFileAsync('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          psScript
        ], {
          env: {
            ...process.env,
            CAUSYNE_PRINTER_FILTER: printerName || ''
          }
        });

        let raw: Array<Record<string, unknown>> = [];
        try {
          const parsed: unknown = JSON.parse(stdout.trim() || '[]');
          const list = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []);
          raw = list.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
        } catch {
          raw = [];
        }

        return {
          success: true,
          platform,
          activeJobsCount: raw.length,
          activeJobs: raw
        };
      } else {
        return { success: false, error: `Unsupported OS platform: ${platform}` };
      }
    } catch (error: unknown) {
      return { success: false, error: `Failed to inspect printer status: ${getErrorMessage(error)}` };
    }
  }
};

export const printerTool = printerPrint;
