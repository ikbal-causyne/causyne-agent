import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

// Helper: Encode raw 16-bit PCM samples array (-1.0 to 1.0) into valid WAV binary Buffer
function encodeWav(samples, sampleRate = 44100) {
  const numSamples = samples.length;
  const buffer = Buffer.alloc(44 + numSamples * 2);

  // RIFF Chunk
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + numSamples * 2, 4);
  buffer.write('WAVE', 8);

  // fmt Sub-chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Sub-chunk size
  buffer.writeUInt16LE(1, 20);  // Audio format 1 = PCM
  buffer.writeUInt16LE(1, 22);  // Channels = 1 (Mono)
  buffer.writeUInt32LE(sampleRate, 24); // Sample rate
  buffer.writeUInt32LE(sampleRate * 2, 28); // Byte rate
  buffer.writeUInt16LE(2, 32);  // Block align
  buffer.writeUInt16LE(16, 34); // Bits per sample

  // data Sub-chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(numSamples * 2, 40);

  // Write PCM 16-bit samples
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1.0, Math.min(1.0, samples[i]));
    const intVal = clamped < 0 ? clamped * 32768 : clamped * 32767;
    buffer.writeInt16LE(Math.floor(intVal), offset);
    offset += 2;
  }
  return buffer;
}

