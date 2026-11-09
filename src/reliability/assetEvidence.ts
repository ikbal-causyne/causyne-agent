import fs from 'node:fs/promises';
import path from 'node:path';

export interface ImageAssetCheck {
  readonly ok: boolean;
  readonly required: boolean;
  readonly reason?: string;
  readonly checkedReferences?: number;
  readonly validImages?: number;
}

export interface InspectImageAssetsInput {
  prompt: string;
  workspaceRoot: string;
  webArtifacts: string[];
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

function imageRequirement(prompt: string): boolean {
  const text = String(prompt || '').toLowerCase();
  const isImageTask = /\b(real|actual|authentic|stock|travel)\b.{0,45}\b(images?|photos?|pictures?)\b|\b(images?|photos?|pictures?)\b.{0,45}\b(real|actual|authentic)\b/i.test(text);
  const asksForAcquisition = /\b(download(?:ed|ing|s)?|fetch(?:ed|ing)?|grab(?:bed|bing)?|source(?:d|s)?|search(?:ing)?|online|from the web|web grab)\b|osnwload|downlaod/i.test(text);
  return isImageTask && asksForAcquisition;
}

function extractImageReferences(text: string): string[] {
  const references = new Set<string>();
  // Prefer evidence from actual HTML/CSS references over files merely present
  // somewhere in a workspace. Remote URLs are not downloaded image assets.
  for (const match of String(text).matchAll(/\b(?:src|poster)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    const ref = (match[1] || match[2] || '').trim();
    if (/\.(?:png|jpe?g|webp|gif|avif|bmp|svg)(?:[?#].*)?$/i.test(ref)) references.add(ref);
  }
  return [...references];
}

function magicImage(buffer: Buffer | undefined, extension: string): boolean {
  if (!buffer?.length) return false;
  switch (extension) {
    case '.jpg': case '.jpeg': return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case '.png': return buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    case '.gif': return buffer.subarray(0, 6).toString('ascii') === 'GIF89a' || buffer.subarray(0, 6).toString('ascii') === 'GIF87a';
    case '.webp': return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    case '.bmp': return buffer.subarray(0, 2).toString('ascii') === 'BM';
    case '.avif': return buffer.subarray(4, 12).toString('ascii').includes('ftypavif');
    default: return false;
  }
}

/**
 * Narrow, deterministic completion gate. Only invoked for a request explicitly
 * asking for real downloaded pictures in a generated web project.
 * It does not claim that images are legally licensed, appropriate, or pretty.
 */
export async function inspectRequestedImageAssets({ prompt, workspaceRoot, webArtifacts }: InspectImageAssetsInput): Promise<ImageAssetCheck> {
  if (!imageRequirement(prompt)) return { ok: true, required: false };
  const workspace = await fs.realpath(workspaceRoot).catch(() => null);
  if (!workspace) return { ok: false, required: true, reason: 'The selected workspace could not be read to verify downloaded images.' };
  const paths = [...new Set(Array.isArray(webArtifacts) ? webArtifacts : [])];
  const candidates: string[] = [];
  for (const candidate of paths) {
    if (typeof candidate !== 'string' || !/\.(html?|css)$/i.test(candidate)) continue;
    const physical = await fs.realpath(path.resolve(candidate)).catch(() => null);
    if (!physical || !within(workspace, physical)) continue;
    const stat = await fs.stat(physical).catch(() => null);
    if (stat?.isFile() && stat.size <= 1_000_000) candidates.push(physical);
    if (candidates.length >= 30) break;
  }
  if (!candidates.length) {
    return { ok: false, required: true, reason: 'The request requires downloaded real images, but no verifiable HTML/CSS artifacts were recorded.' };
  }
  let refsSeen = 0;
  let localValid = 0;
  for (const sourceFile of candidates) {
    const body = await fs.readFile(sourceFile, 'utf8');
    for (const ref of extractImageReferences(body)) {
      refsSeen++;
      if (/^(?:https?:|data:|\/\/|blob:)/i.test(ref)) continue;
      let decoded: string;
      try { decoded = decodeURIComponent(ref.split(/[?#]/)[0] ?? ''); } catch { continue; }
      const image = path.resolve(path.dirname(sourceFile), decoded);
      try {
        const physical = await fs.realpath(image);
        if (!within(workspace, physical)) continue;
        const stat = await fs.stat(physical);
        if (!stat.isFile() || stat.size < 24 || stat.size > 25 * 1024 * 1024) continue;
        const handle = await fs.open(physical, 'r');
        try {
          const buffer = Buffer.alloc(1500);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (magicImage(buffer.subarray(0, bytesRead), path.extname(physical).toLowerCase())) {
            localValid++;
          }
        } finally { await handle.close(); }
      } catch { /* Missing or invalid asset is not completion evidence. */ }
    }
  }
  if (localValid > 0) return { ok: true, required: true, checkedReferences: refsSeen, validImages: localValid };
  return {
    ok: false,
    required: true,
    reason: `The user requested real pictures downloaded and applied to the website, but ${refsSeen} image reference(s) produced no verified local image file. Source/download attempts failed or the assets were not connected to HTML/CSS. Report the website as partial until a valid downloaded image is integrated.`
  };
}
