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
import zlib from 'node:zlib';
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
// DALVIK EXECUTABLE (DEX) ZERO-DEPENDENCY PARSER
// ─────────────────────────────────────────────────────────────────────────────
function parseDex(buffer) {
    if (buffer.length < 112)
        return { format: 'DEX' };
    const magic = buffer.toString('utf8', 0, 8);
    if (!magic.startsWith('dex\n'))
        return { format: 'DEX' };
    const endianTag = buffer.readUInt32LE(40);
    const isLe = endianTag === 0x12345678;
    const readU32 = (off) => isLe ? buffer.readUInt32LE(off) : buffer.readUInt32BE(off);
    const fileSize = readU32(32);
    const headerSize = readU32(36);
    const stringIdsSize = readU32(56);
    const typeIdsSize = readU32(64);
    const protoIdsSize = readU32(72);
    const fieldIdsSize = readU32(80);
    const methodIdsSize = readU32(88);
    const classDefsSize = readU32(96);
    return {
        format: 'DEX',
        architecture: 'Dalvik / ART Bytecode',
        is64Bit: false,
        byteOrder: isLe ? 'little-endian' : 'big-endian',
        fileType: 'Dalvik Executable (DEX)',
        metadata: {
            dexMagic: magic.trim(),
            fileSize,
            headerSize,
            classDefinitionsCount: classDefsSize,
            methodIdsCount: methodIdsSize,
            fieldIdsCount: fieldIdsSize,
            typeIdsCount: typeIdsSize,
            stringIdsCount: stringIdsSize
        }
    };
}
// ─────────────────────────────────────────────────────────────────────────────
// ANDROID SDK AAPT DISCOVERY & BADGING PARSER
// ─────────────────────────────────────────────────────────────────────────────
function findAaptExecutable() {
    const home = process.env.HOME || '';
    const searchDirs = [
        path.join(home, 'Library/Android/sdk/build-tools'),
        path.join(home, 'Android/Sdk/build-tools'),
        '/opt/android-sdk/build-tools'
    ];
    if (process.env.ANDROID_HOME) {
        searchDirs.unshift(path.join(process.env.ANDROID_HOME, 'build-tools'));
    }
    if (process.env.ANDROID_SDK_ROOT) {
        searchDirs.unshift(path.join(process.env.ANDROID_SDK_ROOT, 'build-tools'));
    }
    for (const dir of searchDirs) {
        if (fs.existsSync(dir)) {
            try {
                const versions = fs.readdirSync(dir).sort().reverse();
                for (const v of versions) {
                    const aaptPath = path.join(dir, v, 'aapt');
                    if (fs.existsSync(aaptPath))
                        return aaptPath;
                    const aapt2Path = path.join(dir, v, 'aapt2');
                    if (fs.existsSync(aapt2Path))
                        return aapt2Path;
                }
            }
            catch {
                // safe continuation
            }
        }
    }
    return null;
}
async function parseApkBadging(aaptPath, apkPath) {
    try {
        const res = await execFileAsync(aaptPath, ['dump', 'badging', apkPath], {
            timeout: 20000,
            maxBuffer: 25 * 1024 * 1024
        });
        const stdout = res.stdout;
        const pkgMatch = stdout.match(/package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/);
        const sdkMatch = stdout.match(/sdkVersion:'([^']+)'/);
        const targetSdkMatch = stdout.match(/targetSdkVersion:'([^']+)'/);
        const labelMatch = stdout.match(/application-label:'([^']+)'/);
        const launchMatch = stdout.match(/launchable-activity: name='([^']+)'/);
        const permissions = [...stdout.matchAll(/uses-permission: name='([^']+)'/g)].map(m => m[1]);
        const nativeCodes = [...stdout.matchAll(/native-code: '([^']+)'/g)].map(m => m[1]);
        const features = [...stdout.matchAll(/uses-feature: name='([^']+)'/g)].map(m => m[1]);
        return {
            packageName: pkgMatch?.[1],
            versionCode: pkgMatch?.[2],
            versionName: pkgMatch?.[3],
            minSdkVersion: sdkMatch?.[1],
            targetSdkVersion: targetSdkMatch?.[1],
            applicationLabel: labelMatch?.[1],
            launchableActivity: launchMatch?.[1],
            nativeArchitectures: nativeCodes.length > 0 ? nativeCodes : undefined,
            permissionsCount: permissions.length,
            permissions: permissions.slice(0, 100),
            featuresCount: features.length,
            features: features.slice(0, 30)
        };
    }
    catch {
        return null;
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// BINARY XML (AXML) STRING POOL & COMPONENT EXTRACTOR
// ─────────────────────────────────────────────────────────────────────────────
function parseAxmlStrings(buf) {
    if (buf.length < 36)
        return [];
    const chunkType = buf.readUInt16LE(8);
    if (chunkType !== 0x0001)
        return []; // RES_STRING_POOL_TYPE
    const stringCount = buf.readUInt32LE(16);
    const flags = buf.readUInt32LE(24);
    const isUtf8 = (flags & (1 << 8)) !== 0;
    const stringsStart = 8 + buf.readUInt32LE(28);
    const strings = [];
    for (let i = 0; i < stringCount; i++) {
        const offPos = 36 + i * 4;
        if (offPos + 4 > buf.length)
            break;
        const strOffset = stringsStart + buf.readUInt32LE(offPos);
        if (strOffset >= buf.length)
            continue;
        try {
            if (isUtf8) {
                let off = strOffset;
                const b0 = buf[off];
                if (b0 === undefined)
                    continue;
                if ((b0 & 0x80) !== 0)
                    off += 2;
                else
                    off += 1;
                if (off >= buf.length)
                    continue;
                const b1 = buf[off];
                if (b1 === undefined)
                    continue;
                let byteLen = b1;
                if ((byteLen & 0x80) !== 0) {
                    const b2 = buf[off + 1];
                    if (b2 === undefined)
                        continue;
                    byteLen = ((byteLen & 0x7f) << 8) | b2;
                    off += 2;
                }
                else {
                    off += 1;
                }
                if (off + byteLen <= buf.length) {
                    strings.push(buf.toString('utf8', off, off + byteLen));
                }
            }
            else {
                let off = strOffset;
                let len = buf.readUInt16LE(off);
                if ((len & 0x8000) !== 0) {
                    len = ((len & 0x7fff) << 16) | buf.readUInt16LE(off + 2);
                    off += 4;
                }
                else {
                    off += 2;
                }
                if (off + len * 2 <= buf.length) {
                    strings.push(buf.toString('utf16le', off, off + len * 2));
                }
            }
        }
        catch {
            // safe ignore individual string decode error
        }
    }
    return strings;
}
async function inspectApkZipAndManifest(apkPath) {
    let fd = null;
    try {
        const stat = await fsp.stat(apkPath);
        fd = await fsp.open(apkPath, 'r');
        const endSize = Math.min(65536, stat.size);
        const endBuf = Buffer.alloc(endSize);
        await fd.read(endBuf, 0, endSize, stat.size - endSize);
        let eocdOffset = -1;
        for (let i = endBuf.length - 22; i >= 0; i--) {
            if (endBuf.readUInt32LE(i) === 0x06054b50) {
                eocdOffset = stat.size - endSize + i;
                break;
            }
        }
        if (eocdOffset === -1) {
            return { format: 'APK/ZIP', fileType: 'Android Application Package (APK)' };
        }
        const cdSize = endBuf.readUInt32LE(eocdOffset - (stat.size - endSize) + 12);
        const cdOffset = endBuf.readUInt32LE(eocdOffset - (stat.size - endSize) + 16);
        const cdBuf = Buffer.alloc(cdSize);
        await fd.read(cdBuf, 0, cdSize, cdOffset);
        let ptr = 0;
        let manifestEntry = null;
        const dexFiles = [];
        let totalDexUncompressed = 0;
        const nativeLibs = [];
        const abis = new Set();
        const frameworks = new Set();
        while (ptr + 46 <= cdBuf.length) {
            if (cdBuf.readUInt32LE(ptr) !== 0x02014b50)
                break;
            const method = cdBuf.readUInt16LE(ptr + 10);
            const compSize = cdBuf.readUInt32LE(ptr + 20);
            const uncompSize = cdBuf.readUInt32LE(ptr + 24);
            const nameLen = cdBuf.readUInt16LE(ptr + 28);
            const extraLen = cdBuf.readUInt16LE(ptr + 30);
            const commentLen = cdBuf.readUInt16LE(ptr + 32);
            const localHeaderOffset = cdBuf.readUInt32LE(ptr + 42);
            const name = cdBuf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
            if (name === 'AndroidManifest.xml') {
                manifestEntry = { name, method, compSize, uncompSize, localHeaderOffset };
            }
            else if (name.endsWith('.dex')) {
                dexFiles.push(name);
                totalDexUncompressed += uncompSize;
            }
            else if (name.startsWith('lib/')) {
                nativeLibs.push(name);
                const parts = name.split('/');
                const abiName = parts[1];
                if (parts.length > 2 && abiName)
                    abis.add(abiName);
                if (name.includes('libflutter.so') || name.includes('libapp.so'))
                    frameworks.add('Flutter');
                if (name.includes('libreactnativejni.so') || name.includes('libhermes.so'))
                    frameworks.add('React Native');
                if (name.includes('libunity.so'))
                    frameworks.add('Unity');
                if (name.includes('libkwopdf.so') || name.includes('libksoedit.so'))
                    frameworks.add('Kingsoft Office Native C++ Engine');
                if (name.includes('libUE4.so') || name.includes('libUnreal.so'))
                    frameworks.add('Unreal Engine');
                if (name.includes('libcocos2djs.so'))
                    frameworks.add('Cocos2d-x');
            }
            ptr += 46 + nameLen + extraLen + commentLen;
        }
        let manifestStrings = [];
        if (manifestEntry) {
            const localHdr = Buffer.alloc(30);
            await fd.read(localHdr, 0, 30, manifestEntry.localHeaderOffset);
            const fnLen = localHdr.readUInt16LE(26);
            const extraLen = localHdr.readUInt16LE(28);
            const dataOffset = manifestEntry.localHeaderOffset + 30 + fnLen + extraLen;
            const compData = Buffer.alloc(manifestEntry.compSize);
            await fd.read(compData, 0, manifestEntry.compSize, dataOffset);
            const xmlBuf = manifestEntry.method === 8 ? zlib.inflateRawSync(compData) : compData;
            manifestStrings = parseAxmlStrings(xmlBuf);
        }
        const permissions = manifestStrings.filter(s => s.includes('permission.') || s.startsWith('android.permission'));
        const activities = manifestStrings.filter(s => s.endsWith('Activity') || s.includes('Activity$'));
        const services = manifestStrings.filter(s => s.endsWith('Service') || s.includes('Service$') || s.startsWith(':'));
        const receivers = manifestStrings.filter(s => s.endsWith('Receiver') || s.includes('Receiver$'));
        const providers = manifestStrings.filter(s => s.endsWith('Provider') || s.includes('Provider$'));
        // Discover package name candidate from strings
        const pkgCandidate = manifestStrings.find(s => s.includes('.') && !s.includes('/') && !s.startsWith('android.') && !s.startsWith('androidx.') && s.split('.').length >= 3 && !s.includes('Activity') && !s.includes('Service'));
        const primaryAbi = Array.from(abis)[0] || 'arm64-v8a';
        let badging = null;
        const aaptPath = findAaptExecutable();
        if (aaptPath) {
            badging = await parseApkBadging(aaptPath, apkPath);
        }
        const metadata = {
            packageName: badging?.packageName || pkgCandidate,
            versionCode: badging?.versionCode,
            versionName: badging?.versionName,
            minSdkVersion: badging?.minSdkVersion,
            targetSdkVersion: badging?.targetSdkVersion,
            applicationLabel: badging?.applicationLabel,
            launchableActivity: badging?.launchableActivity,
            dexFileCount: dexFiles.length,
            dexFiles: dexFiles.slice(0, 15),
            totalDexSizeMb: (totalDexUncompressed / (1024 * 1024)).toFixed(1),
            nativeArchitectures: badging?.nativeArchitectures || Array.from(abis),
            nativeLibraryCount: nativeLibs.length,
            sampleNativeLibraries: nativeLibs.slice(0, 10),
            detectedFrameworks: Array.from(frameworks),
            permissionsCount: badging?.permissionsCount || permissions.length,
            permissions: badging?.permissions || permissions.slice(0, 50),
            activitiesCount: activities.length,
            sampleActivities: activities.slice(0, 10),
            servicesCount: services.length,
            sampleServices: services.slice(0, 10),
            receiversCount: receivers.length,
            providersCount: providers.length
        };
        return {
            format: 'APK/ZIP',
            architecture: primaryAbi,
            is64Bit: primaryAbi.includes('64'),
            byteOrder: 'little-endian',
            fileType: 'Android Application Package (APK)',
            metadata
        };
    }
    finally {
        if (fd)
            await fd.close();
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// SEARCH CLASSES DIRECTLY IN APK DEX & MANIFEST
// ─────────────────────────────────────────────────────────────────────────────
async function searchClassesInApk(apkPath, query) {
    let fd = null;
    const matches = new Set();
    let totalInspected = 0;
    const qLower = query.toLowerCase();
    try {
        const stat = await fsp.stat(apkPath);
        fd = await fsp.open(apkPath, 'r');
        const endSize = Math.min(65536, stat.size);
        const endBuf = Buffer.alloc(endSize);
        await fd.read(endBuf, 0, endSize, stat.size - endSize);
        let eocdOffset = -1;
        for (let i = endBuf.length - 22; i >= 0; i--) {
            if (endBuf.readUInt32LE(i) === 0x06054b50) {
                eocdOffset = stat.size - endSize + i;
                break;
            }
        }
        if (eocdOffset === -1)
            return { matchedClasses: [], totalInspected: 0 };
        const cdSize = endBuf.readUInt32LE(eocdOffset - (stat.size - endSize) + 12);
        const cdOffset = endBuf.readUInt32LE(eocdOffset - (stat.size - endSize) + 16);
        const cdBuf = Buffer.alloc(cdSize);
        await fd.read(cdBuf, 0, cdSize, cdOffset);
        let ptr = 0;
        const dexEntries = [];
        while (ptr + 46 <= cdBuf.length) {
            if (cdBuf.readUInt32LE(ptr) !== 0x02014b50)
                break;
            const method = cdBuf.readUInt16LE(ptr + 10);
            const compSize = cdBuf.readUInt32LE(ptr + 20);
            const uncompSize = cdBuf.readUInt32LE(ptr + 24);
            const nameLen = cdBuf.readUInt16LE(ptr + 28);
            const extraLen = cdBuf.readUInt16LE(ptr + 30);
            const commentLen = cdBuf.readUInt16LE(ptr + 32);
            const localHeaderOffset = cdBuf.readUInt32LE(ptr + 42);
            const name = cdBuf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
            if (name.endsWith('.dex')) {
                dexEntries.push({ name, method, compSize, uncompSize, localHeaderOffset });
            }
            ptr += 46 + nameLen + extraLen + commentLen;
        }
        for (const dexEntry of dexEntries.slice(0, 5)) {
            try {
                const localHdr = Buffer.alloc(30);
                await fd.read(localHdr, 0, 30, dexEntry.localHeaderOffset);
                const fnLen = localHdr.readUInt16LE(26);
                const extraLen = localHdr.readUInt16LE(28);
                const dataOffset = dexEntry.localHeaderOffset + 30 + fnLen + extraLen;
                const compData = Buffer.alloc(dexEntry.compSize);
                await fd.read(compData, 0, dexEntry.compSize, dataOffset);
                const dexBuf = dexEntry.method === 8 ? zlib.inflateRawSync(compData) : compData;
                if (dexBuf.length >= 112 && dexBuf.toString('utf8', 0, 4) === 'dex\n') {
                    const stringIdsOff = dexBuf.readUInt32LE(60);
                    const typeIdsOff = dexBuf.readUInt32LE(68);
                    const classDefsSize = dexBuf.readUInt32LE(96);
                    const classDefsOff = dexBuf.readUInt32LE(100);
                    totalInspected += classDefsSize;
                    for (let i = 0; i < classDefsSize; i++) {
                        const classDefOffset = classDefsOff + i * 32;
                        if (classDefOffset + 4 > dexBuf.length)
                            break;
                        const classIdx = dexBuf.readUInt32LE(classDefOffset);
                        const typeOff = typeIdsOff + classIdx * 4;
                        if (typeOff + 4 > dexBuf.length)
                            continue;
                        const descriptorIdx = dexBuf.readUInt32LE(typeOff);
                        const strOffPos = stringIdsOff + descriptorIdx * 4;
                        if (strOffPos + 4 > dexBuf.length)
                            continue;
                        const stringDataOff = dexBuf.readUInt32LE(strOffPos);
                        let off = stringDataOff;
                        while (off < dexBuf.length) {
                            const b = dexBuf[off];
                            if (b === undefined || (b & 0x80) === 0)
                                break;
                            off++;
                        }
                        off++;
                        let end = off;
                        while (end < dexBuf.length && dexBuf[end] !== 0)
                            end++;
                        const rawDesc = dexBuf.toString('utf8', off, end);
                        if (!qLower || rawDesc.toLowerCase().includes(qLower)) {
                            const cleanName = rawDesc.replace(/^L/, '').replace(/;$/, '').replace(/\//g, '.');
                            matches.add(cleanName);
                            if (matches.size >= 100)
                                break;
                        }
                    }
                }
            }
            catch {
                // continue
            }
            if (matches.size >= 100)
                break;
        }
    }
    finally {
        if (fd)
            await fd.close();
    }
    return {
        matchedClasses: Array.from(matches),
        totalInspected
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
                    enum: ['inspect', 'decompile', 'unpack', 'deobfuscate', 'trace', 'status', 'engine_tool', 'list_tools', 'decode_resources', 'search_classes', 'graph'],
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
                },
                query: {
                    type: 'string',
                    description: 'Class, method, or string search query for reverse engineering.'
                }
            },
            required: ['action']
        }
    },
    async execute(args, context = {}) {
        const rawPath = typeof args['filePath'] === 'string' ? args['filePath']
            : typeof args['file'] === 'string' ? args['file']
                : typeof args['path'] === 'string' ? args['path']
                    : typeof args['apk'] === 'string' ? args['apk']
                        : typeof args['binary'] === 'string' ? args['binary']
                            : (typeof args['target'] === 'string' && args['action'] !== 'trace' ? args['target'] : undefined);
        let rawAction = typeof args['action'] === 'string' ? args['action']
            : typeof args['operation'] === 'string' ? args['operation']
                : typeof args['mode'] === 'string' ? args['mode']
                    : '';
        if (!rawAction && (typeof args['toolName'] === 'string' || typeof args['engineTool'] === 'string')) {
            rawAction = 'engine_tool';
        }
        if (['analyze', 'info', 'check', 'probe', 'inspect_package'].includes(rawAction))
            rawAction = 'inspect';
        if (['disassemble', 'disasm'].includes(rawAction))
            rawAction = 'decompile';
        if (['decode_resources', 'resources', 'decode'].includes(rawAction))
            rawAction = 'decode_resources';
        if (['search_classes', 'classes'].includes(rawAction))
            rawAction = 'search_classes';
        if (['graph', 'application_graph'].includes(rawAction))
            rawAction = 'graph';
        const action = (rawAction || (rawPath ? 'inspect' : 'status'));
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
                    'Headless MCP engine with 170+ specialized reverse engineering tools',
                    'Android APK resource decoding, class hierarchy & graph projection'
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
            const toolName = typeof args['toolName'] === 'string' ? args['toolName'] : typeof args['engineTool'] === 'string' ? args['engineTool'] : '';
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
        // Require filePath for inspect, decompile, unpack, deobfuscate, decode_resources, search_classes, graph
        if (!rawPath && action !== 'trace') {
            return { success: false, error: `Action "${action}" requires a valid "filePath" parameter.` };
        }
        const resolvedFile = rawPath ? resolveUserPath(rawPath) : '';
        if (resolvedFile && !fs.existsSync(resolvedFile)) {
            return { success: false, error: `File not found: ${resolvedFile}` };
        }
        // ── ACTION: DECODE_RESOURCES ──────────────────────────────────────────
        if (action === 'decode_resources') {
            let res = await sovereignReverseHarness.decodeAndroidResources(resolvedFile, outputDir, context.signal);
            let textOutput = '';
            if (res.success && res.output && !res.output.includes('apktool launcher was not found')) {
                textOutput = res.output;
            }
            else {
                const targetDir = outputDir ? resolveUserPath(outputDir) : path.join(workspaceDir, `${path.basename(resolvedFile)}_resources`);
                await fsp.mkdir(targetDir, { recursive: true });
                const apkInfo = await inspectApkZipAndManifest(resolvedFile);
                const manifestSummaryPath = path.join(targetDir, 'manifest_summary.json');
                await fsp.writeFile(manifestSummaryPath, JSON.stringify(apkInfo.metadata || {}, null, 2), 'utf8');
                textOutput = `Extracted Android package architecture to ${targetDir}:\n- Manifest summary: ${manifestSummaryPath}\n- Package: ${apkInfo.metadata?.packageName || 'unknown'}\n- Activities: ${apkInfo.metadata?.activitiesCount || 0}\n- Services: ${apkInfo.metadata?.servicesCount || 0}\n- Permissions: ${apkInfo.metadata?.permissionsCount || 0}`;
                res = { success: true, toolName: 'decode_resources', output: textOutput, source: 'fallback' };
            }
            const stored = outputStore.processToolOutput(sessionId, `${callId}_decode_resources`, textOutput);
            return {
                success: res.success,
                action: 'decode_resources',
                filePath: resolvedFile,
                preview: stored.contentForModel,
                isTruncated: stored.isTruncated,
                diskPath: stored.diskPath,
                error: res.error
            };
        }
        // ── ACTION: SEARCH_CLASSES ───────────────────────────────────────────
        if (action === 'search_classes') {
            const query = String(args['query'] || '');
            let res = await sovereignReverseHarness.searchAndroidClasses(resolvedFile, query, context.signal);
            let textOutput = '';
            if (res.success && res.output && !res.output.includes('capability_unavailable') && !res.output.includes('REA_JADX_MCP_JAR')) {
                textOutput = res.output;
            }
            else {
                const nativeSearch = await searchClassesInApk(resolvedFile, query);
                textOutput = JSON.stringify({
                    query,
                    totalInspectedDexClasses: nativeSearch.totalInspected,
                    matchedClassesCount: nativeSearch.matchedClasses.length,
                    matchedClasses: nativeSearch.matchedClasses
                }, null, 2);
                res = { success: true, toolName: 'search_classes', output: textOutput, source: 'fallback' };
            }
            const stored = outputStore.processToolOutput(sessionId, `${callId}_search_classes`, textOutput);
            return {
                success: res.success,
                action: 'search_classes',
                filePath: resolvedFile,
                query,
                preview: stored.contentForModel,
                isTruncated: stored.isTruncated,
                diskPath: stored.diskPath,
                error: res.error
            };
        }
        // ── ACTION: GRAPH ─────────────────────────────────────────────────────
        if (action === 'graph') {
            const res = await sovereignReverseHarness.projectAndroidGraph(resolvedFile, context.signal);
            const textOutput = res.output || (res.structuredContent ? JSON.stringify(res.structuredContent, null, 2) : res.error || '');
            const stored = outputStore.processToolOutput(sessionId, `${callId}_graph`, textOutput);
            return {
                success: res.success,
                action: 'graph',
                filePath: resolvedFile,
                preview: stored.contentForModel,
                isTruncated: stored.isTruncated,
                diskPath: stored.diskPath,
                error: res.error
            };
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
                const isDex = (headerBuf.length >= 4 && headerBuf[0] === 0x64 && headerBuf[1] === 0x65 && headerBuf[2] === 0x78 && headerBuf[3] === 0x0a)
                    || resolvedFile.toLowerCase().endsWith('.dex');
                const isApkOrZip = (headerBuf.length >= 4 && headerBuf[0] === 0x50 && headerBuf[1] === 0x4b && headerBuf[2] === 0x03 && headerBuf[3] === 0x04)
                    || resolvedFile.toLowerCase().endsWith('.apk')
                    || resolvedFile.toLowerCase().endsWith('.aab');
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
                else if (isDex) {
                    result = { ...result, ...parseDex(headerBuf) };
                }
                else if (isApkOrZip) {
                    const apkResult = await inspectApkZipAndManifest(resolvedFile);
                    result = { ...result, ...apkResult };
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
                    metadata: result.metadata,
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
