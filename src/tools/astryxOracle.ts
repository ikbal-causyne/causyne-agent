import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sanitizeSubprocessEnv } from './subprocessEnv.js';
import { getErrorMessage, sanitizeToolError, sanitizeToolText, type ToolWorkspaceContext } from './toolPathSafety.js';

const execFileAsync = promisify(execFile);

export interface AstryxOracleArgs {
  command?: string | undefined;
  target?: string | undefined;
}

export interface AstryxOracleResult {
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
}

export const astryxOracle = {
  schema: {
    name: 'astryx_oracle',
    description: 'Query the Astryx Design System (Meta) CLI for UI component documentation, design tokens, and templates. Use this to learn how to build UIs with Astryx.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: ['list_components', 'read_component', 'list_docs', 'read_doc', 'list_templates'],
          description: 'The Astryx CLI command to run.'
        },
        target: {
          type: 'string',
          description: 'The specific component or doc topic to read (e.g., "Button", "tokens"). Leave empty for list commands.'
        }
      },
      required: ['command']
    }
  },
  execute: async (args: AstryxOracleArgs = {}, _context?: ToolWorkspaceContext): Promise<AstryxOracleResult> => {
    const safeArgs = args && typeof args === 'object' ? args : {};
    const { command, target = '' } = safeArgs;
    const rawTarget = typeof target === 'string' ? target.slice(0, 128) : '';
    const cleaned = rawTarget.replace(/[^a-zA-Z0-9_-]/g, '');
    let startIdx = 0;
    while (startIdx < cleaned.length && cleaned[startIdx] === '-') startIdx++;
    const sanitizedTarget = cleaned.slice(startIdx);

    let cliArgs: string[] = [];
    switch (command) {
      case 'list_components':
        cliArgs = ['component'];
        break;
      case 'read_component':
        if (!sanitizedTarget) return { success: false, error: 'target component name is required for read_component' };
        cliArgs = ['component', sanitizedTarget];
        break;
      case 'list_docs':
        cliArgs = ['docs'];
        break;
      case 'read_doc':
        if (!sanitizedTarget) return { success: false, error: 'target doc name is required for read_doc' };
        cliArgs = ['docs', sanitizedTarget];
        break;
      case 'list_templates':
        cliArgs = ['template', '--list'];
        break;
      default:
        return { success: false, error: 'Unknown command' };
    }

    try {
      const { stdout } = await execFileAsync('npx', ['--no', '@astryxdesign/cli', ...cliArgs], {
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024
      });

      return {
        success: true,
        output: stdout.trim()
      };
    } catch (error: unknown) {
      const execErr = error as { stderr?: string | Buffer; message?: string };
      return {
        success: false,
        error: execErr?.stderr
          ? execErr.stderr.toString()
          : `${getErrorMessage(error)}. Install @astryxdesign/cli explicitly before using this optional integration.`
      };
    }
  }
};
