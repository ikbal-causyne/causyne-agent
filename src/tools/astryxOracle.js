import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
          description: 'The Astryx CLI command to run.',
        },
        target: {
          type: 'string',
          description: 'The specific component or doc topic to read (e.g., "Button", "tokens"). Leave empty for list commands.',
        },
      },
      required: ['command'],
    }
  },
  execute: async (args, context) => {
    const { command, target = '' } = args;

    // Sanitize target to prevent command injection
    const sanitizedTarget = target.replace(/[^a-zA-Z0-9_-]/g, '');

    let cliArgs = [];
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
      // `--no` forbids npm from downloading an absent package. The user must
      // install and review the third-party CLI explicitly before this adapter
      // can call it. execFile keeps model-derived arguments out of a shell.
      const { stdout } = await execFileAsync('npx', ['--no', '@astryxdesign/cli', ...cliArgs], {
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024
      });

      return {
        success: true,
        output: stdout.trim()
      };
    } catch (error) {
      return {
        success: false,
        error: error.stderr
          ? error.stderr.toString()
          : `${error.message}. Install @astryxdesign/cli explicitly before using this optional integration.`
      };
    }
  }
};
