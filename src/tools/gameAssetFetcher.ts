import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureSafeWorkspaceOutputPath } from '../browser/workspacePathSafety.js';
import { assertPublicWebUrl } from '../browser/urlPolicy.js';
import { isPhysicalPathAllowed } from '../agent/workspaceBoundary.js';
import {
  getErrorMessage,
  resolveToolWorkspaceRoots,
  sanitizeToolError,
  type ToolWorkspaceContext
} from './toolPathSafety.js';

const MAX_ASSET_BYTES = 100 * 1024 * 1024;

interface CatalogAssetItem {
  id: string;
  title: string;
  author: string;
  format: string;
  url: string;
  description: string;
}

async function prepareAssetOutput(filePath: string, sandbox?: ToolWorkspaceContext | null): Promise<void> {
  const scopedWorkspace = sandbox?.workspaceRoot ?? sandbox?.workspacePaths?.[0] ?? sandbox?.parentLoop?.workspaceRoot ?? (sandbox ? process.cwd() : null);
  if (scopedWorkspace) {
    await ensureSafeWorkspaceOutputPath(scopedWorkspace, filePath);
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const existing = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error('Output target cannot be a symlink or directory');
  }
}

async function writeAssetAtomically(filePath: string, bytes: Buffer): Promise<void> {
  const temporary = `${filePath}.part-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, bytes, { mode: 0o600 });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

export async function streamAssetResponseToFile(
  response: { body?: ReadableStream<Uint8Array> | null },
  filePath: string,
  maxBytes = MAX_ASSET_BYTES,
  sandbox?: ToolWorkspaceContext | null
): Promise<number> {
  if (!response.body) throw new Error('Downloaded asset had no response body');
  await prepareAssetOutput(filePath, sandbox);
  const temporary = `${filePath}.part-${randomUUID()}`;
  const reader = response.body.getReader();
  let handle: fs.FileHandle | undefined;
  let received = 0;
  const validateZip = filePath.toLowerCase().endsWith('.zip');
  const signature = Buffer.alloc(4);
  let signatureSize = 0;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    while (true) {
      if (sandbox?.signal?.aborted) {
        throw new Error('Asset download aborted');
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (received + value.byteLength > maxBytes) {
        throw new Error(`Asset exceeds the ${maxBytes / 1024 / 1024} MB download limit.`);
      }
      if (validateZip && signatureSize < 4) {
        const length = Math.min(4 - signatureSize, value.byteLength);
        signature.set(value.subarray(0, length), signatureSize);
        signatureSize += length;
        if (signatureSize === 4 && !(signature[0] === 0x50 && signature[1] === 0x4b &&
          ((signature[2] === 3 && signature[3] === 4) ||
            (signature[2] === 5 && signature[3] === 6) ||
            (signature[2] === 7 && signature[3] === 8)))) {
          throw new Error('Downloaded ZIP archive has an invalid file signature');
        }
      }
      let written = 0;
      while (written < value.byteLength) {
        const result = await handle.write(value, written, value.byteLength - written, null);
        if (result.bytesWritten <= 0) throw new Error('Asset download made no write progress');
        written += result.bytesWritten;
      }
      received += value.byteLength;
    }
    if (validateZip && signatureSize < 4) throw new Error('Downloaded ZIP archive is incomplete');
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filePath);
    return received;
  } catch (error: unknown) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

async function fetchCuratedAssetWithSafeRedirects(url: string, parentSignal?: AbortSignal): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(30_000);
  const signal = parentSignal ? AbortSignal.any([timeoutSignal, parentSignal]) : timeoutSignal;
  let current = await assertPublicWebUrl(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(current, {
      headers: { 'User-Agent': 'Causyne-Agent-Sovereign/1.3.1' },
      redirect: 'manual',
      signal
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (redirects === 5) throw new Error('Asset download exceeded five redirects');
    if (!location) throw new Error(`Asset HTTP ${response.status} redirect has no Location header`);
    const next = await assertPublicWebUrl(new URL(location, current).href);
    if (current.protocol === 'https:' && next.protocol !== 'https:') {
      throw new Error('Asset redirect cannot downgrade HTTPS to HTTP');
    }
    current = next;
  }
  throw new Error('Asset redirect handling failed');
}

function isSafeOutputFilename(value: unknown): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length > 0 && value.length <= 255
    && value !== '.' && value !== '..' && !/[\\/:*?"<>|\x00-\x1f]/.test(value)
    && !/[. ]$/.test(value)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

function getWorkspaceTempDir(): string {
  return path.join(process.cwd(), '.tmp_causyne_3d', 'assets');
}

const CC0_CATALOG: Record<string, CatalogAssetItem[]> = {
  '3d_models': [
    {
      id: 'kenney_space_kit',
      title: 'Kenney CC0 Space Kit (3D Models & Modules)',
      author: 'Kenney.nl (CC0 Public Domain)',
      format: '.zip (contains .glb/.fbx/.obj + textures)',
      url: 'https://kenney.nl/media/pages/assets/space-kit/f8c77efd5b-1662998797/kenney_space-kit.zip',
      description: 'Modular 3D space station tiles, spacecraft, corridors, and sci-fi doors.'
    },
    {
      id: 'kenney_pirate_kit',
      title: 'Kenney CC0 Pirate Kit (3D Ships & Islands)',
      author: 'Kenney.nl (CC0 Public Domain)',
      format: '.zip (contains .glb/.fbx/.obj + textures)',
      url: 'https://kenney.nl/media/pages/assets/pirate-kit/6c5bb5d2c2-1662998792/kenney_pirate-kit.zip',
      description: 'Modular pirate galleons, cannons, docks, tropical islands, and treasure chests.'
    },
    {
      id: 'kenney_city_kit_commercial',
      title: 'Kenney CC0 City Kit Commercial (3D Buildings)',
      author: 'Kenney.nl (CC0 Public Domain)',
      format: '.zip (contains .glb/.fbx/.obj + textures)',
      url: 'https://kenney.nl/media/pages/assets/city-kit-commercial/f80ec94ffb-1662998781/kenney_city-kit-commercial.zip',
      description: 'Modular skyscrapers, roads, traffic lights, and urban infrastructure.'
    }
  ],
  '2d_sprites': [
    {
      id: 'kenney_pixel_platformer',
      title: 'Kenney CC0 Pixel Platformer Pack',
      author: 'Kenney.nl (CC0 Public Domain)',
      format: '.zip (contains .png sprite sheets & tiles)',
      url: 'https://kenney.nl/media/pages/assets/pixel-platformer/01b80bf857-1662998813/kenney_pixel-platformer.zip',
      description: 'Crisp 18x18 pixel character animations, enemies, coins, and multi-biome platform tiles.'
    },
    {
      id: 'kenney_ui_pack',
      title: 'Kenney CC0 Game UI Pack',
      author: 'Kenney.nl (CC0 Public Domain)',
      format: '.zip (contains .png UI buttons/panels/icons)',
      url: 'https://kenney.nl/media/pages/assets/ui-pack/e756cdd5c8-1662998818/kenney_ui-pack.zip',
      description: 'Complete HUD elements, buttons, progress bars, joysticks, and dialog panels.'
    }
  ],
  sfx: [
    {
      id: 'kenney_sci_fi_sounds',
      title: 'Kenney CC0 Sci-Fi Sound Effects Pack',
      author: 'Kenney.nl (CC0 Public Domain)',
      format: '.zip (contains .wav / .ogg sound effects)',
      url: 'https://kenney.nl/media/pages/assets/sci-fi-sounds/89de61d9a5-1662998809/kenney_sci-fi-sounds.zip',
      description: 'Over 100 CC0 sci-fi lasers, force fields, alien hums, thrusters, and explosive crashes.'
    },
    {
      id: 'kenney_impact_sounds',
      title: 'Kenney CC0 Impact Sound Effects',
      author: 'Kenney.nl (CC0 Public Domain)',
      format: '.zip (contains .wav / .ogg sound effects)',
      url: 'https://kenney.nl/media/pages/assets/impact-sounds/3576a91d1d-1662998802/kenney_impact-sounds.zip',
      description: 'Punches, metal clangs, wood breaks, stone shatters, and physical impact audio.'
    }
  ]
};

const CURATED_ASSET_URLS = new Set(
  Object.values(CC0_CATALOG).flat().map((asset) => asset.url)
);

function synthesizeWavBuffer(preset: string, sampleRate = 44100): Buffer {
  const samples: number[] = [];
  const dt = 1.0 / sampleRate;

  if (preset === 'laser') {
    const duration = 0.18;
    const numSamples = Math.floor(duration * sampleRate);
    for (let i = 0; i < numSamples; i++) {
      const t = i * dt;
      const freq = 800 * Math.pow(120 / 800, t / duration);
      const phase = 2 * Math.PI * freq * t;
      const env = Math.exp(-t * 18);
      const wave = Math.sin(phase) + 0.3 * (2 * (phase / (2 * Math.PI) - Math.floor(phase / (2 * Math.PI) + 0.5)));
      samples.push(wave * env * 0.7);
    }
  } else if (preset === 'explosion') {
    const duration = 0.65;
    const numSamples = Math.floor(duration * sampleRate);
    let lastSample = 0;
    for (let i = 0; i < numSamples; i++) {
      const t = i * dt;
      const whiteNoise = Math.random() * 2 - 1;
      const filtered = lastSample + 0.15 * (whiteNoise - lastSample);
      lastSample = filtered;
      const env = Math.exp(-t * 6) * (1 - t / duration);
      samples.push(filtered * env * 1.8);
    }
  } else if (preset === 'jump') {
    const duration = 0.15;
    const numSamples = Math.floor(duration * sampleRate);
    for (let i = 0; i < numSamples; i++) {
      const t = i * dt;
      const freq = 260 + (560 - 260) * (t / duration);
      const phase = 2 * Math.PI * freq * t;
      const env = Math.sin((Math.PI * t) / duration);
      const wave = Math.sin(phase) > 0 ? 0.6 : -0.6;
      samples.push(wave * env * 0.6);
    }
  } else if (preset === 'coin') {
    const duration = 0.28;
    const numSamples = Math.floor(duration * sampleRate);
    for (let i = 0; i < numSamples; i++) {
      const t = i * dt;
      const freq = t < 0.08 ? 1200 : 1800;
      const phase = 2 * Math.PI * freq * t;
      const env = t < 0.08 ? Math.exp(-t * 15) : Math.exp(-(t - 0.08) * 12);
      const wave = Math.sin(phase) + 0.2 * Math.sin(phase * 2);
      samples.push(wave * env * 0.75);
    }
  } else if (preset === 'powerup') {
    const duration = 0.36;
    const numSamples = Math.floor(duration * sampleRate);
    const notes = [300, 450, 600, 900];
    for (let i = 0; i < numSamples; i++) {
      const t = i * dt;
      const noteIdx = Math.min(notes.length - 1, Math.floor((t / duration) * notes.length));
      const freq = notes[noteIdx] ?? 300;
      const phase = 2 * Math.PI * freq * t;
      const env = 1.0 - (t / duration) * 0.5;
      samples.push(Math.sin(phase) * env * 0.7);
    }
  } else if (preset === 'hit') {
    const duration = 0.12;
    const numSamples = Math.floor(duration * sampleRate);
    for (let i = 0; i < numSamples; i++) {
      const t = i * dt;
      const freq = 160 - (100 * (t / duration));
      const phase = 2 * Math.PI * freq * t;
      const env = Math.exp(-t * 28);
      const wave = Math.sin(phase) > 0 ? 0.8 : -0.8;
      samples.push(wave * env * 0.8);
    }
  } else {
    throw new Error(`Unknown WAV synth preset: ${preset}. Valid options: laser, explosion, jump, coin, powerup, hit.`);
  }

  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1.0, Math.min(1.0, samples[i] ?? 0));
    const pcm = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
    buffer.writeInt16LE(Math.floor(pcm), offset);
    offset += 2;
  }
  return buffer;
}

export interface GameAssetFetcherArgs {
  action?: string | undefined;
  category?: string | undefined;
  query?: string | undefined;
  url?: string | undefined;
  preset?: string | undefined;
  outputFilename?: string | undefined;
  outputDir?: string | undefined;
}

export const gameAssetFetcher = {
  schema: {
    name: 'game.asset_fetch',
    description: 'Sovereign Open-Source Game Asset & Audio Downloader. Searches and fetches CC0 assets (3D models, 2D sprite sheets, SFX packs) or mathematically synthesizes pure 16-bit PCM `.wav` sound effects (`laser`, `explosion`, `jump`, `coin`, `powerup`, `hit`) offline.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search_cc0', 'download_asset', 'synth_wav'], description: 'Operation to run.' },
        category: { type: 'string', enum: ['3d_models', '2d_sprites', 'sfx', 'music', 'all'], description: 'Asset category when searching (`search_cc0`).' },
        query: { type: 'string', description: 'Search keyword.' },
        url: { type: 'string', description: 'Direct CC0 asset download URL when using `action: "download_asset"`.' },
        preset: { type: 'string', enum: ['laser', 'explosion', 'jump', 'coin', 'powerup', 'hit'], description: 'Audio preset when using `action: "synth_wav"`.' },
        outputFilename: { type: 'string', description: 'Filename for downloaded asset or synthesized `.wav`.' },
        outputDir: { type: 'string', description: 'Custom output directory. Defaults to `.tmp_causyne_3d/assets`.' }
      },
      required: ['action']
    }
  },

  async execute(args: GameAssetFetcherArgs = {}, sandbox?: ToolWorkspaceContext): Promise<{ success: boolean; output?: string | undefined; error?: string | undefined }> {
    try {
      const { action, category = 'all', query = '', url, preset, outputFilename, outputDir } = args || {};
      const scope = resolveToolWorkspaceRoots(sandbox);
      const workspace = scope.primaryRoot ?? undefined;
      const targetDir = outputDir || (workspace ? path.join(path.resolve(workspace), '.tmp_causyne_3d', 'assets') : getWorkspaceTempDir());
      const resolvedTargetDir = path.resolve(targetDir);

      if (sandbox && !scope.grantAllAccess) {
        if (typeof sandbox.isPathAllowed === 'function' && !sandbox.isPathAllowed(resolvedTargetDir)) {
          return { success: false, error: `Path outside allowed workspace boundary: ${targetDir}` };
        }
        if (scope.roots.length > 0 && !isPhysicalPathAllowed(resolvedTargetDir, scope.roots)) {
          return { success: false, error: `Path outside allowed workspace boundary: ${targetDir}` };
        }
      }

      if (action === 'search_cc0') {
        const results: Array<CatalogAssetItem & { category: string }> = [];
        const categories = category === 'all' ? Object.keys(CC0_CATALOG) : [category];
        const lowerQuery = String(query ?? '').toLowerCase();
        for (const cat of categories) {
          const items = Object.hasOwn(CC0_CATALOG, cat) ? CC0_CATALOG[cat] : undefined;
          if (items) {
            const matches = items.filter((item) =>
              lowerQuery === '' ||
              item.title.toLowerCase().includes(lowerQuery) ||
              item.description.toLowerCase().includes(lowerQuery) ||
              item.id.toLowerCase().includes(lowerQuery)
            );
            results.push(...matches.map((m) => ({ category: cat, ...m })));
          }
        }
        return {
          success: true,
          output: JSON.stringify({
            search_query: query || 'all',
            category_filter: category,
            total_matches: results.length,
            results,
            instructions: 'Use action: "download_asset" with one of these exact catalog URLs. Downloads require approval and archives are saved without automatic extraction.'
          }, null, 2)
        };
      }

      if (action === 'synth_wav') {
        if (!preset) {
          return { success: false, error: 'Parameter "preset" is required when action is "synth_wav". Valid choices: laser, explosion, jump, coin, powerup, hit.' };
        }
        const requestedName = outputFilename || `sfx_${preset}.wav`;
        const filename = path.basename(requestedName);
        if (filename !== requestedName || !isSafeOutputFilename(filename)) {
          return { success: false, error: 'outputFilename must be a plain file name without directory components.' };
        }
        if (path.extname(filename).toLowerCase() !== '.wav') {
          return { success: false, error: 'Synthesized PCM audio must use a .wav output filename.' };
        }
        const filePath = path.join(targetDir, filename);

        const wavBuffer = synthesizeWavBuffer(preset);
        await prepareAssetOutput(filePath, sandbox);
        await writeAssetAtomically(filePath, wavBuffer);

        return {
          success: true,
          output: JSON.stringify({
            action: 'synth_wav',
            preset,
            format: '16-bit Mono PCM WAV (44.1 kHz)',
            output_file: filePath,
            size_bytes: wavBuffer.length,
            ready_to_use: true,
            instructions: 'Audio file successfully generated offline using pure mathematical synthesis. Ready to embed into Godot res://, HTML5, or desktop game engines.'
          }, null, 2)
        };
      }

      if (action === 'download_asset') {
        if (!url) {
          return { success: false, error: 'Parameter "url" is required when action is "download_asset".' };
        }
        if (!CURATED_ASSET_URLS.has(url)) {
          return { success: false, error: 'Only exact URLs returned by the curated CC0 catalog may be downloaded.' };
        }
        const requestedName = outputFilename || path.basename(new URL(url).pathname) || 'downloaded_asset.zip';
        const filename = path.basename(requestedName);
        if (filename !== requestedName || !isSafeOutputFilename(filename)) {
          return { success: false, error: 'outputFilename must be a plain file name without directory components.' };
        }
        const sourceExtension = path.extname(new URL(url).pathname).toLowerCase();
        if (path.extname(filename).toLowerCase() !== sourceExtension) {
          return { success: false, error: 'Downloaded asset filename must preserve its source file extension.' };
        }
        const filePath = path.join(targetDir, filename);

        const response = await fetchCuratedAssetWithSafeRedirects(url, sandbox?.signal);
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          return { success: false, error: `Failed to fetch asset from URL (${response.status} ${response.statusText}): ${url}` };
        }

        const declaredSize = Number(response.headers.get('content-length') || 0);
        if (Number.isFinite(declaredSize) && declaredSize > MAX_ASSET_BYTES) {
          await response.body?.cancel().catch(() => {});
          return { success: false, error: `Asset exceeds the ${MAX_ASSET_BYTES / 1024 / 1024} MB download limit.` };
        }
        const received = await streamAssetResponseToFile(response, filePath, MAX_ASSET_BYTES, sandbox);

        return {
          success: true,
          output: JSON.stringify({
            action: 'download_asset',
            url,
            output_file: filePath,
            size_bytes: received,
            extracted_folder: null,
            ready_to_use: !filename.toLowerCase().endsWith('.zip'),
            instructions: filename.toLowerCase().endsWith('.zip')
              ? `Archive saved at ${filePath}. Inspect its entries before extracting it with an approved archive tool.`
              : `Asset saved at ${filePath}.`
          }, null, 2)
        };
      }

      return { success: false, error: `Unknown action: ${String(action ?? '')}` };
    } catch (err: unknown) {
      return { success: false, error: sanitizeToolError(err) };
    }
  }
};
