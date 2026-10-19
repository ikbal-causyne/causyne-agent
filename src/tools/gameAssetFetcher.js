import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

const MAX_ASSET_BYTES = 100 * 1024 * 1024;

function getWorkspaceTempDir() {
  const tmpDir = path.join(process.cwd(), '.tmp_causyne_3d', 'assets');
  if (!fsSync.existsSync(tmpDir)) {
    fsSync.mkdirSync(tmpDir, { recursive: true });
  }
  return tmpDir;
}

// ── Curated CC0 Open-Source Game Asset Catalog ──
const CC0_CATALOG = {
  "3d_models": [
    {
      id: "kenney_space_kit",
      title: "Kenney CC0 Space Kit (3D Models & Modules)",
      author: "Kenney.nl (CC0 Public Domain)",
      format: ".zip (contains .glb/.fbx/.obj + textures)",
      url: "https://kenney.nl/media/pages/assets/space-kit/f8c77efd5b-1662998797/kenney_space-kit.zip",
      description: "Modular 3D space station tiles, spacecraft, corridors, and sci-fi doors."
    },
    {
      id: "kenney_pirate_kit",
      title: "Kenney CC0 Pirate Kit (3D Ships & Islands)",
      author: "Kenney.nl (CC0 Public Domain)",
      format: ".zip (contains .glb/.fbx/.obj + textures)",
      url: "https://kenney.nl/media/pages/assets/pirate-kit/6c5bb5d2c2-1662998792/kenney_pirate-kit.zip",
      description: "Modular pirate galleons, cannons, docks, tropical islands, and treasure chests."
    },
    {
      id: "kenney_city_kit_commercial",
      title: "Kenney CC0 City Kit Commercial (3D Buildings)",
      author: "Kenney.nl (CC0 Public Domain)",
      format: ".zip (contains .glb/.fbx/.obj + textures)",
      url: "https://kenney.nl/media/pages/assets/city-kit-commercial/f80ec94ffb-1662998781/kenney_city-kit-commercial.zip",
      description: "Modular skyscrapers, roads, traffic lights, and urban infrastructure."
    }
  ],
  "2d_sprites": [
    {
      id: "kenney_pixel_platformer",
      title: "Kenney CC0 Pixel Platformer Pack",
      author: "Kenney.nl (CC0 Public Domain)",
      format: ".zip (contains .png sprite sheets & tiles)",
      url: "https://kenney.nl/media/pages/assets/pixel-platformer/01b80bf857-1662998813/kenney_pixel-platformer.zip",
      description: "Crisp 18x18 pixel character animations, enemies, coins, and multi-biome platform tiles."
    },
    {
      id: "kenney_ui_pack",
      title: "Kenney CC0 Game UI Pack",
      author: "Kenney.nl (CC0 Public Domain)",
      format: ".zip (contains .png UI buttons/panels/icons)",
      url: "https://kenney.nl/media/pages/assets/ui-pack/e756cdd5c8-1662998818/kenney_ui-pack.zip",
      description: "Complete HUD elements, buttons, progress bars, joysticks, and dialog panels."
    }
  ],
  "sfx": [
    {
      id: "kenney_sci_fi_sounds",
      title: "Kenney CC0 Sci-Fi Sound Effects Pack",
      author: "Kenney.nl (CC0 Public Domain)",
      format: ".zip (contains .wav / .ogg sound effects)",
      url: "https://kenney.nl/media/pages/assets/sci-fi-sounds/89de61d9a5-1662998809/kenney_sci-fi-sounds.zip",
      description: "Over 100 CC0 sci-fi lasers, force fields, alien hums, thrusters, and explosive crashes."
    },
    {
      id: "kenney_impact_sounds",
      title: "Kenney CC0 Impact Sound Effects",
      author: "Kenney.nl (CC0 Public Domain)",
      format: ".zip (contains .wav / .ogg sound effects)",
      url: "https://kenney.nl/media/pages/assets/impact-sounds/3576a91d1d-1662998802/kenney_impact-sounds.zip",
      description: "Punches, metal clangs, wood breaks, stone shatters, and physical impact audio."
    }
  ]
};

