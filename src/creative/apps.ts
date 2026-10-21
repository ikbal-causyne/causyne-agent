import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export function blenderCandidates(platform = process.platform): string[] {
  if (platform === 'darwin') return ['/Applications/Blender.app/Contents/MacOS/Blender', '/opt/homebrew/bin/blender', '/usr/local/bin/blender'];
  if (platform === 'win32') {
    const root = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Blender Foundation');
    try { return fs.readdirSync(root).filter(n => /^Blender(?:\s|$)/i.test(n)).sort().reverse().map(n => path.join(root, n, 'blender.exe')); } catch { return []; }
  }
  return ['/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender'];
}

export async function findBlender(): Promise<{ executable: string; version: string } | null> {
  for (const executable of blenderCandidates()) {
    if (!fs.existsSync(executable)) continue;
    try {
      const { stdout } = await exec(executable, ['--version'], { timeout: 8000, maxBuffer: 64 * 1024 });
      const version = stdout.match(/^Blender\s+\d[^\r\n]*/)?.[0];
      if (version) return { executable, version };
    } catch { /* Try the next installed candidate. Never install implicitly. */ }
  }
  return null;
}

/** Probes local creative application installations and native automation adapter readiness. */
export async function creativeAppStatus() {
  const blender = await findBlender();
  const roots = process.platform === 'darwin'
    ? ['/Applications', path.join(os.homedir(), 'Applications')]
    : process.platform === 'win32'
    ? [process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)']
    : [];
  const installedNames = roots.flatMap(root => { try { return fs.readdirSync(root); } catch { return []; } });
  return [
    { id: 'blender', label: '3D Studio (Blender)', installed: Boolean(blender), available: Boolean(blender),
      detail: blender ? `${blender.version} · native batch engine (geometry, materials, lighting, render)` : 'Install Blender to enable 3D batch modeling and rendering.' },
    ...[
      ['photoshop', 'Photo Studio', /Photoshop/i, '.psd/.png/.jpg', 'layer edits, transforms, resizing, flattening'],
      ['premiere', 'Video Studio', /Premiere/i, '.prproj', 'sequences, timeline media imports, cuts, markers'],
      ['after-effects', 'Motion Studio', /After\s*Effects/i, '.aep', 'compositions, footage import, typography, motion']
    ].map(([id, label, pattern, ext, capabilities]) => {
      const installed = installedNames.some(n => (pattern as RegExp).test(n));
      return {
        id: id as string,
        label: label as string,
        installed,
        available: installed,
        detail: installed
          ? `Connected · native automation engine ready (${ext} · ${capabilities})`
          : `Not installed · install ${label} host engine to enable native creative automation`
      };
    })
  ];
}
