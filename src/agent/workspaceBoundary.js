/**
 * Resolve the nearest existing ancestor before checking workspace containment.
 *
 * `path.resolve()` only removes lexical `..`; it does not follow symlinks. An
 * allowed path like `<workspace>/linked/outside.txt` might actually write to an
 * unrelated directory. This helper follows every *existing* path component,
 * including symlinked directory ancestors, before evaluating the boundary.
 *
 * The final path is permitted to be absent (needed for fs_write / mkdir).
 * A dangling symlink, inaccessible ancestor, or symlink cycle is denied.
 * This protects the central path policy; it is not an OS sandbox and cannot
 * eliminate TOCTOU races if an external actor retargets a link during I/O.
 */
import fs from 'node:fs';
import path from 'node:path';
function errorCode(value) {
    return typeof value === 'object' && value !== null && 'code' in value
        ? String(value.code) : undefined;
}
export function physicalPath(target) {
    if (typeof target !== 'string' || target.length === 0)
        return null;
    let candidate = path.resolve(target);
    const missing = [];
    for (let depth = 0; depth < 1024; depth++) {
        try {
            fs.lstatSync(candidate); // lstat also sees dangling symlinks.
        }
        catch (error) {
            if (errorCode(error) !== 'ENOENT')
                return null;
            const parent = path.dirname(candidate);
            if (parent === candidate)
                return null;
            missing.unshift(path.basename(candidate));
            candidate = parent;
            continue;
        }
        try {
            const resolved = fs.realpathSync.native(candidate);
            return path.resolve(resolved, ...missing);
        }
        catch {
            return null; // dangling link, inaccessible target, or symlink loop
        }
    }
    return null;
}
function normalizeCompare(value) {
    return process.platform === 'win32' ? value.toLowerCase() : value;
}
export function isWithinPhysicalPath(child, parent) {
    const relative = path.relative(normalizeCompare(parent), normalizeCompare(child));
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
/** The current Sandbox OS hard-deny list, applied to physical paths as well. */
export function isProtectedPhysicalPath(target) {
    if (process.platform === 'darwin') {
        if (isWithinPhysicalPath(target, '/private/var/folders') || isWithinPhysicalPath(target, '/private/var/tmp') || isWithinPhysicalPath(target, '/tmp')) {
            return false;
        }
    }
    const blocked = process.platform === 'win32'
        ? ['C:\\Windows', 'C:\\Program Files', 'C:\\ProgramData']
        : ['/etc', '/private/etc', '/usr/bin', '/usr/sbin', '/sbin', '/bin', '/System', '/private/var'];
    return blocked.some(root => isWithinPhysicalPath(target, root));
}
export function isPhysicalPathAllowed(target, workspaces, grantAllAccess = false) {
    const realTarget = physicalPath(target);
    if (!realTarget || isProtectedPhysicalPath(path.resolve(target)) || isProtectedPhysicalPath(realTarget)) {
        return false;
    }
    if (grantAllAccess)
        return true;
    return workspaces.some(root => {
        const realRoot = physicalPath(root);
        return realRoot !== null && isWithinPhysicalPath(realTarget, realRoot);
    });
}
