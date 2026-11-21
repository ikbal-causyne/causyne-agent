// Causyne TUI — terminal input framing and atomic unbracketed paste classification.
// Keep this module free of side effects so terminal sequences can be tested
// without a PTY. It does not decode keys, move the cursor, or execute commands.

export const INPUT_PREFIX_TIMEOUT_MS = 40;

export interface DecoderLike {
  inPaste?: boolean;
  pending?: { length: number } | null;
}

/**
 * Hold a trailing ESC or '[' long enough for a following stdin chunk to complete
 * a CSI/mouse report. Without this, the original KeyDecoder treats standalone
 * ESC as a key immediately; its following '[<...M' chunk can be pasted as text.
 *
 * Ordinary characters are released immediately, with at most one trailing
 * byte delayed. The delay is deliberately bounded by ChatPrompt's timer.
 */
export class TerminalInputFramer {
  pending: Buffer;

  constructor() {
    this.pending = Buffer.alloc(0);
  }

  get hasPending(): boolean {
    return this.pending.length !== 0;
  }

  push(input: Buffer | string | null | undefined): Buffer[] {
    if (input == null) return [];
    const incoming = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
    if (incoming.length === 0) return [];
    const bytes = this.pending.length ? Buffer.concat([this.pending, incoming]) : incoming;
    this.pending = Buffer.alloc(0);
    const end = bytes[bytes.length - 1];
    // '[' may be a literal character or the first byte of an orphaned SGR
    // mouse report. Only one byte is held, so the editor is never blocked by
    // a multi-kilobyte prefix buffer outside KeyDecoder.
    if (end === 0x1b || end === 0x5b) {
      const heldLength = end === 0x5b && bytes.length >= 2 && bytes[bytes.length - 2] === 0x1b ? 2 : 1;
      this.pending = Buffer.from(bytes.subarray(-heldLength));
      return bytes.length > heldLength ? [bytes.subarray(0, -heldLength)] : [];
    }
    return [bytes];
  }

  flush(): Buffer[] {
    const value = this.pending;
    this.pending = Buffer.alloc(0);
    // An incomplete ESC[ is not a printable character and should never be
    // handed to KeyDecoder's CSI state forever after the timeout expires.
    if (value.length === 2 && value[0] === 0x1b && value[1] === 0x5b) return [];
    return value.length ? [value] : [];
  }

  clear(): void {
    this.pending = Buffer.alloc(0);
  }
}

const MOUSE_CSI = /\x1b\[<\d{1,6};\d{1,6};\d{1,6}[Mm]/;
const ORPHAN_MOUSE = /\[<\d{1,6};\d{1,6};\d{1,6}[Mm]/;
const MOUSE_TAIL = /(?:^|[Mm])<\d{1,6};\d{1,6};\d{1,6}[Mm]/;
const BRACKETED = /\x1b\[(?:200|201)~/;
// Only SGR color/control formatting is permitted in an ANSI log pasted as
// one atomic block; actual cursor and mouse sequences must go to KeyDecoder.
const SGR = /\x1b\[[0-9;]*m/g;

/**
 * Avoid bypassing an incomplete key or mouse sequence with the 'large chunk =
 * paste' heuristic. Allow bulk pasted ANSI-colored logs, which an existing
 * regression test expects to arrive as a single multiline editor insertion.
 */
const MAX_ATOMIC_PASTE_BYTES = 2 * 1024 * 1024;

export function shouldTreatAsAtomicPaste(raw: Buffer | Uint8Array | string | null | undefined, decoder?: DecoderLike | null): boolean {
  if (raw == null) return false;
  if (typeof raw === 'string' ? raw.length > MAX_ATOMIC_PASTE_BYTES : raw.byteLength > MAX_ATOMIC_PASTE_BYTES) return false;
  let text: string;
  if (typeof raw === 'string') text = raw;
  else {
    // Classifying an incomplete UTF-8 byte stream as a bulk paste would
    // replace a split emoji with U+FFFD. Let KeyDecoder buffer its tail.
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
    catch { return false; }
  }
  if (!text) return false;
  if (decoder?.inPaste || (decoder?.pending?.length ?? 0) > 0) return false;
  if (BRACKETED.test(text) || MOUSE_CSI.test(text) || ORPHAN_MOUSE.test(text) || MOUSE_TAIL.test(text)) return false;
  const hasNewline = text.includes('\n') || text.includes('\r');
  const big = text.length >= 64;
  if (!big && !(hasNewline && text.length > 2)) return false;
  if (text.includes('\x1b') || text.includes('\u009b')) {
    // Colorized terminal output can be pasted without submitting each line.
    // All control sequences must be complete SGR, with no other escapes.
    const withoutColor = text.replace(SGR, '');
    return hasNewline && !/[\x1b\u009b]/.test(withoutColor);
  }
  return hasNewline || big;
}

/** Display a short, non-sensitive paste notification (not the pasted content). */
export function pasteSummary(text: unknown): string {
  const normalized = String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = 1 + (normalized.match(/\n/g)?.length ?? 0);
  const size = Buffer.byteLength(normalized, 'utf8');
  const sizeLabel = size >= 1024 ? `${Math.round(size / 1024)} KiB` : `${size} B`;
  return `pasted ${lines} ${lines === 1 ? 'line' : 'lines'} · ${sizeLabel}`;
}
