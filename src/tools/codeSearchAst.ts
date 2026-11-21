import fs from 'node:fs/promises';
import path from 'node:path';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import {
  assertSafeWorkspaceInput,
  getErrorMessage,
  sanitizeToolError,
  sanitizeToolText,
  type ToolWorkspaceContext
} from './toolPathSafety.js';

const MAX_AST_FILE_BYTES = 2 * 1024 * 1024;

export interface CodeSearchAstArgs {
  targetFile?: string | undefined;
}

export const codeSearchAst = {
  schema: {
    name: 'code_search_ast',
    description: 'Search for function, class, and variable definitions in a file using AST (Abstract Syntax Tree) without loading the entire file body. Ideal for understanding large codebases without eating up context window tokens.',
    parameters: {
      type: 'object',
      properties: {
        targetFile: {
          type: 'string',
          description: 'Absolute path to the file to parse.'
        }
      },
      required: ['targetFile']
    }
  },

  async execute(args: CodeSearchAstArgs = {}, context?: ToolWorkspaceContext): Promise<string | { success: boolean; output?: string | undefined; error?: string | undefined }> {
    try {
      const { resolved } = await assertSafeWorkspaceInput(args?.targetFile, context, { maxBytes: MAX_AST_FILE_BYTES });
      const code = await fs.readFile(resolved, 'utf8');
      const ext = path.extname(resolved).toLowerCase();
      let output = `File: ${sanitizeToolText(resolved, 260)}\nStructure Summary:\n\n`;

      if (ext === '.js' || ext === '.ts' || ext === '.jsx' || ext === '.tsx') {
        try {
          const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
          const structures: string[] = [];

          walk.simple(ast, {
            FunctionDeclaration(node) {
              const name = node.id ? node.id.name : 'anonymous';
              structures.push(`Function: ${name}(...) [Line: ${node.loc ? node.loc.start.line : 'unknown'}]`);
            },
            ClassDeclaration(node) {
              const name = node.id ? node.id.name : 'anonymous';
              structures.push(`Class: ${name} [Line: ${node.loc ? node.loc.start.line : 'unknown'}]`);
            },
            VariableDeclarator(node) {
              if (node.id && node.id.type === 'Identifier' && node.init) {
                if (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression') {
                  structures.push(`Arrow/Var Function: ${node.id.name} [Line: ${node.loc ? node.loc.start.line : 'unknown'}]`);
                } else if (node.id.name.toUpperCase() === node.id.name) {
                  structures.push(`Constant: ${node.id.name}`);
                }
              }
            }
          });

          if (structures.length === 0) {
            output += 'No major functions or classes found via AST.\n';
          } else {
            output += structures.join('\n');
          }
          return output;
        } catch (acornError: unknown) {
          output += `[AST Parse Warning: ${getErrorMessage(acornError)}. Falling back to Regex Pseudo-AST]\n`;
        }
      }

      const lines = code.split('\n');
      const results: string[] = [];
      const functionRegex = /^(?:export\s+)?(?:async\s+)?(?:function\s+|class\s+|const\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]{0,256}\)|[a-zA-Z0-9_$]+)\s*=>|def\s+|func\s+|public\s+class\s+|public\s+static\s+|type\s+|interface\s+)/;

      for (let i = 0; i < lines.length; i++) {
        const line = (lines[i] ?? '').trim();
        if (line.length <= 512 && functionRegex.test(line)) {
          const signature = line.replace(/\{$/, '').trim();
          results.push(`Line ${i + 1}: ${signature}`);
        }
      }

      if (results.length === 0) {
        output += 'No structural definitions found.\n';
      } else {
        output += results.join('\n');
      }

      return output;
    } catch (e: unknown) {
      return `Error analyzing file: ${getErrorMessage(e)}`;
    }
  }
};
