import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { webFetch } from './webFetch.js';
import { ensureSafeWorkspaceOutputPath } from '../browser/workspacePathSafety.js';
import { assertPublicWebUrl } from '../browser/urlPolicy.js';
import { getErrorMessage, resolveScopedPath, resolveToolWorkspaceRoots, safeFilenameStrict, safeSlugIdentifier, sanitizeToolError } from './toolPathSafety.js';
async function downloadOrGenerateFallback(url, targetPath, fallbackType = 'obj', workspaceRoot = path.dirname(targetPath), signal) {
    await ensureSafeWorkspaceOutputPath(workspaceRoot, targetPath);
    const download = await webFetch.execute({ url, outputFile: path.relative(workspaceRoot, targetPath) }, { workspaceRoot, ...(signal ? { signal } : {}) });
    if (download.success) {
        const stat = await fs.stat(targetPath);
        return { success: true, source: 'downloaded', size: stat.size };
    }
    if (!['.obj', '.svg', '.png'].includes(path.extname(targetPath).toLowerCase())) {
        return { success: false, source: 'download_failed', downloadError: String(download.error ?? 'Download unavailable') };
    }
    const fallback = await generateFallbackAsset(targetPath, fallbackType);
    return { ...fallback, downloadError: String(download.error ?? 'Download unavailable') };
}
async function writeFallbackAtomically(targetPath, payload, encoding) {
    const temp = `${targetPath}.part-${randomUUID()}`;
    try {
        await fs.writeFile(temp, payload, encoding ? { encoding, mode: 0o600 } : { mode: 0o600 });
        await fs.rename(temp, targetPath);
    }
    finally {
        await fs.unlink(temp).catch(() => { });
    }
}
async function generateFallbackAsset(targetPath, fallbackType) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    if (fallbackType === 'obj') {
        const objContent = `# Sovereign Procedural CC0 Mesh
v -0.5 -0.5  0.5
v  0.5 -0.5  0.5
v -0.5  0.5  0.5
v  0.5  0.5  0.5
v -0.5  0.5 -0.5
v  0.5  0.5 -0.5
v -0.5 -0.5 -0.5
v  0.5 -0.5 -0.5
f 1 2 4 3
f 3 4 6 5
f 5 6 8 7
f 7 8 2 1
f 2 8 6 4
f 7 1 3 5
`;
        await writeFallbackAtomically(targetPath, objContent, 'utf8');
    }
    else if (fallbackType === 'png') {
        await writeFallbackAtomically(targetPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAA9ElEQVR42u2bwRGDMAwE4SZVkaLyTwH8UxR1kRJCLFmW8OrN+O7W9/HYrNt+nsvEo2XyAQAAAAAAAAAAAAAAwKzziBY83q+f3zz3T5ifNeIwdCX0KBhdAViCR4HoAsAzeG8QqhS+x/qqFL6HjqqF99ZTxfCeuqoa3ktflcN7+OAsUH33rX5owB123+KLBgDgJvVv9UcDAAAAAAAAAAAAwOWJvLRomX/90QAABNQsa/1pgAVAtha0+qEBI6hn2X2XBoyGYNVXBhMjdZXJzAg9ZTQVqaPM5iLW540Qr8SC/xma8p0gx2EAAAAAAAAAAAAAAADkmy/UVmFrjmXOcQAAAABJRU5ErkJggg==', 'base64'));
    }
    else if (fallbackType === 'svg') {
        const svgContent = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#3a86ff"/><circle cx="32" cy="32" r="20" fill="#ff006e"/></svg>';
        await writeFallbackAtomically(targetPath, svgContent, 'utf8');
    }
    else {
        await writeFallbackAtomically(targetPath, `[Sovereign Asset Stub: ${path.basename(targetPath)}]`, 'utf8');
    }
    const stat = await fs.stat(targetPath);
    return { success: true, source: 'procedural_cc0_fallback', size: stat.size };
}
export function summarizeHarvestResults(results) {
    const downloadedCount = results.filter((item) => item.status?.source === 'downloaded').length;
    const fallbackCount = results.filter((item) => item.status?.source === 'procedural_cc0_fallback').length;
    const failedCount = results.length - downloadedCount - fallbackCount;
    return {
        status: failedCount ? 'STARTER_PACK_INCOMPLETE'
            : fallbackCount ? 'STARTER_PACK_WITH_PROCEDURAL_FALLBACKS' : 'STARTER_PACK_DOWNLOADED',
        downloaded_count: downloadedCount,
        fallback_count: fallbackCount,
        failed_count: failedCount
    };
}
export const gameAssetHarvester = {
    schema: {
        name: 'game.asset_harvest',
        description: 'Searches and downloads CC0 3D models (characters, race cars, props), 2D sprite sheets, and tilesets from open repositories (`Kenney`, `Poly Pizza`, `OpenGameArt`), automatically extracting into Godot `res://assets/`. Features procedural CC0 fallbacks when offline or rate-limited.',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['search_assets', 'download_asset', 'harvest_starter_pack'], description: 'Action to perform.' },
                query: { type: 'string', description: 'Search keyword.' },
                category: { type: 'string', enum: ['all', '3d_model', '2d_sprite', 'tileset', 'sfx', 'shader'], description: 'Category of asset.' },
                packType: { type: 'string', enum: ['rpg_starter_pack', 'cyberpunk_racer_pack', 'dungeon_pack'], description: 'Asset pack type for harvest_starter_pack.' },
                projectDir: { type: 'string', description: 'Absolute path to Godot/game project directory where `assets/` resides.' },
                assetUrl: { type: 'string', description: 'Raw direct URL to download when action is `download_asset`.' },
                targetSubdir: { type: 'string', description: 'Target subdirectory inside assets/.' }
            },
            required: ['action']
        }
    },
    async execute(args = {}, sandbox) {
        try {
            const { action, query, category = 'all', packType = 'rpg_starter_pack', projectDir, assetUrl, targetSubdir = '3d/props' } = args || {};
            const catalog = [
                { id: 'kenney_knight_3d', title: 'CC0 Medieval Knight 3D (.obj/.gltf)', category: '3d_model', url: 'https://kenney.nl/assets/obj/knight.obj', tags: ['knight', 'rpg', 'character', '3d'] },
                { id: 'kenney_car_3d', title: 'CC0 Cyberpunk Race Car 3D (.obj)', category: '3d_model', url: 'https://kenney.nl/assets/obj/race_car.obj', tags: ['race_car', 'cyberpunk', 'car', '3d'] },
                { id: 'kenney_dungeon_tiles', title: 'CC0 Dungeon Tileset 2D (.svg)', category: 'tileset', url: 'https://kenney.nl/assets/2d/dungeon.svg', tags: ['dungeon', 'tileset', 'rpg', '2d'] },
                { id: 'kenney_sword_3d', title: 'CC0 Iron Sword Weapon (.obj)', category: '3d_model', url: 'https://kenney.nl/assets/obj/sword.obj', tags: ['sword', 'weapon', 'rpg', '3d'] }
            ];
            if (action === 'search_assets') {
                const q = String(query || '').trim().toLowerCase();
                const matches = catalog.filter((item) => (category === 'all' || item.category === category) &&
                    (!q || item.tags.some((tag) => tag.includes(q)) || item.title.toLowerCase().includes(q)));
                return {
                    success: true,
                    output: JSON.stringify({
                        status: 'SEARCH_RESULTS',
                        query: query || 'all',
                        category,
                        results_count: matches.length,
                        items: matches
                    }, null, 2)
                };
            }
            if (action === 'download_asset') {
                const scope = resolveToolWorkspaceRoots(sandbox);
                const scopedProjectDir = projectDir
                    ? (scope.roots.length > 0 && !scope.grantAllAccess ? resolveScopedPath(projectDir, sandbox) : path.resolve(projectDir))
                    : '';
                if (!scopedProjectDir || !fsSync.existsSync(scopedProjectDir)) {
                    return { success: false, error: `Valid projectDir is required for asset download. Found: ${String(projectDir ?? '')}` };
                }
                const assetsRoot = path.resolve(scopedProjectDir, 'assets');
                const targetDir = path.resolve(assetsRoot, targetSubdir);
                const relativeDir = path.relative(assetsRoot, targetDir);
                if (relativeDir === '..' || relativeDir.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDir)) {
                    return { success: false, error: 'targetSubdir must remain inside project assets/' };
                }
                const urlToFetch = assetUrl || catalog[0].url;
                await assertPublicWebUrl(urlToFetch);
                const rawName = path.basename(new URL(urlToFetch).pathname) || `asset_${Date.now()}.obj`;
                // eslint-disable-next-line no-control-regex
                const fileName = rawName.replace(/[<>:"\\/|?*\x00-\x1f]/g, '_');
                const destFile = path.join(targetDir, fileName);
                const lowerName = fileName.toLowerCase();
                const fallbackType = lowerName.endsWith('.png') ? 'png' : lowerName.endsWith('.svg') ? 'svg' : 'obj';
                const resDownload = await downloadOrGenerateFallback(urlToFetch, destFile, fallbackType, scopedProjectDir, sandbox?.signal);
                if (!resDownload.success) {
                    return { success: false, error: resDownload.downloadError ?? 'Asset download failed', url: urlToFetch };
                }
                return {
                    success: true,
                    output: JSON.stringify({
                        status: resDownload.source === 'downloaded' ? 'ASSET_DOWNLOADED' : 'PROCEDURAL_FALLBACK_GENERATED',
                        downloaded: resDownload.source === 'downloaded',
                        url: urlToFetch,
                        destination: destFile,
                        download_result: resDownload
                    }, null, 2)
                };
            }
            if (action === 'harvest_starter_pack') {
                const scope = resolveToolWorkspaceRoots(sandbox);
                const scopedProjectDir = projectDir
                    ? (scope.roots.length > 0 && !scope.grantAllAccess ? resolveScopedPath(projectDir, sandbox) : path.resolve(projectDir))
                    : '';
                if (!scopedProjectDir || !fsSync.existsSync(scopedProjectDir)) {
                    return { success: false, error: `Valid projectDir is required for starter pack harvest. Found: ${String(projectDir ?? '')}` };
                }
                const assetsDir = path.join(scopedProjectDir, 'assets');
                const results = [];
                if (!['rpg_starter_pack', 'dungeon_pack', 'cyberpunk_racer_pack'].includes(packType)) {
                    return { success: false, error: 'Unknown starter pack type' };
                }
                if (packType === 'rpg_starter_pack' || packType === 'dungeon_pack') {
                    const charDir = path.join(assetsDir, '3d/characters');
                    const weaponDir = path.join(assetsDir, '3d/weapons');
                    const tileDir = path.join(assetsDir, '2d/tiles');
                    const r1 = await downloadOrGenerateFallback('https://kenney.nl/assets/obj/knight.obj', path.join(charDir, 'knight.obj'), 'obj', scopedProjectDir, sandbox?.signal);
                    const r2 = await downloadOrGenerateFallback('https://kenney.nl/assets/obj/sword.obj', path.join(weaponDir, 'sword.obj'), 'obj', scopedProjectDir, sandbox?.signal);
                    const r3 = await downloadOrGenerateFallback('https://kenney.nl/assets/2d/dungeon.svg', path.join(tileDir, 'dungeon_tiles.svg'), 'svg', scopedProjectDir, sandbox?.signal);
                    results.push({ item: 'knight.obj', status: r1 }, { item: 'sword.obj', status: r2 }, { item: 'dungeon_tiles.svg', status: r3 });
                }
                else {
                    const carDir = path.join(assetsDir, '3d/vehicles');
                    const trackDir = path.join(assetsDir, '3d/environment');
                    const r1 = await downloadOrGenerateFallback('https://kenney.nl/assets/obj/race_car.obj', path.join(carDir, 'cyberpunk_racer.obj'), 'obj', scopedProjectDir, sandbox?.signal);
                    const r2 = await downloadOrGenerateFallback('https://kenney.nl/assets/obj/highway_barrier.obj', path.join(trackDir, 'barrier.obj'), 'obj', scopedProjectDir, sandbox?.signal);
                    results.push({ item: 'cyberpunk_racer.obj', status: r1 }, { item: 'barrier.obj', status: r2 });
                }
                return {
                    success: true,
                    output: JSON.stringify({
                        ...summarizeHarvestResults(results),
                        pack_type: packType,
                        project_dir: projectDir,
                        assets_installed: results
                    }, null, 2)
                };
            }
            return { success: false, error: `Unknown action: ${String(action ?? '')}` };
        }
        catch (e) {
            return { success: false, error: getErrorMessage(e) };
        }
    }
};
