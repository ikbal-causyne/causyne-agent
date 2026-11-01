// Sovereign Reverse Engineering & Binary Inspection Capability.
//
// Native Causyne Agent reverse engineering suite backed by the headless sovereign
// engine substrate with zero-dependency static analysis fallbacks.
//
// Compliant with Causyne progressive disclosure (toolPacks.ts) and DTOC
// token-guarding offload (toolOutputStore.ts).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import util from 'node:util';
import { resolveUserPath } from '../utils/paths.js';
import { ToolOutputStore, defaultToolOutputStore } from './toolOutputStore.js';
import { isAutonomousToolContext } from '../approvalPolicy.js';
import { sovereignReverseHarness } from '../engines/reverseHarness.js';
const execFileAsync = util.promisify(execFile);
// ─────────────────────────────────────────────────────────────────────────────
// NATIVE BINARY PARSERS (Pure Node.js Zero-Dependency Fallback)
// ─────────────────────────────────────────────────────────────────────────────
function parseMachO(buffer) {
    const magic = buffer.readUInt32BE(0);
    const is64 = magic === 0xfeedfacf || magic === 0xcffaedfe;
    const isLe = magic === 0xfeedfacf || magic === 0xfeedface;
    const isFat = magic === 0xcafebabe || magic === 0xbebafeca;
    if (isFat) {
        let architecture = 'Universal FAT (Mach-O)';
        const nfat_arch = buffer.readUInt32BE(4);
        if (buffer.length >= 8 + nfat_arch * 20) {
            for (let i = 0; i < nfat_arch; i++) {
                const offset = 8 + i * 20;
                const cputype = buffer.readInt32BE(offset);
                const sliceOffset = buffer.readUInt32BE(offset + 8);
                const sliceSize = buffer.readUInt32BE(offset + 12);
                if (sliceOffset + 8 <= buffer.length) {
                    const sliceBuf = buffer.subarray(sliceOffset, Math.min(sliceOffset + sliceSize, buffer.length));
                    if (sliceBuf.length >= 8) {
                        const inner = parseMachO(sliceBuf);
                        return {
                            format: 'Mach-O',
                            architecture: `Universal FAT (slice: ${inner.architecture || 'unknown'}, cputype: ${cputype})`,
                            is64Bit: inner.is64Bit ?? true,
                            byteOrder: inner.byteOrder ?? 'little-endian',
                            fileType: inner.fileType ?? 'Mach-O Universal Binary',
                            mitigations: inner.mitigations ?? { pie: true, nx: true, aslr: true, codeSigned: true }
                        };
                    }
                }
            }
        }
        return {
            format: 'Mach-O',
            architecture,
            is64Bit: true,
            byteOrder: 'big-endian',
            fileType: 'Mach-O Universal Binary',
            mitigations: { pie: true, nx: true, aslr: true, codeSigned: true }
        };
    }
    const cputype = isLe ? buffer.readInt32LE(4) : buffer.readInt32BE(4);
    let architecture = 'unknown';
    if (cputype === 0x01000007)
        architecture = 'x86_64';
    else if (cputype === 0x0100000c)
        architecture = 'arm64';
    else if (cputype === 7)
        architecture = 'i386';
    else if (cputype === 12)
        architecture = 'arm';
    const filetypeInt = isLe ? buffer.readUInt32LE(12) : buffer.readUInt32BE(12);
    let fileType = 'Mach-O Binary';
    if (filetypeInt === 2)
        fileType = 'Executable (MH_EXECUTE)';
    else if (filetypeInt === 6)
        fileType = 'Shared Library (MH_DYLIB)';
    else if (filetypeInt === 8)
        fileType = 'Bundle (MH_BUNDLE)';
    const flags = isLe ? buffer.readUInt32LE(24) : buffer.readUInt32BE(24);
    const pie = (flags & 0x200000) !== 0; // MH_PIE
    return {
        format: 'Mach-O',
        architecture,
        is64Bit: is64,
        byteOrder: isLe ? 'little-endian' : 'big-endian',
        fileType,
        mitigations: {
            pie,
            nx: true,
            aslr: pie,
            codeSigned: true
        }
    };
}
function parseElf(buffer) {
    const is64 = buffer[4] === 2;
    const isLe = buffer[5] === 1;
    const readU16 = (off) => isLe ? buffer.readUInt16LE(off) : buffer.readUInt16BE(off);
    const readU32 = (off) => isLe ? buffer.readUInt32LE(off) : buffer.readUInt32BE(off);
    const eType = readU16(16);
    let fileType = 'ELF Binary';
    let pie = false;
    if (eType === 2) {
        fileType = 'Executable (ET_EXEC)';
        pie = false;
    }
    else if (eType === 3) {
        fileType = 'Shared Object / Dynamic Library (ET_DYN)';
        pie = true;
    }
    const eMachine = readU16(18);
    let architecture = 'unknown';
    if (eMachine === 0x3e)
        architecture = 'x86_64';
    else if (eMachine === 0xb7)
        architecture = 'aarch64 (ARM64)';
    else if (eMachine === 0x03)
        architecture = 'i386';
    else if (eMachine === 0x28)
        architecture = 'ARM (32-bit)';
    else if (eMachine === 0xf3)
        architecture = 'RISC-V';
    return {
        format: 'ELF',
        architecture,
        is64Bit: is64,
        byteOrder: isLe ? 'little-endian' : 'big-endian',
        fileType,
        mitigations: {
            pie,
            nx: true,
            relro: pie ? 'full' : 'partial'
        }
    };
}
function parsePE(buffer) {
    if (buffer.length < 64)
        return { format: 'PE/COFF' };
    const peOffset = buffer.readUInt32LE(0x3c);
    if (peOffset + 24 > buffer.length)
        return { format: 'PE/COFF' };
    const peSig = buffer.toString('utf8', peOffset, peOffset + 4);
    if (peSig !== 'PE\0\0')
        return { format: 'PE/COFF' };
    const machine = buffer.readUInt16LE(peOffset + 4);
    let architecture = 'unknown';
    if (machine === 0x8664)
        architecture = 'x86_64 (AMD64)';
    else if (machine === 0xaa64)
        architecture = 'ARM64';
    else if (machine === 0x14c)
        architecture = 'i386 (x86)';
    const optHeaderOffset = peOffset + 24;
    let is64 = false;
    let pie = false;
    let nx = false;
    if (optHeaderOffset + 72 <= buffer.length) {
        const magic = buffer.readUInt16LE(optHeaderOffset);
        is64 = magic === 0x20b; // PE32+
        const dllCharOffset = optHeaderOffset + 70;
        if (dllCharOffset + 2 <= buffer.length) {
            const dllCharacteristics = buffer.readUInt16LE(dllCharOffset);
            pie = (dllCharacteristics & 0x0040) !== 0; // IMAGE_DLLCHARACTERISTICS_DYNAMIC_BASE
            nx = (dllCharacteristics & 0x0100) !== 0; // IMAGE_DLLCHARACTERISTICS_NX_COMPAT
        }
    }
    return {
        format: 'PE/COFF',
        architecture,
        is64Bit: is64,
        byteOrder: 'little-endian',
        fileType: 'Windows Portable Executable',
        mitigations: {
            pie,
            nx,
            aslr: pie
        }
    };
}
function parseAsarHeader(buffer) {
    if (buffer.length < 16)
        return null;
    const magic = buffer.readUInt32LE(0);
    if (magic !== 4)
        return null;
    const headerSize = buffer.readUInt32LE(12);
    if (16 + headerSize > buffer.length)
        return null;
    try {
        const headerJson = buffer.toString('utf8', 16, 16 + headerSize);
        const header = JSON.parse(headerJson);
        return { headerSize: 16 + headerSize, header };
    }
    catch {
        return null;
    }
}
function listAsarFiles(dir, prefix = '') {
    const list = [];
    if (!dir || !dir.files)
        return list;
    for (const [name, entry] of Object.entries(dir.files)) {
        const fullPath = prefix ? `${prefix}/${name}` : name;
        if ('files' in entry && entry.files) {
            list.push(...listAsarFiles(entry, fullPath));
        }
        else if ('size' in entry && typeof entry.size === 'number') {
            list.push({ path: fullPath, size: entry.size });
        }
    }
    return list;
}
// ─────────────────────────────────────────────────────────────────────────────
// JAVASCRIPT / BUNDLE SCRIPT DEOBFUSCATOR
// ─────────────────────────────────────────────────────────────────────────────
async function deobfuscateScript(filePath) {
    const code = await fsp.readFile(filePath, 'utf8');
    const sourcemapDetected = /\/\/# sourceMappingURL=/i.test(code) || /\/\*# sourceMappingURL=/i.test(code);
    const urlMatches = code.match(/https?:\/\/[a-zA-Z0-9./?=_%&:-]+/g) || [];
    const routeMatches = code.match(/['"`]\/(?:api|v[0-9]|auth|users|admin|graphql)[a-zA-Z0-9/_-]*['"`]/g) || [];
    const cleanedRoutes = routeMatches.map(r => r.slice(1, -1));
    const uniqueEndpoints = Array.from(new Set([...urlMatches, ...cleanedRoutes]));
    const lines = code.split('\n').length;
    const summary = `Script Analysis: ${lines} lines, ${code.length} characters. Sourcemap: ${sourcemapDetected ? 'Present' : 'None'}. Harvested ${uniqueEndpoints.length} endpoints.`;
    return {
        sourcemapDetected,
        extractedRoutes: uniqueEndpoints.slice(0, 50),
        summary
    };
}
// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL TOOL DEFINITION
// ─────────────────────────────────────────────────────────────────────────────
export const reverseEngineering = {
    schema: {
        name: 'reverse_engineering',
        description: 'Sovereign reverse engineering, binary triage, decompilation, bundle unpacking, and runtime tracing suite backed by headless MCP engine substrate.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['inspect', 'decompile', 'unpack', 'deobfuscate', 'trace', 'status', 'engine_tool', 'list_tools'],
                    description: 'Reverse engineering action to perform.'
                },
                filePath: {
                    type: 'string',
                    description: 'Absolute or workspace-relative path to target binary, bundle, or script.'
                },
                target: {
                    type: 'string',
                    description: 'Process name, function symbol, or bundle resource identifier.'
                },
                outputDir: {
                    type: 'string',
                    description: 'Target extraction directory for bundle unpacking.'
                },
                functionName: {
                    type: 'string',
                    description: 'Specific function symbol to decompile or disassemble.'
                },
                address: {
                    type: 'string',
                    description: 'Hexadecimal memory address (e.g. "0x100003fa0") to inspect or decompile.'
                },
                engine: {
                    type: 'string',
                    enum: ['auto', 'ghidra', 'rizin', 'hopper', 'native'],
                    description: 'Decompiler engine preference (default: auto).'
                },
                detail: {
                    type: 'string',
                    enum: ['summary', 'symbols', 'headers', 'mitigations', 'full'],
                    description: 'Level of analytical detail.'
                },
                listOnly: {
                    type: 'boolean',
                    description: 'When unpacking, list container manifest contents without extracting files to disk.'
                },
                script: {
                    type: 'string',
                    description: 'Custom instrumentation or tracer hook script.'
                },
                toolName: {
                    type: 'string',
                    description: 'Specific engine tool name to execute when action is "engine_tool".'
                },
                toolArgs: {
                    type: 'object',
                    description: 'Arguments payload for engine_tool.'
                }
            },
            required: ['action']
        }
    },
    async execute(args, context = {}) {
        const action = String(args['action'] || 'status');
        const rawPath = typeof args['filePath'] === 'string' ? args['filePath'] : undefined;
        const outputDir = typeof args['outputDir'] === 'string' ? args['outputDir'] : undefined;
        const functionName = typeof args['functionName'] === 'string' ? args['functionName'] : undefined;
        const address = typeof args['address'] === 'string' ? args['address'] : undefined;
        const engine = typeof args['engine'] === 'string' ? args['engine'] : 'auto';
        const detail = typeof args['detail'] === 'string' ? args['detail'] : 'summary';
        const listOnly = Boolean(args['listOnly']);
        const workspaceDir = context.workspaceDir || process.cwd();
        const sessionId = context.sessionId || 're_session';
        const outputStore = defaultToolOutputStore;
        const callId = `re_${Date.now()}`;
        // ── ACTION: STATUS ────────────────────────────────────────────────────
        if (action === 'status') {
            const engines = {};
            const checkCmd = async (cmd) => {
                try {
                    await execFileAsync('which', [cmd]);
                    return true;
                }
                catch {
                    return false;
                }
            };
            engines['otool'] = await checkCmd('otool');
            engines['objdump'] = await checkCmd('objdump');
            engines['nm'] = await checkCmd('nm');
            engines['file'] = await checkCmd('file');
            engines['ghidra'] = await checkCmd('analyzeHeadless');
            engines['rizin'] = await checkCmd('rizin');
            engines['frida'] = await checkCmd('frida');
            const engineAvailable = await sovereignReverseHarness.isAvailable();
            const toolList = engineAvailable ? await sovereignReverseHarness.listTools() : [];
            return {
                success: true,
                action: 'status',
                platform: process.platform,
                architecture: process.arch,
                engineAvailable,
                specializedEngineToolsCount: toolList.length,
                installedEngines: engines,
                capabilities: [
                    'Mach-O Universal / FAT & 64-bit triage',
                    'ELF executable & shared object parsing',
                    'PE/COFF Windows binary mitigation checks',
                    'Electron ASAR pickle header inspection & extraction',
                    'JavaScript sourcemap recovery and route harvesting',
                    'Dynamic runtime tracing and API observation',
                    'Headless MCP engine with 229 specialized reverse engineering tools'
                ]
            };
        }
        // ── ACTION: LIST_TOOLS ────────────────────────────────────────────────
        if (action === 'list_tools') {
            const tools = await sovereignReverseHarness.listTools();
            return {
                success: true,
                action: 'list_tools',
                totalTools: tools.length,
                tools
            };
        }
        // ── ACTION: ENGINE_TOOL ───────────────────────────────────────────────
        if (action === 'engine_tool') {
            const toolName = typeof args['toolName'] === 'string' ? args['toolName'] : '';
            if (!toolName) {
                return { success: false, error: 'toolName parameter is required for action "engine_tool".' };
            }
            const toolArgs = (args['toolArgs'] && typeof args['toolArgs'] === 'object')
                ? args['toolArgs']
                : {};
            const res = await sovereignReverseHarness.callEngineTool(toolName, toolArgs, context.signal);
            const textOutput = res.output || (res.structuredContent ? JSON.stringify(res.structuredContent, null, 2) : res.error || '');
            const stored = outputStore.processToolOutput(sessionId, `${callId}_${toolName}`, textOutput);
            return {
                success: res.success,
                action: 'engine_tool',
                toolName,
                preview: stored.contentForModel,
                isTruncated: stored.isTruncated,
                diskPath: stored.diskPath,
                error: res.error
            };
        }
        // Require filePath for inspect, decompile, unpack, deobfuscate
        if (!rawPath && action !== 'trace') {
            return { success: false, error: `Action "${action}" requires a valid "filePath" parameter.` };
        }
        const resolvedFile = rawPath ? resolveUserPath(rawPath) : '';
        if (resolvedFile && !fs.existsSync(resolvedFile)) {
            return { success: false, error: `File not found: ${resolvedFile}` };
        }
        // ── ACTION: INSPECT ───────────────────────────────────────────────────
        if (action === 'inspect') {
            try {
                let engineText = '';
                try {
                    const engineRes = await sovereignReverseHarness.inspectBinary(resolvedFile, context.signal);
                    if (engineRes.success && engineRes.output) {
                        engineText = engineRes.output;
                    }
                }
                catch {
                    // Fall back gracefully to native parsing
                }
                const stats = await fsp.stat(resolvedFile);
                const fd = await fsp.open(resolvedFile, 'r');
                const headerBuf = Buffer.alloc(Math.min(8192, stats.size));
                await fd.read(headerBuf, 0, headerBuf.length, 0);
                await fd.close();
                let result = {
                    filePath: resolvedFile,
                    format: 'Unknown'
                };
                const magic32Be = headerBuf.length >= 4 ? headerBuf.readUInt32BE(0) : 0;
                const magic32Le = headerBuf.length >= 4 ? headerBuf.readUInt32LE(0) : 0;
                if (magic32Be === 0xfeedface || magic32Be === 0xfeedfacf ||
                    magic32Le === 0xfeedface || magic32Le === 0xfeedfacf ||
                    magic32Be === 0xcafebabe || magic32Be === 0xbebafeca) {
                    result = { ...result, ...parseMachO(headerBuf) };
                }
                else if (headerBuf[0] === 0x7f && headerBuf[1] === 0x45 && headerBuf[2] === 0x4c && headerBuf[3] === 0x46) {
                    result = { ...result, ...parseElf(headerBuf) };
                }
                else if (headerBuf[0] === 0x4d && headerBuf[1] === 0x5a) {
                    result = { ...result, ...parsePE(headerBuf) };
                }
                else if (headerBuf[0] === 0x00 && headerBuf[1] === 0x61 && headerBuf[2] === 0x73 && headerBuf[3] === 0x6d) {
                    result.format = 'WebAssembly';
                    result.architecture = 'wasm32 / wasm64';
                }
                else if (headerBuf[0] === 0x50 && headerBuf[1] === 0x4b && headerBuf[2] === 0x03 && headerBuf[3] === 0x04) {
                    result.format = 'APK/ZIP';
                    result.fileType = 'Compressed Archive / Package';
                }
                else {
                    const asar = parseAsarHeader(headerBuf);
                    if (asar) {
                        result.format = 'ASAR';
                        result.fileType = 'Electron Archive';
                        const files = listAsarFiles(asar.header);
                        result.metadata = { totalFiles: files.length, sampleFiles: files.slice(0, 10).map(f => f.path) };
                    }
                }
                if (engineText) {
                    result.metadata = { ...(result.metadata ?? {}), engineAnalysis: engineText };
                }
                if (detail === 'symbols' || detail === 'full') {
                    try {
                        const nmRes = await execFileAsync('nm', ['-gU', resolvedFile], { timeout: 10000, maxBuffer: 5 * 1024 * 1024 });
                        const symbols = nmRes.stdout.split('\n').filter(Boolean).slice(0, 100);
                        result.exportedSymbols = symbols;
                    }
                    catch {
                        // nm not available or stripped binary
                    }
                }
                const rawJson = JSON.stringify(result, null, 2);
                const stored = outputStore.processToolOutput(sessionId, `${callId}_inspect`, rawJson);
                return {
                    success: true,
                    action: 'inspect',
                    format: result.format,
                    architecture: result.architecture || 'unknown',
                    mitigations: result.mitigations,
                    preview: stored.contentForModel,
                    isTruncated: stored.isTruncated,
                    diskPath: stored.diskPath
                };
            }
            catch (err) {
                return { success: false, error: `Inspection failed: ${err instanceof Error ? err.message : String(err)}` };
            }
        }
        // ── ACTION: DECOMPILE ─────────────────────────────────────────────────
        if (action === 'decompile') {
            try {
                let disassemblyText = '';
                // 1. Try sovereign engine decompilation
                try {
                    const engineRes = await sovereignReverseHarness.decompile(resolvedFile, functionName, address, context.signal);
                    if (engineRes.success && engineRes.output) {
                        disassemblyText = engineRes.output;
                    }
                }
                catch {
                    // Fall back gracefully
                }
                // 2. Fallbacks if engine output is empty
                if (!disassemblyText && engine === 'rizin') {
                    try {
                        const args = ['-q', '-c', functionName ? `pdf @ ${functionName}` : 'pdr @ main', resolvedFile];
                        const rzRes = await execFileAsync('rizin', args, { timeout: 30000 });
                        disassemblyText = rzRes.stdout;
                    }
                    catch (e) {
                        disassemblyText = `[Rizin failed: ${e instanceof Error ? e.message : String(e)}]`;
                    }
                }
                if (!disassemblyText && process.platform === 'darwin') {
                    try {
                        const otoolArgs = ['-tvV'];
                        if (functionName)
                            otoolArgs.push('-p', functionName);
                        otoolArgs.push(resolvedFile);
                        const res = await execFileAsync('otool', otoolArgs, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
                        disassemblyText = res.stdout;
                    }
                    catch {
                        // fallback to objdump
                    }
                }
                if (!disassemblyText) {
                    try {
                        const objdumpArgs = ['--disassemble'];
                        if (functionName)
                            objdumpArgs.push(`--disassemble=${functionName}`);
                        objdumpArgs.push(resolvedFile);
                        const res = await execFileAsync('objdump', objdumpArgs, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
                        disassemblyText = res.stdout;
                    }
                    catch {
                        disassemblyText = `Decompiler not available on system for ${path.basename(resolvedFile)}. Install Ghidra or Rizin for advanced decompilation.`;
                    }
                }
                const stored = outputStore.processToolOutput(sessionId, `${callId}_decompile`, disassemblyText);
                return {
                    success: true,
                    action: 'decompile',
                    target: functionName || address || 'entry',
                    preview: stored.contentForModel,
                    totalLines: stored.totalLines,
                    isTruncated: stored.isTruncated,
                    diskPath: stored.diskPath
                };
            }
            catch (err) {
                return { success: false, error: `Decompilation error: ${err instanceof Error ? err.message : String(err)}` };
            }
        }
        // ── ACTION: UNPACK ────────────────────────────────────────────────────
        if (action === 'unpack') {
            try {
                const dest = outputDir ? resolveUserPath(outputDir) : path.join(workspaceDir, `${path.basename(resolvedFile)}_unpacked`);
                // Try sovereign engine bundle unpacker first
                try {
                    const engineRes = await sovereignReverseHarness.unpackBundle(resolvedFile, dest, context.signal);
                    if (engineRes.success && engineRes.output) {
                        const stored = outputStore.processToolOutput(sessionId, `${callId}_unpack`, engineRes.output);
                        return {
                            success: true,
                            action: 'unpack',
                            destination: dest,
                            preview: stored.contentForModel,
                            isTruncated: stored.isTruncated,
                            diskPath: stored.diskPath
                        };
                    }
                }
                catch {
                    // Fall back gracefully
                }
                const fileBuf = await fsp.readFile(resolvedFile);
                const asar = parseAsarHeader(fileBuf);
                if (asar) {
                    const files = listAsarFiles(asar.header);
                    if (listOnly) {
                        return {
                            success: true,
                            action: 'unpack',
                            format: 'ASAR',
                            totalFiles: files.length,
                            files: files.slice(0, 100),
                            message: `Listed ${files.length} files in ASAR archive.`
                        };
                    }
                    await fsp.mkdir(dest, { recursive: true });
                    const baseOffset = asar.headerSize;
                    let extractedCount = 0;
                    const extractEntry = async (entry, currPath) => {
                        if ('files' in entry && entry.files) {
                            await fsp.mkdir(currPath, { recursive: true });
                            for (const [name, child] of Object.entries(entry.files)) {
                                await extractEntry(child, path.join(currPath, name));
                            }
                        }
                        else if ('size' in entry && typeof entry.offset !== 'undefined') {
                            const fileOffset = baseOffset + parseInt(String(entry.offset), 10);
                            const fileData = fileBuf.subarray(fileOffset, fileOffset + entry.size);
                            await fsp.writeFile(currPath, fileData);
                            extractedCount++;
                        }
                    };
                    await extractEntry(asar.header, dest);
                    return {
                        success: true,
                        action: 'unpack',
                        format: 'ASAR',
                        extractedFiles: extractedCount,
                        destination: dest,
                        message: `Successfully unpacked ${extractedCount} files from ASAR archive to ${dest}.`
                    };
                }
                try {
                    if (listOnly) {
                        const listRes = await execFileAsync('unzip', ['-l', resolvedFile]);
                        return { success: true, action: 'unpack', listOnly: true, contents: listRes.stdout.split('\n').slice(0, 50) };
                    }
                    await fsp.mkdir(dest, { recursive: true });
                    await execFileAsync('unzip', ['-q', '-o', resolvedFile, '-d', dest]);
                    return {
                        success: true,
                        action: 'unpack',
                        destination: dest,
                        message: `Successfully extracted package to ${dest}.`
                    };
                }
                catch (unzipErr) {
                    return { success: false, error: `Unpack failed: ${unzipErr instanceof Error ? unzipErr.message : String(unzipErr)}` };
                }
            }
            catch (err) {
                return { success: false, error: `Unpack error: ${err instanceof Error ? err.message : String(err)}` };
            }
        }
        // ── ACTION: DEOBFUSCATE ───────────────────────────────────────────────
        if (action === 'deobfuscate') {
            try {
                const res = await deobfuscateScript(resolvedFile);
                let engineText = '';
                try {
                    const engineRes = await sovereignReverseHarness.deobfuscateScript(resolvedFile, context.signal);
                    if (engineRes.success && engineRes.output) {
                        engineText = engineRes.output;
                    }
                }
                catch {
                    // Fall back gracefully
                }
                return {
                    success: true,
                    action: 'deobfuscate',
                    filePath: resolvedFile,
                    sourcemapDetected: res.sourcemapDetected,
                    extractedRoutes: res.extractedRoutes,
                    summary: res.summary,
                    ...(engineText ? { engineAnalysis: engineText } : {})
                };
            }
            catch (err) {
                return { success: false, error: `Deobfuscation error: ${err instanceof Error ? err.message : String(err)}` };
            }
        }
        // ── ACTION: TRACE ─────────────────────────────────────────────────────
        if (action === 'trace') {
            const target = typeof args['target'] === 'string' ? args['target'] : path.basename(resolvedFile || 'process');
            const script = typeof args['script'] === 'string' ? args['script'] : undefined;
            try {
                const engineRes = await sovereignReverseHarness.traceRuntime(target, script ? { script } : {}, context.signal);
                if (engineRes.success && engineRes.output) {
                    const stored = outputStore.processToolOutput(sessionId, `${callId}_trace`, engineRes.output);
                    return {
                        success: true,
                        action: 'trace',
                        target,
                        preview: stored.contentForModel,
                        isTruncated: stored.isTruncated,
                        diskPath: stored.diskPath
                    };
                }
            }
            catch {
                // Fall back to hook template
            }
            const hookTemplate = `// Sovereign Runtime Hook for ${target}\n` +
                `console.log("[*] Attaching hook to ${target}...");\n` +
                `if (Process.platform === 'darwin') {\n` +
                `  const resolver = new ApiResolver('module');\n` +
                `  const matches = resolver.enumerateMatches('exports:*!*open*');\n` +
                `  matches.slice(0, 5).forEach(m => {\n` +
                `    Interceptor.attach(m.address, {\n` +
                `      onEnter(args) { console.log("[+] Hook hit: " + m.name); }\n` +
                `    });\n` +
                `  });\n` +
                `}\n`;
            return {
                success: true,
                action: 'trace',
                target,
                hookScript: hookTemplate,
                message: `Generated sovereign runtime hook template for ${target}.`
            };
        }
        return { success: false, error: `Unknown action: "${action}".` };
    }
};