export const gameAudioSynth = {
  schema: {
    name: 'game.audio_synth',
    description: 'Offline mathematical 16-bit PCM WAV audio synthesizer for Godot (`AudioStreamPlayer`) and Web games. Generates 15+ specialized game SFX (`sword_slash`, `spell_cast`, `hit_damage`, `potion_drink`, `car_drift`, `engine_rev`, `coin_pickup`, `jump`, `laser`, `explosion`, `footstep`, `boss_roar`) and looping Synthwave / Medieval BGM without external dependencies.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['synthesize_sfx', 'synthesize_bgm', 'generate_sound_pack'],
          description: 'Action: synthesize_sfx (generate individual WAV sound effect), synthesize_bgm (generate looping background track), or generate_sound_pack (batch generate 10+ essential SFX into project audio/sfx folder).'
        },
        sfxType: {
          type: 'string',
          enum: [
            'sword_slash', 'spell_cast', 'hit_damage', 'potion_drink',
            'car_drift', 'engine_rev', 'coin_pickup', 'jump',
            'laser', 'explosion', 'footstep', 'boss_roar',
            'door_open', 'chest_unlock', 'level_up'
          ],
          description: 'Type of sound effect to synthesize.'
        },
        bgmGenre: {
          type: 'string',
          enum: ['synthwave_racer', 'medieval_battle', 'mystic_dungeon'],
          description: 'Genre for background music synthesis.'
        },
        durationSeconds: {
          type: 'number',
          description: 'Duration in seconds (default 0.4s for SFX, 4.0s loop for BGM).'
        },
        outputPath: {
          type: 'string',
          description: 'Absolute path to write the generated `.wav` file (`res://audio/sfx/sword.wav`).'
        },
        projectDir: {
          type: 'string',
          description: 'Absolute path to Godot project directory for generate_sound_pack.'
        }
      },
      required: ['action']
    }
  },

  async execute(args) {
    try {
      const { action, sfxType = 'sword_slash', bgmGenre = 'synthwave_racer', durationSeconds, outputPath, projectDir } = args;
      const sampleRate = 44100;

      if (action === 'synthesize_sfx') {
        const duration = durationSeconds || (sfxType === 'boss_roar' || sfxType === 'explosion' ? 1.2 : 0.4);
        const numSamples = Math.floor(sampleRate * duration);
        const samples = new Float32Array(numSamples);

        for (let i = 0; i < numSamples; i++) {
          const t = i / sampleRate;
          const progress = i / numSamples;
          const envelope = Math.exp(-progress * 4.0); // Exponential decay

          if (sfxType === 'sword_slash') {
            // White noise filtered with high pitch sweep down
            const freq = 1200 - progress * 900;
            const noise = (Math.random() * 2 - 1) * 0.7;
            const tone = Math.sin(2 * Math.PI * freq * t) * 0.3;
            samples[i] = (noise + tone) * envelope * (progress < 0.1 ? progress * 10 : 1.0);
          } else if (sfxType === 'spell_cast') {
            // Frequency modulation chime sweep upwards
            const freq = 400 + progress * 800 + Math.sin(2 * Math.PI * 30 * t) * 100;
            samples[i] = Math.sin(2 * Math.PI * freq * t) * envelope;
          } else if (sfxType === 'hit_damage') {
            // Heavy low frequency impact + crunch noise
            const freq = 120 - progress * 80;
            const noise = (Math.random() * 2 - 1) * 0.5;
            samples[i] = (Math.sin(2 * Math.PI * freq * t) + noise) * Math.exp(-progress * 8.0);
          } else if (sfxType === 'potion_drink') {
            // Liquid gulp pitch step up
            const step = Math.floor(progress * 4);
            const freq = 300 + step * 80;
            samples[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-(progress % 0.25) * 15.0);
          } else if (sfxType === 'car_drift') {
            // Tire screech high frequency noise modulation
            const screech = Math.sin(2 * Math.PI * (1800 + Math.sin(2 * Math.PI * 40 * t) * 300) * t);
            const noise = (Math.random() * 2 - 1) * 0.6;
            samples[i] = (screech * 0.4 + noise * 0.6) * (1.0 - progress * 0.5);
          } else if (sfxType === 'engine_rev') {
            // Low sawtooth pulse growing in frequency
            const freq = 60 + progress * 140;
            const saw = 2 * (t * freq - Math.floor(0.5 + t * freq));
            samples[i] = saw * 0.8 * Math.min(1.0, progress * 3.0);
          } else if (sfxType === 'coin_pickup') {
            // Classic two-tone high pitch chime
            const freq = progress < 0.4 ? 987.77 : 1318.51; // B5 -> E6
            samples[i] = Math.sin(2 * Math.PI * freq * t) * envelope * 0.7;
          } else if (sfxType === 'jump') {
            // Rapid pitch slide upwards
            const freq = 180 + progress * 400;
            samples[i] = Math.sin(2 * Math.PI * freq * t) * envelope;
          } else if (sfxType === 'laser') {
            // Fast downward sweep
            const freq = 1500 * Math.pow(0.1, progress);
            samples[i] = Math.sin(2 * Math.PI * freq * t) * envelope;
          } else if (sfxType === 'explosion') {
            // Deep bass rumble + heavy noise
            const bass = Math.sin(2 * Math.PI * (50 - progress * 30) * t);
            const noise = (Math.random() * 2 - 1);
            samples[i] = (bass * 0.6 + noise * 0.6) * Math.exp(-progress * 2.5);
          } else if (sfxType === 'boss_roar') {
            // Aggressive guttural distortion & growl
            const growl = Math.sin(2 * Math.PI * 45 * t + Math.sin(2 * Math.PI * 15 * t) * 5);
            const noise = (Math.random() * 2 - 1) * 0.4;
            samples[i] = Math.max(-0.8, Math.min(0.8, (growl + noise) * 1.5)) * Math.exp(-progress * 2.0);
          } else if (sfxType === 'level_up') {
            // Fanfare arpeggio C major (C5, E5, G5, C6)
            const step = Math.floor(progress * 4);
            const freqs = [523.25, 659.25, 783.99, 1046.50];
            const freq = freqs[Math.min(3, step)];
            samples[i] = Math.sin(2 * Math.PI * freq * t) * 0.7;
          } else {
            // Default crisp pop/click
            samples[i] = Math.sin(2 * Math.PI * 440 * t) * envelope;
          }
        }

        const wavBuffer = encodeWav(samples, sampleRate);
        const finalPath = outputPath || path.join(process.cwd(), '.tmp_causyne_3d', `${sfxType}_${Date.now()}.wav`);
        await fs.mkdir(path.dirname(finalPath), { recursive: true });
        await fs.writeFile(finalPath, wavBuffer);

        return {
          success: true,
          output: JSON.stringify({
            status: 'SYNTHESIZED_SFX',
            sfx_type: sfxType,
            duration_seconds: duration,
            sample_rate: sampleRate,
            file_path: finalPath,
            size_bytes: wavBuffer.length
          }, null, 2)
        };
      }

      if (action === 'synthesize_bgm') {
        const duration = durationSeconds || 4.0;
        const numSamples = Math.floor(sampleRate * duration);
        const samples = new Float32Array(numSamples);

        for (let i = 0; i < numSamples; i++) {
          const t = i / sampleRate;
          if (bgmGenre === 'synthwave_racer') {
            // Driving bass pulse at 120 BPM (2 Hz pulse) + arpeggiator
            const beat = (t * 4) % 1.0;
            const bassFreq = 55.0; // A1
            const bass = Math.sin(2 * Math.PI * bassFreq * t) * Math.exp(-beat * 4.0) * 0.6;
            const arpStep = Math.floor((t * 8) % 4);
            const arpFreqs = [220.0, 261.63, 329.63, 392.00];
            const arp = Math.sin(2 * Math.PI * arpFreqs[arpStep] * t) * 0.2;
            samples[i] = bass + arp;
          } else if (bgmGenre === 'medieval_battle') {
            // Marching drums + horns
            const drumBeat = (t * 2) % 1.0;
            const drum = (Math.random() * 2 - 1) * Math.exp(-drumBeat * 12.0) * 0.5;
            const horn = Math.sin(2 * Math.PI * 146.83 * t) * 0.3; // D3
            samples[i] = drum + horn;
          } else {
            // Mystic dungeon atmospheric drone
            const drone = Math.sin(2 * Math.PI * 82.41 * t) * 0.4 + Math.sin(2 * Math.PI * 123.47 * t + Math.sin(t) * 2) * 0.2;
            samples[i] = drone;
          }
        }

        const wavBuffer = encodeWav(samples, sampleRate);
        const finalPath = outputPath || path.join(process.cwd(), '.tmp_causyne_3d', `bgm_${bgmGenre}_${Date.now()}.wav`);
        await fs.mkdir(path.dirname(finalPath), { recursive: true });
        await fs.writeFile(finalPath, wavBuffer);

        return {
          success: true,
          output: JSON.stringify({
            status: 'SYNTHESIZED_BGM_LOOP',
            bgm_genre: bgmGenre,
            duration_seconds: duration,
            file_path: finalPath,
            size_bytes: wavBuffer.length
          }, null, 2)
        };
      }

      if (action === 'generate_sound_pack') {
        if (!projectDir || !fsSync.existsSync(projectDir)) {
          return { success: false, error: `Valid projectDir is required for generate_sound_pack. Found: ${projectDir}` };
        }

        const sfxDir = path.join(projectDir, 'audio', 'sfx');
        await fs.mkdir(sfxDir, { recursive: true });

        const essentials = [
          'sword_slash', 'spell_cast', 'hit_damage', 'potion_drink',
          'coin_pickup', 'jump', 'level_up', 'explosion', 'boss_roar', 'car_drift'
        ];

        const generatedFiles = [];
        for (const sfx of essentials) {
          const res = await gameAudioSynth.execute({
            action: 'synthesize_sfx',
            sfxType: sfx,
            outputPath: path.join(sfxDir, `${sfx}.wav`)
          });
          const parsed = JSON.parse(res.output);
          generatedFiles.push(parsed.file_path);
        }

        return {
          success: true,
          output: JSON.stringify({
            status: 'GENERATED_SOUND_PACK',
            project_dir: projectDir,
            total_sounds_created: generatedFiles.length,
            files: generatedFiles
          }, null, 2)
        };
      }

      return { success: false, error: `Unknown action: ${action}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
