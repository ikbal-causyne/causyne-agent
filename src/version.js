import fs from 'fs';
import path from 'path';

function getDir() {
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }
  try {
    const metaUrl = typeof import.meta !== 'undefined' && import.meta.url ? import.meta.url : null;
    if (metaUrl && typeof metaUrl === 'string') {
      const url = new URL(metaUrl);
      if (url.protocol === 'file:') {
        return path.dirname(url.pathname);
      }
    }
  } catch (e) {}
  return process.cwd();
}

export function getPackageVersion() {
  try {
    const dir = getDir();
    const pkgPath = path.resolve(dir, '../package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg && typeof pkg.version === 'string' && pkg.version.trim()) {
        return pkg.version.trim();
      }
    }
  } catch (e) {}

  if (typeof __PACKAGE_VERSION__ !== 'undefined' && __PACKAGE_VERSION__ && __PACKAGE_VERSION__ !== '1.1.41') {
    return __PACKAGE_VERSION__;
  }

  return '1.3.14';
}

