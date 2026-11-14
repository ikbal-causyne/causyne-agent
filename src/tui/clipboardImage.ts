// Sovereign Cross-Platform Clipboard Image Reader & Attachment Manager.
// Captures screenshots and images pasted from system clipboard across macOS (osascript),
// Windows/WSL (PowerShell System.Windows.Forms), and Linux (wl-paste, xclip).
// Provides seamless multimodal image attachment for TUI prompt editors and slash commands.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { causyneHome, resolveUserPath } from '../utils/paths.js';

export interface ClipboardImageAttachment {
  type: 'image';
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  base64: string;
  name: string;
  path: string;
  size: number;
}

/**
 * Format bytes into readable string: '128 KB', '1.5 MB'.
 */
export function formatByteSize(bytes: number): string {
  const safe = Number.isFinite(bytes) ? Math.max(0, Math.floor(bytes)) : 0;
  if (safe < 1024) return `${safe} B`;
  if (safe < 1024 * 1024) return `${Math.round(safe / 1024)} KB`;
  return `${(safe / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Detect image mime type from binary magic bytes.
 */
export function detectImageMimeType(buffer: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | null {
  if (!buffer || buffer.length < 8) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF: 47 49 46 38
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'image/gif';
  }
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}

/**
 * Ensure the causyne attachments directory exists and return its path.
 */
export function getAttachmentsDirectory(): string {
  const dir = path.join(causyneHome(), 'attachments');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

/**
 * Save raw image buffer to persistent attachments directory and return attachment object.
 */
export function persistImageBuffer(
  buffer: Buffer,
  preferredName?: string
): ClipboardImageAttachment | null {
  const mimeType = detectImageMimeType(buffer);
  if (!mimeType) return null;

  const ext = mimeType === 'image/jpeg' ? 'jpg'
    : mimeType === 'image/webp' ? 'webp'
    : mimeType === 'image/gif' ? 'gif'
    : 'png';

  const timestamp = Date.now();
  const basePreferred = preferredName ? path.basename(preferredName.trim()) : '';
  const filename = basePreferred && basePreferred !== '.' && basePreferred !== '..'
    ? basePreferred
    : `screenshot_${timestamp}.${ext}`;

  const attachmentsDir = getAttachmentsDirectory();
  const filePath = path.join(attachmentsDir, filename);

  fs.writeFileSync(filePath, buffer, { mode: 0o600 });

  return {
    type: 'image',
    mimeType,
    base64: buffer.toString('base64'),
    name: filename,
    path: filePath,
    size: buffer.length
  };
}

/**
 * Read screenshot or image from macOS clipboard using built-in osascript.
 * Supports both PNG and JPEG image data placed on clipboard by macOS, browsers, and terminals.
 */
function readDarwinClipboardImageSync(): Buffer | null {
  const tempFile = path.join('/tmp', `causyne_clip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`);
  // Script uses standard AppleScript POSIX file API with safe error handling and file descriptor close guard
  const script = [
    'try',
    '  set imageData to (the clipboard as "PNGf")',
    `  set fileRef to open for access POSIX file "${tempFile}" with write permission`,
    '  set eof fileRef to 0',
    '  write imageData to fileRef',
    '  close access fileRef',
    '  return "ok"',
    'on error',
    '  try',
    `    close access (POSIX file "${tempFile}")`,
    '  end try',
    '  try',
    '    set imageData to (the clipboard as JPEG picture)',
    `    set fileRef to open for access POSIX file "${tempFile}" with write permission`,
    '    set eof fileRef to 0',
    '    write imageData to fileRef',
    '    close access fileRef',
    '    return "ok"',
    '  on error',
    '    try',
    `      close access (POSIX file "${tempFile}")`,
    '    end try',
    '    return ""',
    '  end try',
    'end try'
  ].join('\n');

  try {
    const res = spawnSync('osascript', ['-e', script], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true
    });
    if (res.status === 0 && res.stdout.trim() === 'ok' && fs.existsSync(tempFile)) {
      const buf = fs.readFileSync(tempFile);
      return buf.length > 0 ? buf : null;
    }
  } catch {
    // osascript clipboard read is best-effort
  } finally {
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch {
      // Ignore cleanup error
    }
  }
  return null;
}

/**
 * Read screenshot or image from Windows or WSL clipboard via PowerShell.
 */
function readWindowsClipboardImageSync(): Buffer | null {
  const command = process.platform === 'win32' ? 'powershell.exe' : 'powershell.exe';
  const psScript = 'Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [System.Convert]::ToBase64String($ms.ToArray()) }';

  try {
    const res = spawnSync(command, ['-NonInteractive', '-NoProfile', '-Command', psScript], {
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true
    });
    if (res.status === 0 && res.stdout) {
      const b64 = res.stdout.trim();
      if (b64.length > 0) {
        const buf = Buffer.from(b64, 'base64');
        return buf.length > 0 ? buf : null;
      }
    }
  } catch {
    // PowerShell clipboard image is best-effort
  }
  return null;
}

/**
 * Read screenshot or image from Linux clipboard via Wayland (wl-paste) or X11 (xclip).
 */
function readLinuxClipboardImageSync(): Buffer | null {
  // Try Wayland first
  try {
    const wl = spawnSync('wl-paste', ['-t', 'image/png'], {
      timeout: 2500,
      maxBuffer: 32 * 1024 * 1024
    });
    if (wl.status === 0 && Buffer.isBuffer(wl.stdout) && wl.stdout.length > 0) {
      return wl.stdout;
    }
  } catch {
    // Fall through to X11
  }

  // Try X11 xclip
  try {
    const xc = spawnSync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], {
      timeout: 2500,
      maxBuffer: 32 * 1024 * 1024
    });
    if (xc.status === 0 && Buffer.isBuffer(xc.stdout) && xc.stdout.length > 0) {
      return xc.stdout;
    }
  } catch {
    // Fall through
  }

  return null;
}

/**
 * Synchronously read screenshot or image from the system clipboard.
 * Returns ClipboardImageAttachment if an image is present, or null if none.
 */
export function readClipboardImageSync(): ClipboardImageAttachment | null {
  try {
    let buf: Buffer | null = null;
    if (process.platform === 'darwin') {
      buf = readDarwinClipboardImageSync();
    } else if (process.platform === 'win32' || (os.release().toLowerCase().includes('wsl'))) {
      buf = readWindowsClipboardImageSync();
    } else if (process.platform === 'linux') {
      buf = readLinuxClipboardImageSync();
    }

    if (buf && buf.length > 0) {
      return persistImageBuffer(buf);
    }
  } catch {
    // Non-throwing guard
  }
  return null;
}

/**
 * Clean up and extract a valid local file path from pasted text or drag-and-drop strings.
 * Strips quotes, file:// URIs, and backslash escape sequences.
 */
export function extractPastedFilePath(input: string): string {
  let raw = String(input ?? '').trim();
  // Strip surrounding quotes
  while (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    raw = raw.slice(1, -1).trim();
  }
  // Handle file:// URI
  if (raw.startsWith('file://')) {
    try {
      raw = fileURLToPath(raw);
    } catch {
      // ignore
    }
  }
  // Unescape backslash-escaped spaces/characters on Unix, and backslash-escaped spaces on Windows
  if (process.platform !== 'win32') {
    raw = raw.replace(/\\(.)/g, '$1');
  } else {
    raw = raw.replace(/\\ /g, ' ');
  }
  return raw;
}

const KNOWN_IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff', '.tif'
]);

/**
 * Check if a file path corresponds to an existing local image file.
 */
export function isLocalImageFile(rawPath: string): boolean {
  try {
    const cleaned = extractPastedFilePath(rawPath);
    if (!cleaned) return false;
    const resolved = resolveUserPath(cleaned);
    const ext = path.extname(resolved).toLowerCase();
    if (!KNOWN_IMAGE_EXTENSIONS.has(ext)) return false;
    if (!fs.existsSync(resolved)) return false;
    const stat = fs.statSync(resolved);
    return stat.isFile() && stat.size > 0 && stat.size <= 25 * 1024 * 1024;
  } catch {
    return false;
  }
}

/**
 * Load a local image file as an attachment (e.g. from /image or /attach command).
 */
export function loadLocalImageAttachment(rawPath: string): ClipboardImageAttachment | null {
  try {
    const cleaned = extractPastedFilePath(rawPath);
    if (!cleaned) return null;
    const resolved = resolveUserPath(cleaned);
    if (!fs.existsSync(resolved)) return null;
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > 25 * 1024 * 1024) return null; // 25 MB ceiling

    const buffer = fs.readFileSync(resolved);
    const mimeType = detectImageMimeType(buffer);
    if (!mimeType) return null;

    return {
      type: 'image',
      mimeType,
      base64: buffer.toString('base64'),
      name: path.basename(resolved),
      path: resolved,
      size: buffer.length
    };
  } catch {
    return null;
  }
}
