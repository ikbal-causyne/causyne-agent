/**
 * Causyne Agent — skill file boundaries and progressive resource disclosure.
 *
 * Purely local, synchronous, bounded, cross-platform. The user-skill loader,
 * mutation API, and fs_read_skill all use this same security boundary.
 *
 * This is application-level containment, not a substitute for OS isolation.
 * No skill code is executed here.
 */
import fs from 'node:fs';
import path from 'node:path';
export const MAX_SKILL_RESOURCE_BYTES = 12 * 1024;
export const MAX_ADVERTISED_SKILL_RESOURCES = 12;
const SKILL_SEGMENT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESERVED_WINDOWS = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const RESOURCE_GROUPS = new Set(['references', 'templates', 'scripts', 'assets']);
const TEXT_EXTENSIONS = new Set([
    '.md', '.mdx', '.txt', '.json', '.yaml', '.yml', '.toml', '.sql',
    '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.sh', '.css', '.html',
    '.xml', '.csv', '.svg'
]);
function checkSkillSegment(segment) {
    if (!SKILL_SEGMENT.test(segment) || RESERVED_WINDOWS.test(segment)) {
        throw new Error(`Invalid skill path segment ${JSON.stringify(segment)}.`);
    }
}
function inspectDirectory(directory, allowMissing) {
    let stat;
    try {
        stat = fs.lstatSync(directory);
    }
    catch (error) {
        if (allowMissing && error?.code === 'ENOENT')
            return false;
        throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Skill directory is not a real directory: ${directory}`);
    }
    return true;
}
export function assertSkillFileSafe(filePath, allowMissing = false) {
    let stat;
    try {
        stat = fs.lstatSync(filePath);
    }
    catch (error) {
        if (allowMissing && error?.code === 'ENOENT')
            return;
        throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Skill file must be a regular file: ${filePath}`);
    }
}
function samePhysicalDirectory(a, b) {
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
/**
 * Write a regular skill file safely across both POSIX (O_NOFOLLOW) and Windows
 * (no O_NOFOLLOW): reject symlinks before opening, and never truncate until
 * lstatSync, fstatSync, and realpathSync confirm the descriptor is not a symlink
 * and resolves inside the skill directory.
 */
export function writeSkillFileSafely(root, domain, name, fileName, body, overwrite, useNoFollow = typeof fs.constants.O_NOFOLLOW === 'number' && fs.constants.O_NOFOLLOW !== 0) {
    if (typeof fileName !== 'string' || !fileName || path.isAbsolute(fileName) || /^[a-zA-Z]:/.test(fileName) || fileName.includes('\\')) {
        throw new Error(`Invalid skill file name: ${fileName}`);
    }
    const normalizedParts = fileName.split('/');
    for (const part of normalizedParts) {
        if (!part || part === '.' || part === '..' || RESERVED_WINDOWS.test(part) || RESERVED_WINDOWS.test(path.posix.parse(part).name)) {
            throw new Error(`Invalid or traversal segment in skill file name: ${JSON.stringify(part)}`);
        }
    }
    const directory = assertSkillTreeSafe(root, domain, name, true);
    fs.mkdirSync(directory, { recursive: true });
    assertSkillTreeSafe(root, domain, name);
    const file = path.join(directory, fileName);
    const resolvedDir = path.resolve(directory);
    const resolvedFile = path.resolve(file);
    if (resolvedFile !== resolvedDir && !resolvedFile.startsWith(`${resolvedDir}${path.sep}`)) {
        throw new Error(`Skill file escapes its directory: ${fileName}`);
    }
    assertSkillFileSafe(file, true);
    const nofollow = useNoFollow && typeof fs.constants.O_NOFOLLOW === 'number'
        ? fs.constants.O_NOFOLLOW
        : 0;
    if (nofollow !== 0) {
        const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | nofollow
            | (overwrite ? fs.constants.O_TRUNC : fs.constants.O_EXCL);
        const fd = fs.openSync(file, flags, 0o600);
        try {
            if (!fs.fstatSync(fd).isFile())
                throw new Error(`${fileName} must be a regular file`);
            const realDir = fs.realpathSync(directory);
            const realFile = fs.realpathSync(file);
            if (!samePhysicalDirectory(path.dirname(realFile), realDir)) {
                throw new Error(`${fileName} resolves outside its skill directory`);
            }
            fs.writeFileSync(fd, body, 'utf8');
        }
        finally {
            fs.closeSync(fd);
        }
        return file;
    }
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT
        | (overwrite ? 0 : fs.constants.O_EXCL);
    const fd = fs.openSync(file, flags, 0o600);
    try {
        assertSkillTreeSafe(root, domain, name);
        assertSkillFileSafe(file, false);
        const realDir = fs.realpathSync(directory);
        const realFile = fs.realpathSync(file);
        if (!samePhysicalDirectory(path.dirname(realFile), realDir)) {
            throw new Error(`${fileName} resolves outside its skill directory`);
        }
        if (!fs.fstatSync(fd).isFile())
            throw new Error(`${fileName} must be a regular file`);
        if (overwrite) {
            fs.ftruncateSync(fd, 0);
        }
        fs.writeFileSync(fd, body, 'utf8');
    }
    finally {
        fs.closeSync(fd);
    }
    return file;
}
/**
 * Check each directory segment. In particular, do not let a skill author
 * place a symlink at ~/.causyne/skills/<domain> or <name> and redirect writes
 * into an unrelated folder. `path.resolve()` alone does NOT provide this.
 */
export function assertSkillTreeSafe(root, domain, name, allowMissing = false) {
    checkSkillSegment(domain);
    checkSkillSegment(name);
    const base = path.resolve(root);
    const domainDir = path.join(base, domain);
    const skillDir = path.join(domainDir, name);
    if (!inspectDirectory(base, allowMissing))
        return skillDir;
    if (!inspectDirectory(domainDir, allowMissing))
        return skillDir;
    inspectDirectory(skillDir, allowMissing);
    return skillDir;
}
function checkRelativeResource(relativePath) {
    if (typeof relativePath !== 'string' || relativePath.length < 3 || relativePath.length > 240) {
        throw new Error('Skill resource path must be a short relative string.');
    }
    // The API uses portable POSIX-relative names, including on Windows.
    if (/^[A-Za-z]:/.test(relativePath) || relativePath.startsWith('/') ||
        relativePath.includes('\\') || /[\x00-\x1f\x7f<>"']/.test(relativePath)) {
        throw new Error('Absolute, Windows, or control-character resource paths are not permitted.');
    }
    const parts = relativePath.split('/');
    if (parts.length < 2 || parts.length > 5 || !RESOURCE_GROUPS.has(parts[0] ?? '')) {
        throw new Error('Use a relative file within references/, templates/, scripts/, or assets/.');
    }
    for (const segment of parts) {
        if (!segment || segment === '.' || segment === '..' || segment.startsWith('.')) {
            throw new Error('Hidden and traversal components are not permitted in skill resources.');
        }
        const baseName = path.posix.parse(segment).name;
        if (RESERVED_WINDOWS.test(segment) || RESERVED_WINDOWS.test(baseName)) {
            throw new Error(`Reserved device name ${JSON.stringify(segment)} is not permitted in skill resources.`);
        }
    }
    if (!TEXT_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase())) {
        throw new Error('Only text skill resources may be loaded into the model context.');
    }
    return parts;
}
/**
 * Read one supporting text document without touching unrelated files.
 * Rejects symlinks in every path component, large files, invalid UTF-8 and
 * binary content. Note: a concurrently hostile local process can still race
 * parent-directory replacement; the agent's OS sandbox is the final boundary.
 */
export function readSkillTextResource(root, domain, name, relativePath) {
    const components = checkRelativeResource(relativePath);
    const skillDir = assertSkillTreeSafe(root, domain, name);
    let cursor = skillDir;
    for (const component of components.slice(0, -1)) {
        cursor = path.join(cursor, component);
        inspectDirectory(cursor, false);
    }
    const target = path.join(cursor, components[components.length - 1]);
    assertSkillFileSafe(target, false);
    const physicalRoot = fs.realpathSync(skillDir);
    const physicalFile = fs.realpathSync(target);
    if (!physicalFile.startsWith(`${physicalRoot}${path.sep}`)) {
        throw new Error('Skill resource escapes its own directory.');
    }
    const nofollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    const fd = fs.openSync(target, fs.constants.O_RDONLY | nofollow);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile())
            throw new Error('Skill resource must be a regular file.');
        if (stat.size > MAX_SKILL_RESOURCE_BYTES) {
            throw new Error(`Skill resource exceeds ${MAX_SKILL_RESOURCE_BYTES} bytes.`);
        }
        const chunks = [];
        let bytes = 0;
        while (bytes <= MAX_SKILL_RESOURCE_BYTES) {
            const remaining = MAX_SKILL_RESOURCE_BYTES + 1 - bytes;
            const buffer = Buffer.alloc(Math.min(8192, remaining));
            const count = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (count === 0)
                break;
            chunks.push(buffer.subarray(0, count));
            bytes += count;
        }
        if (bytes > MAX_SKILL_RESOURCE_BYTES)
            throw new Error('Skill resource grew beyond size limit.');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        if (text.includes('\0'))
            throw new Error('Binary skill resource is not valid model context.');
        // Terminal control bytes are not useful skill instructions.
        return text.replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    }
    finally {
        fs.closeSync(fd);
    }
}
/**
 * Offer a bounded, deterministic list of resource names, not their bodies.
 * Never follow symlinked support directories or files.
 */
