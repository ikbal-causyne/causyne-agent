import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MIME: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4'
};
const within = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

/** Serve approved workspace assets through browser interception, without a listening port. */
export class WorkspacePreview {
  private readonly roots = new Map<string, string>();

  clear(): void { this.roots.clear(); }

  async open(workspace: string, file: string): Promise<string> {
    const root = await fs.realpath(workspace);
    const target = await fs.realpath(path.resolve(root, file));
    if (!within(root, target) || !/\.html?$/i.test(target)) throw new Error('Preview requires an HTML file inside the selected workspace');
    const origin = `https://${randomUUID()}.causyne-preview.invalid`;
    this.roots.set(origin, path.dirname(target));
    return `${origin}/${encodeURIComponent(path.basename(target))}`;
  }

  async response(rawUrl: string): Promise<{ status: number; contentType: string; body: Buffer } | null> {
    const url = new URL(rawUrl);
    const root = this.roots.get(url.origin);
    if (!root) return null;
    const deny = { status: 403, contentType: 'text/plain', body: Buffer.from('Preview asset is outside the allowed scope') };
    try {
      const parts = decodeURIComponent(url.pathname).replace(/\\/g, '/').split('/').filter(Boolean);
      if (parts.some(part => part.startsWith('.') || /^(credentials|secrets?|id_rsa|id_ed25519)(\.|$)/i.test(part))) return deny;
      const file = await fs.realpath(path.resolve(root, ...parts));
      const contentType = MIME[path.extname(file).toLowerCase()];
      if (!within(root, file) || !contentType) return deny;
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 25 * 1024 * 1024) return deny;
      return { status: 200, contentType, body: await fs.readFile(file) };
    } catch { return { ...deny, status: 404 }; }
  }
}
