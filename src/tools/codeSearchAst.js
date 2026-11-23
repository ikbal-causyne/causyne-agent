import fs from 'node:fs/promises';
import path from 'node:path';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { HEAVY_DEV_EXCLUDES } from './walkerSafety.js';
import { assertSafeWorkspaceInput, getErrorMessage, resolveScopedPath, sanitizeToolError, sanitizeToolText } from './toolPathSafety.js';
const MAX_AST_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DIR_AST_FILES = 50;
const TS_JS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const MULTI_FILE_SOURCE_EXTS = new Set([...TS_JS_EXTS, '.py', '.go', '.rs', '.java', '.kt', '.swift']);
let cachedTsModule;
let cachedBabelParser;
async function loadTypeScriptCompiler() {
    if (cachedTsModule !== undefined)
        return cachedTsModule;
    try {
        const mod = (await import('typescript'));
        const candidate = (mod?.default && typeof mod.default.createSourceFile === 'function') ? mod.default : mod;
        cachedTsModule = typeof candidate?.createSourceFile === 'function' ? candidate : null;
    }
    catch {
        cachedTsModule = null;
    }
    return cachedTsModule;
}
async function loadBabelParser() {
    if (cachedBabelParser !== undefined)
        return cachedBabelParser;
    try {
        const mod = (await import('@babel/parser'));
        const parseFn = typeof mod?.parse === 'function'
            ? mod.parse
            : (typeof mod?.default?.parse === 'function' ? mod.default.parse : null);
        cachedBabelParser = parseFn ? { parse: parseFn } : null;
    }
    catch {
        cachedBabelParser = null;
    }
    return cachedBabelParser;
}
function extractWithBabelAst(babelParser, code, ext) {
    const plugins = ['decorators-legacy', 'importAttributes'];
    if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts')
        plugins.push('typescript');
    if (ext === '.tsx' || ext === '.jsx')
        plugins.push('jsx');
    const ast = babelParser.parse(code, {
        sourceType: 'unambiguous',
        errorRecovery: true,
        plugins
    });
    const body = Array.isArray(ast?.program?.body) ? ast.program.body : [];
    const structures = [];
    const locSpan = (node) => {
        const start = node?.loc?.start?.line;
        const end = node?.loc?.end?.line;
        if (typeof start === 'number' && typeof end === 'number')
            return `[Lines: ${start}-${end}]`;
        if (typeof start === 'number')
            return `[Line: ${start}]`;
        return '';
    };
    const inspectDecl = (decl, exported) => {
        if (!decl || typeof decl !== 'object' || structures.length >= 400)
            return;
        const exp = exported ? 'export ' : '';
        const t = decl.type;
        if (t === 'FunctionDeclaration' && decl.id?.name) {
            structures.push(`${exp}Function: ${decl.id.name}(...) ${locSpan(decl)}`.trim());
        }
        else if (t === 'ClassDeclaration' && decl.id?.name) {
            const clsName = decl.id.name;
            structures.push(`${exp}Class: ${clsName} ${locSpan(decl)}`.trim());
            const members = Array.isArray(decl.body?.body) ? decl.body.body : [];
            for (const member of members) {
                if (structures.length >= 400)
                    break;
                if ((member?.type === 'ClassMethod' || member?.type === 'TSDeclareMethod') && member.key?.name) {
                    structures.push(`  Method: ${clsName}.${member.key.name}(...) ${locSpan(member)}`.trim());
                }
            }
        }
        else if (t === 'TSInterfaceDeclaration' && decl.id?.name) {
            structures.push(`${exp}Interface: ${decl.id.name} ${locSpan(decl)}`.trim());
        }
        else if (t === 'TSTypeAliasDeclaration' && decl.id?.name) {
            structures.push(`${exp}Type: ${decl.id.name} ${locSpan(decl)}`.trim());
        }
        else if (t === 'TSEnumDeclaration' && decl.id?.name) {
            structures.push(`${exp}Enum: ${decl.id.name} ${locSpan(decl)}`.trim());
        }
        else if (t === 'VariableDeclaration' && Array.isArray(decl.declarations)) {
            for (const d of decl.declarations) {
                if (d?.id?.type !== 'Identifier' || !d.id.name)
                    continue;
                const name = d.id.name;
                const initType = d.init?.type;
                if (initType === 'ArrowFunctionExpression' || initType === 'FunctionExpression') {
                    structures.push(`${exp}Arrow/Var Function: ${name} ${locSpan(d)}`.trim());
                }
                else if (exported || name.toUpperCase() === name) {
                    structures.push(`${exp}Constant: ${name} ${locSpan(d)}`.trim());
                }
            }
        }
    };
    for (const stmt of body) {
        if (!stmt || typeof stmt !== 'object')
            continue;
        if (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') {
            if (stmt.declaration)
                inspectDecl(stmt.declaration, true);
        }
        else {
            inspectDecl(stmt, false);
        }
    }
    return structures;
}
function hasExportModifier(ts, node) {
    const mods = typeof ts.canHaveModifiers === 'function' && typeof ts.getModifiers === 'function'
        ? (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)
        : node?.modifiers;
    if (!Array.isArray(mods))
        return false;
    return mods.some((m) => m?.kind === ts.SyntaxKind.ExportKeyword);
}
function extractWithTypeScriptAst(ts, filePath, code, ext) {
    const scriptKind = ext === '.tsx'
        ? ts.ScriptKind.TSX
        : ext === '.jsx'
            ? ts.ScriptKind.JSX
            : (ext === '.js' || ext === '.mjs' || ext === '.cjs')
                ? ts.ScriptKind.JS
                : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true, scriptKind);
    const structures = [];
    const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
    const endLineOf = (node) => sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    const visit = (node, classPrefix = '') => {
        if (structures.length >= 400)
            return;
        if (ts.isFunctionDeclaration(node) && node.name?.text) {
            const exp = hasExportModifier(ts, node) ? 'export ' : '';
            structures.push(`${exp}Function: ${node.name.text}(...) [Lines: ${lineOf(node.getStart(sf))}-${endLineOf(node)}]`);
            return;
        }
        if (ts.isClassDeclaration(node) && node.name?.text) {
            const exp = hasExportModifier(ts, node) ? 'export ' : '';
            const clsName = node.name.text;
            structures.push(`${exp}Class: ${clsName} [Lines: ${lineOf(node.getStart(sf))}-${endLineOf(node)}]`);
            if (Array.isArray(node.members)) {
                for (const member of node.members) {
                    if (structures.length >= 400)
                        break;
                    if (ts.isMethodDeclaration(member) && member.name) {
                        const mName = typeof member.name.text === 'string' ? member.name.text : member.name.getText(sf);
                        structures.push(`  Method: ${clsName}.${mName}(...) [Lines: ${lineOf(member.getStart(sf))}-${endLineOf(member)}]`);
                    }
                }
            }
            return;
        }
        if (ts.isInterfaceDeclaration(node) && node.name?.text) {
            const exp = hasExportModifier(ts, node) ? 'export ' : '';
            structures.push(`${exp}Interface: ${node.name.text} [Lines: ${lineOf(node.getStart(sf))}-${endLineOf(node)}]`);
            return;
        }
        if (ts.isTypeAliasDeclaration(node) && node.name?.text) {
            const exp = hasExportModifier(ts, node) ? 'export ' : '';
            structures.push(`${exp}Type: ${node.name.text} [Lines: ${lineOf(node.getStart(sf))}-${endLineOf(node)}]`);
            return;
        }
        if (ts.isEnumDeclaration(node) && node.name?.text) {
            const exp = hasExportModifier(ts, node) ? 'export ' : '';
            structures.push(`${exp}Enum: ${node.name.text} [Lines: ${lineOf(node.getStart(sf))}-${endLineOf(node)}]`);
            return;
        }
        if (ts.isVariableStatement(node)) {
            const exp = hasExportModifier(ts, node) ? 'export ' : '';
            const decls = node.declarationList?.declarations ?? [];
            for (const decl of decls) {
                if (!ts.isIdentifier(decl.name))
                    continue;
                const name = decl.name.text;
                if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
                    structures.push(`${exp}Arrow/Var Function: ${name} [Lines: ${lineOf(decl.getStart(sf))}-${endLineOf(decl)}]`);
                }
                else if (exp || name.toUpperCase() === name) {
                    structures.push(`${exp}Constant: ${name} [Line: ${lineOf(decl.getStart(sf))}]`);
                }
            }
            return;
        }
        ts.forEachChild(node, (child) => visit(child, classPrefix));
    };
    visit(sf);
    return structures;
}
async function analyzeSingleFile(resolved, tsMod, babelParser, queryLower) {
    const code = await fs.readFile(resolved, 'utf8');
    const ext = path.extname(resolved).toLowerCase();
    let structures = [];
    let engine = 'Line Scanner';
    if (TS_JS_EXTS.has(ext)) {
        if (tsMod) {
            try {
                structures = extractWithTypeScriptAst(tsMod, resolved, code, ext);
                if (structures.length > 0)
                    engine = 'TypeScript AST';
            }
            catch {
                structures = [];
            }
        }
        if (structures.length === 0 && babelParser) {
            try {
                structures = extractWithBabelAst(babelParser, code, ext);
                engine = 'TypeScript/JS AST';
            }
            catch {
                structures = [];
            }
        }
        if (structures.length === 0 && (ext === '.js' || ext === '.mjs' || ext === '.cjs')) {
            try {
                const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
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
                            }
                            else if (node.id.name.toUpperCase() === node.id.name) {
                                structures.push(`Constant: ${node.id.name}`);
                            }
                        }
                    }
                });
                engine = 'Acorn AST';
            }
            catch (acornError) {
                structures.push(`[AST Parse Warning: ${sanitizeToolText(getErrorMessage(acornError), 200)}. Falling back to Regex Pseudo-AST]`);
            }
        }
    }
    if (structures.length === 0 || (structures.length === 1 && structures[0].startsWith('[AST Parse Warning:'))) {
        const lines = code.split('\n');
        const functionRegex = /^(?:export\s+)?(?:async\s+)?(?:function\s+|class\s+|const\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]{0,256}\)|[a-zA-Z0-9_$]+)\s*=>|def\s+|func\s+|public\s+class\s+|public\s+static\s+|type\s+|interface\s+|enum\s+|struct\s+|trait\s+)/;
        for (let i = 0; i < lines.length && structures.length < 500; i++) {
            const line = (lines[i] ?? '').trim();
            if (line.length <= 512 && functionRegex.test(line)) {
                const signature = line.replace(/\{$/, '').trim();
                structures.push(`Line ${i + 1}: ${signature}`);
            }
        }
    }
    const filtered = queryLower
        ? structures.filter((s) => s.toLowerCase().includes(queryLower))
        : structures;
    return { structures: filtered, engine };
}
export const codeSearchAst = {
    schema: {
        name: 'code_search_ast',
        description: 'Extract functions, classes, methods, interfaces, types, enums, and constants using the TypeScript/JS AST (with multi-language fallback) for a file or workspace directory without loading full file bodies.',
        parameters: {
            type: 'object',
            properties: {
                targetFile: {
                    type: 'string',
                    description: 'Workspace file or directory path to parse.'
                },
                query: {
                    type: 'string',
                    description: 'Optional case-insensitive symbol substring filter.'
                },
                maxFiles: {
                    type: 'integer',
                    description: 'Maximum source files to scan when targetFile is a directory (default 25, max 50).'
                }
            },
            required: ['targetFile']
        }
    },
    async execute(args = {}, context) {
        try {
            const queryLower = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : '';
            const resolvedPath = resolveScopedPath(args?.targetFile, context);
            const stat = await fs.lstat(resolvedPath);
            if (stat.isSymbolicLink()) {
                return { success: false, error: `Refusing to analyze symbolic link: ${sanitizeToolText(resolvedPath, 200)}` };
            }
            const [tsMod, babelParser] = await Promise.all([loadTypeScriptCompiler(), loadBabelParser()]);
            if (stat.isDirectory()) {
                const maxFiles = Math.max(1, Math.min(MAX_DIR_AST_FILES, Math.floor(args?.maxFiles ?? 25)));
                const files = [];
                const queue = [{ dir: resolvedPath, depth: 0 }];
                let qIdx = 0;
                while (qIdx < queue.length && files.length < maxFiles) {
                    const { dir, depth } = queue[qIdx++];
                    if (depth > 8)
                        continue;
                    let entries;
                    try {
                        entries = await fs.readdir(dir, { withFileTypes: true });
                    }
                    catch {
                        continue;
                    }
                    entries.sort((a, b) => a.name.localeCompare(b.name));
                    for (const entry of entries) {
                        if (files.length >= maxFiles)
                            break;
                        if (entry.isSymbolicLink())
                            continue;
                        const full = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                            if (HEAVY_DEV_EXCLUDES.has(entry.name) || entry.name.startsWith('.'))
                                continue;
                            queue.push({ dir: full, depth: depth + 1 });
                        }
                        else if (entry.isFile() && MULTI_FILE_SOURCE_EXTS.has(path.extname(entry.name).toLowerCase())) {
                            const fStat = await fs.lstat(full).catch(() => null);
                            if (fStat && !fStat.isSymbolicLink() && fStat.size <= MAX_AST_FILE_BYTES) {
                                files.push(full);
                            }
                        }
                    }
                }
                const sections = [`Directory: ${sanitizeToolText(resolvedPath, 260)} (${files.length} file(s) scanned)`];
                let totalMatched = 0;
                for (const file of files) {
                    const rel = path.relative(resolvedPath, file).replace(/\\/g, '/');
                    const { structures: syms } = await analyzeSingleFile(file, tsMod, babelParser, queryLower);
                    if (syms.length > 0) {
                        totalMatched += syms.length;
                        sections.push(`\n## ${sanitizeToolText(rel, 200)}\n${syms.join('\n')}`);
                    }
                }
                if (totalMatched === 0) {
                    sections.push('\nNo matching structural definitions found.');
                }
                return { success: true, output: sanitizeToolText(sections.join('\n'), 120_000) };
            }
            const { resolved } = await assertSafeWorkspaceInput(args?.targetFile, context, { maxBytes: MAX_AST_FILE_BYTES });
            const { structures, engine } = await analyzeSingleFile(resolved, tsMod, babelParser, queryLower);
            let output = `File: ${sanitizeToolText(resolved, 260)}\nStructure Summary (${engine}):\n\n`;
            if (structures.length === 0) {
                output += 'No structural definitions found.\n';
            }
            else {
                output += structures.join('\n');
            }
            return { success: true, output: sanitizeToolText(output, 120_000) };
        }
        catch (e) {
            return { success: false, error: `Error analyzing file: ${sanitizeToolError(e)}` };
        }
    }
};