export function listSkillResourcePaths(root, domain, name, limit = MAX_ADVERTISED_SKILL_RESOURCES) {
    let skillDir;
    try {
        skillDir = assertSkillTreeSafe(root, domain, name, true);
        if (!fs.existsSync(skillDir))
            return [];
    }
    catch {
        return [];
    }
    const out = [];
    const bound = Number.isInteger(limit)
        ? Math.max(0, Math.min(limit, MAX_ADVERTISED_SKILL_RESOURCES)) : MAX_ADVERTISED_SKILL_RESOURCES;
    const walk = (relative, depth) => {
        if (out.length >= bound || depth > 3)
            return;
        const directory = path.join(skillDir, ...relative.split('/'));
        if (!inspectDirectory(directory, true))
            return;
        const entries = fs.readdirSync(directory, { withFileTypes: true })
            .filter(item => !item.name.startsWith('.'))
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, 128);
        for (const entry of entries) {
            if (out.length >= bound)
                break;
            if (entry.isSymbolicLink())
                continue;
            const next = `${relative}/${entry.name}`;
            if (entry.isDirectory())
                walk(next, depth + 1);
            else if (entry.isFile() && TEXT_EXTENSIONS.has(path.posix.extname(next).toLowerCase())) {
                const stat = fs.lstatSync(path.join(directory, entry.name));
                if (stat.size <= MAX_SKILL_RESOURCE_BYTES && !stat.isSymbolicLink())
                    out.push(next);
            }
        }
    };
    if (bound === 0)
        return out;
    for (const group of RESOURCE_GROUPS)
        walk(group, 1);
    return out;
}
