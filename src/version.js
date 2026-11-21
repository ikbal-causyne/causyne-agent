import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
function getDir() {
    try {
        const metaUrl = typeof import.meta !== 'undefined' && import.meta.url ? import.meta.url : null;
        if (metaUrl && typeof metaUrl === 'string') {
            const url = new URL(metaUrl);
            if (url.protocol === 'file:') {
                return path.dirname(fileURLToPath(url));
            }
        }
    }
    catch {
        // fallback to cwd below
    }
    return process.cwd();
}
export function getPackageVersion() {
    try {
        const dir = getDir();
        const pkgPath = path.resolve(dir, '../package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            if (pkg && typeof pkg === 'object' && 'version' in pkg) {
                const version = pkg.version;
                if (typeof version === 'string' && version.trim()) {
                    return version.trim();
                }
            }
        }
    }
    catch {
        // fallback below
    }
    const injected = globalThis.__PACKAGE_VERSION__;
    if (typeof injected === 'string' && injected && injected !== '1.1.41') {
        return injected;
    }
    return '1.3.14';
}