const CURATED_ASSET_URLS = new Set(
  Object.values(CC0_CATALOG).flat().map(asset => asset.url)
);

// ── Pure Node.js 16-Bit PCM WAV Synthesizer ──
function synthesizeWavBuffer(preset, sampleRate = 44100) {
  let samples = [];
  const dt = 1.0 / sampleRate;

  if (preset === 'laser') {
    const duration = 0.18;
    const numSamples = Math.floor(duration * sampleRate);
    for (let i = 0; i < numSamples; i++) {
      const t = i * dt;
      // Exponential sweep 800Hz -> 120Hz
      const freq = 800 * Math.pow(120 / 800, t / duration);
      const phase = 2 * Math.PI * freq * t;
      const env = Math.exp(-t * 18);
      // Sawtooth/sine hybrid
      const wave = Math.sin(phase) + 0.3 * (2 * (phase / (2 * Math.PI) - Math.floor(phase / (2 * Math.PI) + 0.5)));
      samples.push(wave * env * 0.7);
    }
  } else if (preset === 'explosion') {
    const duration = 0.65;
    const numSamples = Math.floor(duration * sampleRate);
    let lastSample = 0;
    for (let i = 0; i < numSamples; i++) {
      const t = i * dt;
      const whiteNoise = (Math.random() * 2 - 1);
      // Simple 1-pole lowpass filter for deep rumble
      const alpha = 0.15;
      const filtered = lastSample + alpha * (whiteNoise - lastSample);
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
      // Square wave
      const wave = Math.sin(phase) > 0 ? 0.6 : -0.6;
      samples.push(wave * env * 0.6);
    }
  } else if (preset === 'coin') {
    const duration = 0.28;
    const numSamples = Math.floor(duration * sampleRate);
    for (let i = 0; i < numSamples; i++) {
      const t = i * dt;
      let freq = t < 0.08 ? 1200 : 1800;
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
      const freq = notes[noteIdx];
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

  // Construct standard 44-byte RIFF/WAV header for 16-bit Mono PCM
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF chunk descriptor
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt sub-chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Sub-chunk size
  buffer.writeUInt16LE(1, 20);  // PCM format
  buffer.writeUInt16LE(1, 22);  // Mono (1 channel)
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // Byte rate
  buffer.writeUInt16LE(2, 32);  // Block align
  buffer.writeUInt16LE(16, 34); // Bits per sample

  // data sub-chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Write 16-bit PCM samples
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    // Clamp between -1.0 and +1.0
    const clamped = Math.max(-1.0, Math.min(1.0, samples[i]));
    const pcm = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
    buffer.writeInt16LE(Math.floor(pcm), offset);
    offset += 2;
  }

  return buffer;
}

export const gameAssetFetcher = {
  schema: {
    name: 'game.asset_fetch',
    description: 'Sovereign Open-Source Game Asset & Audio Downloader. Searches and fetches CC0 assets (3D models, 2D sprite sheets, SFX packs) or mathematically synthesizes pure 16-bit PCM `.wav` sound effects (`laser`, `explosion`, `jump`, `coin`, `powerup`, `hit`) offline.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search_cc0', 'download_asset', 'synth_wav'],
          description: 'Operation: `search_cc0` (catalog query), `download_asset` (CC0 URL download + unzip), or `synth_wav` (pure PCM `.wav` generation).'
        },
        category: {
          type: 'string',
          enum: ['3d_models', '2d_sprites', 'sfx', 'music', 'all'],
          description: 'Asset category when searching (`search_cc0`).'
        },
        query: {
          type: 'string',
          description: 'Search keyword (e.g., `space`, `pirate`, `ui`, `laser`).'
        },
        url: {
          type: 'string',
          description: 'Direct CC0 asset download URL when using `action: "download_asset"`.'
        },
        preset: {
          type: 'string',
          enum: ['laser', 'explosion', 'jump', 'coin', 'powerup', 'hit'],
          description: 'Audio preset when using `action: "synth_wav"`.'
        },
        outputFilename: {
          type: 'string',
          description: 'Filename for downloaded asset or synthesized `.wav` (e.g. `sfx_laser.wav`, `space_kit.zip`).'
        },
        outputDir: {
          type: 'string',
          description: 'Custom output directory. Defaults to `.tmp_causyne_3d/assets`.'
        }
      },
      required: ['action']
    }
  },

  async execute(args, sandbox) {
    try {
      const { action, category = 'all', query = '', url, preset, outputFilename, outputDir } = args;
      const targetDir = outputDir || getWorkspaceTempDir();

      // Security Check: Ensure output path is allowed inside workspace boundary
      if (sandbox && sandbox.isPathAllowed && !sandbox.isPathAllowed(path.resolve(targetDir))) {
        return { success: false, error: `Path outside allowed workspace boundary: ${targetDir}` };
      }

      if (!fsSync.existsSync(targetDir)) {
        await fs.mkdir(targetDir, { recursive: true });
      }

      if (action === 'search_cc0') {
        let results = [];
        const categories = category === 'all' ? Object.keys(CC0_CATALOG) : [category];
        for (const cat of categories) {
          if (CC0_CATALOG[cat]) {
            const matches = CC0_CATALOG[cat].filter(item => 
              query === '' || 
              item.title.toLowerCase().includes(query.toLowerCase()) || 
              item.description.toLowerCase().includes(query.toLowerCase()) ||
              item.id.toLowerCase().includes(query.toLowerCase())
            );
            results.push(...matches.map(m => ({ category: cat, ...m })));
          }
        }
        return {
          success: true,
          output: JSON.stringify({
            search_query: query || 'all',
            category_filter: category,
            total_matches: results.length,
            results: results,
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
        if (filename !== requestedName || filename === '.' || filename === '..') {
          return { success: false, error: 'outputFilename must be a plain file name without directory components.' };
        }
        const filePath = path.join(targetDir, filename);

        const wavBuffer = synthesizeWavBuffer(preset);
        await fs.writeFile(filePath, wavBuffer);

        return {
          success: true,
          output: JSON.stringify({
            action: 'synth_wav',
            preset: preset,
            format: '16-bit Mono PCM WAV (44.1 kHz)',
            output_file: filePath,
            size_bytes: wavBuffer.length,
            ready_to_use: true,
            instructions: `Audio file successfully generated offline using pure mathematical synthesis. Ready to embed into Godot res://, HTML5, or desktop game engines.`
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
        if (filename !== requestedName || filename === '.' || filename === '..') {
          return { success: false, error: 'outputFilename must be a plain file name without directory components.' };
        }
        const filePath = path.join(targetDir, filename);

        console.log(`[game_asset_fetch] Downloading CC0 asset from: ${url}`);
        const response = await fetch(url, { headers: { 'User-Agent': 'Causyne-Agent-Sovereign/1.3.1' } });
        if (!response.ok) {
          return { success: false, error: `Failed to fetch asset from URL (${response.status} ${response.statusText}): ${url}` };
        }

        const declaredSize = Number(response.headers.get('content-length') || 0);
        if (declaredSize > MAX_ASSET_BYTES) {
          return { success: false, error: `Asset exceeds the ${MAX_ASSET_BYTES / 1024 / 1024} MB download limit.` };
        }
        const chunks = [];
        let received = 0;
        for await (const chunk of response.body) {
          received += chunk.length;
          if (received > MAX_ASSET_BYTES) {
            response.body.destroy();
            return { success: false, error: `Asset exceeds the ${MAX_ASSET_BYTES / 1024 / 1024} MB download limit.` };
          }
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        await fs.writeFile(filePath, buffer);

        return {
          success: true,
          output: JSON.stringify({
            action: 'download_asset',
            url: url,
            output_file: filePath,
            size_bytes: buffer.length,
            extracted_folder: null,
            ready_to_use: !filename.toLowerCase().endsWith('.zip'),
            instructions: filename.toLowerCase().endsWith('.zip')
              ? `Archive saved at ${filePath}. Inspect its entries before extracting it with an approved archive tool.`
              : `Asset saved at ${filePath}.`
          }, null, 2)
        };
      }

      return { success: false, error: `Unknown action: ${action}` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
};
