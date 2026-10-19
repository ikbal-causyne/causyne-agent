import fs from 'fs';
import path from 'path';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

export const codeSearchAst = {
  schema: {
    name: 'code_search_ast',
    description: "Search for function, class, and variable definitions in a file using AST (Abstract Syntax Tree) without loading the entire file body. Ideal for understanding large codebases without eating up context window tokens.",
    parameters: {
      type: "object",
      properties: {
        targetFile: {
          type: "string",
          description: "Absolute path to the file to parse."
        }
      },
      required: ["targetFile"]
    }
  },

  // Named execute() like every other tool — as run() it was registered but the
  // agent loop's toolRegistry[name].execute lookup could never reach it.
  async execute({ targetFile }) {
    if (!fs.existsSync(targetFile)) {
      return `Error: File not found at ${targetFile}`;
    }

    try {
      const code = fs.readFileSync(targetFile, 'utf8');
      const ext = path.extname(targetFile).toLowerCase();
      let output = `File: ${targetFile}\nStructure Summary:\n\n`;

      if (ext === '.js' || ext === '.ts' || ext === '.jsx' || ext === '.tsx') {
        // Use Acorn for deep, accurate JS/TS parsing
        // We configure acorn to allow modern syntax and jsx/ts (tolerant mode via loose/default)
        // Note: acorn natively only supports standard JS. For TS/JSX, we use standard regex fallback if acorn fails.
        try {
          const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
          const structures = [];

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
              if (node.id && node.id.name && node.init) {
                if (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression') {
                  structures.push(`Arrow/Var Function: ${node.id.name} [Line: ${node.loc ? node.loc.start.line : 'unknown'}]`);
                } else if (node.id.name.toUpperCase() === node.id.name) { // Detect constants
                  structures.push(`Constant: ${node.id.name}`);
                }
              }
            }
          });

          if (structures.length === 0) {
            output += "No major functions or classes found via AST.\n";
          } else {
            output += structures.join('\n');
          }
          return output;

        } catch (acornError) {
          // If acorn fails (e.g., on TS or JSX syntax), fallback to regex
          output += `[AST Parse Warning: ${acornError.message}. Falling back to Regex Pseudo-AST]\n`;
        }
      }

      // Regex Pseudo-AST Fallback (for Python, Java, Go, or TS/JSX if acorn fails)
      const lines = code.split('\n');
      const results = [];
      const functionRegex = /^(?:export\s+)?(?:async\s+)?(?:function\s+|class\s+|const\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|[^=]+)\s*=>|def\s+|class\s+|func\s+|public\s+class\s+|public\s+static\s+|type\s+|interface\s+)/;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (functionRegex.test(line)) {
          // Clean up the line to just show the signature (remove opening brace if present)
          let signature = line.replace(/\{$/, '').trim();
          results.push(`Line ${i + 1}: ${signature}`);
        }
      }

      if (results.length === 0) {
        output += "No structural definitions found.\n";
      } else {
        output += results.join('\n');
      }

      return output;

    } catch (e) {
      return `Error analyzing file: ${e.message}`;
    }
  }
};
