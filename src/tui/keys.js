// Keypress decoding — raw stdin bytes to named key events.
//
// `inquirer` gave the chat one blocking line of input and nothing else: no
// history, no completion, no way to type while the agent was working. Replacing
// it means owning the keyboard, and owning the keyboard starts here.
//
// This module is deliberately pure: bytes in, events out, no I/O and no state
// beyond the partial sequence still in flight. That is what makes it testable
// by feeding it the exact bytes a terminal sends.
//
// Pure Node. No dependency, no shell.

// Bracketed paste. Terminals wrap pasted text in these when we ask them to, and
// that is the only reliable way to tell "the user pressed Enter" apart from
// "the user pasted a block that happens to contain newlines".
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

// CSI parameter-1 modifier bitmask, minus one: 1=shift, 2=alt, 4=ctrl.
const MOD_SHIFT = 1;
const MOD_ALT = 2;
const MOD_CTRL = 4;

const CSI_FINAL_NAMES = {
  A: 'up', B: 'down', C: 'right', D: 'left',
  H: 'home', F: 'end', E: 'clear', Z: 'tab'
};

const CSI_TILDE_NAMES = {
  1: 'home', 2: 'insert', 3: 'delete', 4: 'end',
  5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end',
  11: 'f1', 12: 'f2', 13: 'f3', 14: 'f4', 15: 'f5',
  17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9', 21: 'f10',
  23: 'f11', 24: 'f12'
};

function makeKey(name, extra = {}) {
  return {
    name,
    ctrl: false,
    alt: false,
    shift: false,
    sequence: '',
    text: '',
    ...extra
  };
}

function applyModifier(key, modifier) {
  const bits = Number.isFinite(modifier) ? modifier - 1 : 0;
  if (bits & MOD_SHIFT) key.shift = true;
  if (bits & MOD_ALT) key.alt = true;
  if (bits & MOD_CTRL) key.ctrl = true;
  return key;
}

/**
 * How many bytes of a UTF-8 character start at `offset`, or 0 when the
 * character is cut short by the end of the buffer.
 *
 * A multi-byte character can straddle two stdin chunks. Decoding the buffer
 * eagerly would turn one emoji into two replacement characters, so the tail is
 * held back until the rest arrives.
 */
function utf8Length(buffer, offset) {
  const byte = buffer[offset];
  let needed = 1;
  if (byte >= 0xf0) needed = 4;
  else if (byte >= 0xe0) needed = 3;
  else if (byte >= 0xc0) needed = 2;
  return offset + needed <= buffer.length ? needed : 0;
}

/**
 * Decoder for one input stream.
 *
 * Holds only the bytes of a sequence that has not finished arriving. Everything
 * else is derived, so a decoder can be thrown away and remade at any time.
 */
export class KeyDecoder {
  constructor() {
    this.pending = Buffer.alloc(0);
    this.inPaste = false;
    this.pasteBuffer = '';
  }

  /** Feed a chunk; get back every complete key event it contained. */
  decode(chunk) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    this.pending = this.pending.length ? Buffer.concat([this.pending, incoming]) : incoming;

    const events = [];
    let offset = 0;

    while (offset < this.pending.length) {
      const consumed = this.step(this.pending, offset, events);
      // 0 means "the rest of this sequence has not arrived yet".
      if (consumed === 0) break;
      offset += consumed;
    }

    this.pending = this.pending.subarray(offset);
    return events;
  }

  /** Decode one event at `offset`. Returns bytes consumed, or 0 if incomplete. */
  step(buffer, offset, events) {
    // Inside a paste, everything is literal text until the closing marker. The
    // terminal guarantees the marker cannot appear in pasted content.
    if (this.inPaste) return this.stepPaste(buffer, offset, events);

    const byte = buffer[offset];

    if (byte === 0x1b) return this.stepEscape(buffer, offset, events);

    if (byte === 0x0d || byte === 0x0a) {
      events.push(makeKey('enter', { sequence: String.fromCharCode(byte) }));
      return 1;
    }
    if (byte === 0x7f || byte === 0x08) {
      events.push(makeKey('backspace', { sequence: String.fromCharCode(byte) }));
      return 1;
    }
    if (byte === 0x09) {
      events.push(makeKey('tab', { sequence: '\t' }));
      return 1;
    }

    // C0 controls are Ctrl+letter, with the handful above already claimed.
    if (byte < 0x20) {
      events.push(makeKey(String.fromCharCode(byte + 96), {
        ctrl: true,
        sequence: String.fromCharCode(byte)
      }));
      return 1;
    }

    const length = utf8Length(buffer, offset);
    if (length === 0) return 0;

    const text = buffer.toString('utf8', offset, offset + length);
    events.push(makeKey('char', { sequence: text, text }));
    return length;
  }

  stepPaste(buffer, offset, events) {
    const text = buffer.toString('utf8', offset);
    const end = text.indexOf(PASTE_END);

    if (end === -1) {
      // No terminator yet. Keep whole UTF-8 characters, hold back a split tail.
      let safe = buffer.length;
      while (safe > offset && utf8Length(buffer, safe - 1) === 0) safe--;
      // A partial terminator at the tail must not be swallowed as content.
      const chunk = buffer.toString('utf8', offset, safe);
      const keep = partialSuffixLength(chunk, PASTE_END);
      const usable = chunk.slice(0, chunk.length - keep);
      if (!usable) return 0;
      this.pasteBuffer += usable;
      return Buffer.byteLength(usable, 'utf8');
    }

    this.pasteBuffer += text.slice(0, end);
    this.inPaste = false;
    const pasted = this.pasteBuffer;
    this.pasteBuffer = '';
    events.push(makeKey('paste', { text: pasted, sequence: pasted }));
    return Buffer.byteLength(text.slice(0, end), 'utf8') + PASTE_END.length;
  }

  stepEscape(buffer, offset, events) {
    const remaining = buffer.length - offset;

    // A lone ESC at the end of a chunk is the Escape key. Terminals deliver
    // escape sequences atomically in practice, so waiting for more would make
    // Escape feel broken rather than making anything more correct.
    if (remaining === 1) {
      events.push(makeKey('escape', { sequence: '\x1b' }));
      return 1;
    }

    const next = buffer[offset + 1];

    if (next === 0x5b) return this.stepCSI(buffer, offset, events); // ESC [
    if (next === 0x4f) return this.stepSS3(buffer, offset, events); // ESC O

    // ESC + key is Alt+key. ESC ESC is Escape pressed twice.
    if (next === 0x1b) {
      events.push(makeKey('escape', { sequence: '\x1b' }));
      return 1;
    }
    if (next === 0x0d || next === 0x0a) {
      events.push(makeKey('enter', { alt: true, sequence: '\x1b\r' }));
      return 2;
    }
    if (next === 0x7f || next === 0x08) {
      events.push(makeKey('backspace', { alt: true, sequence: '\x1b\x7f' }));
      return 2;
    }

    // ESC + a control byte is Alt+Ctrl+letter.
    //
    // Without this the pair came out as a key literally NAMED \x15, which no
    // binding can match — so every ctrl+alt chord worked only under the kitty
    // keyboard protocol (`ESC [ 117 ; 7 u`) and silently did nothing in every
    // ordinary terminal. That is how the half-page scroll bindings shipped
    // firing on almost nobody.
    //
    // 0x00 is excluded: ctrl+space and ctrl+@ both send NUL and there is no way
    // to tell them apart, so naming it would be a guess.
    if (next > 0x00 && next < 0x20) {
      events.push(makeKey(String.fromCharCode(next + 96), {
        ctrl: true, alt: true, sequence: '\x1b' + String.fromCharCode(next)
      }));
      return 2;
    }

    const length = utf8Length(buffer, offset + 1);
    if (length === 0) return 0;
    const text = buffer.toString('utf8', offset + 1, offset + 1 + length);
    events.push(makeKey(text.toLowerCase(), { alt: true, sequence: '\x1b' + text }));
    return 1 + length;
  }

  stepCSI(buffer, offset, events) {
    // X10 mouse first, and from the RAW buffer.
    //
    // `ESC [ M Cb Cx Cy` carries three bytes that are offset by 32 and are
    // routinely >127 — i.e. not valid UTF-8. Decoding the buffer as UTF-8 first
    // would mangle them into replacement characters, and the generic CSI scan
    // below would stop at the `M`, consume three bytes and leave the other three
    // to be read as text the user never typed.
    //
    // We never ask for this encoding: mouseTracking() sends ?1006 alongside
    // ?1000. But a terminal that does not understand ?1006 silently ignores it
    // and answers in X10 anyway, and "silently ignores" is exactly the failure
    // mode UX-01 exists because of.
    if (buffer[offset + 2] === 0x4d && !this.inPaste) {
      return this.stepX10Mouse(buffer, offset, events);
    }

    const text = buffer.toString('utf8', offset);

    if (text.startsWith(PASTE_START)) {
      this.inPaste = true;
      this.pasteBuffer = '';
      return PASTE_START.length;
    }

    // A CSI sequence is ESC [ , parameters, then one final byte in @..~.
    let index = 2;
    while (index < text.length && !/[@-~]/.test(text[index])) index++;
    if (index >= text.length) return 0; // still arriving

    const final = text[index];
    const params = text.slice(2, index);
    const sequence = text.slice(0, index + 1);
    const numbers = params.split(/[;:]/).map((part) => parseInt(part, 10));

    // SGR mouse: ESC [ < b ; x ; y M|m. `<` is 0x3C, outside the @..~ final
    // range, so the scan above already found the right final byte.
    if ((final === 'M' || final === 'm') && params.startsWith('<')) {
      return this.emitMouse(params.slice(1).split(';').map((n) => parseInt(n, 10)),
        final === 'M', sequence, events);
    }

    if (final === '~') {
      const name = CSI_TILDE_NAMES[numbers[0]];
      if (name) {
        events.push(applyModifier(makeKey(name, { sequence }), numbers[1]));
        return sequence.length;
      }
    } else if (final === 'u') {
      // Kitty keyboard protocol: ESC [ codepoint ; modifiers u
      const codepoint = numbers[0];
      if (Number.isFinite(codepoint) && codepoint >= 32) {
        const character = String.fromCodePoint(codepoint);
        const key = applyModifier(
          makeKey('char', { sequence, text: character }),
          numbers[1]
        );
        // Ctrl+char is a command, not text — the caller must not insert it.
        if (key.ctrl || key.alt) key.text = '';
        if (key.name === 'char' && !key.text) key.name = character.toLowerCase();
        events.push(key);
        return sequence.length;
      }
    } else if (CSI_FINAL_NAMES[final]) {
      const key = applyModifier(
        makeKey(CSI_FINAL_NAMES[final], { sequence }),
        numbers.length > 1 ? numbers[1] : undefined
      );
      // ESC [ Z is Shift+Tab and carries no modifier parameter of its own.
      if (final === 'Z') key.shift = true;
      events.push(key);
      return sequence.length;
    }

    // Unknown but well-formed: consume it so it can never reach the buffer as
    // literal text and corrupt the line the user is editing.
    events.push(makeKey('unknown', { sequence }));
    return sequence.length;
  }

  stepX10Mouse(buffer, offset, events) {
    // ESC [ M plus exactly three bytes.
    if (buffer.length - offset < 6) return 0;
    const code = buffer[offset + 3] - 32;
    const column = buffer[offset + 4] - 32;
    const row = buffer[offset + 5] - 32;
    const sequence = buffer.toString('latin1', offset, offset + 6);
    this.emitMouse([code, column, row], true, sequence, events);
    return 6;
  }

  /**
   * One mouse report, in either encoding.
   *
   * Bit 6 of the button code marks a wheel event; the low two bits then give
   * the direction. Everything else is a click, which is emitted as an inert
   * `mouse` event rather than dropped: consuming it is what stops the bytes
   * reaching the line the user is editing, and naming it lets a caller act on
   * it later without another decoder change.
   */
  emitMouse(numbers, pressed, sequence, events) {
    const [code, column, row] = numbers;
    if (!Number.isFinite(code) || !Number.isFinite(column) || !Number.isFinite(row)) {
      events.push(makeKey('unknown', { sequence }));
      return sequence.length;
    }

    // Modifier bits live in the button code for mouse reports, not in a CSI
    // parameter, so applyModifier() does not apply here.
    const modifiers = {
      shift: (code & 4) !== 0,
      alt: (code & 8) !== 0,
      ctrl: (code & 16) !== 0
    };
    // Wire coordinates are 1-based.
    const at = { x: column - 1, y: row - 1 };

    if ((code & 64) !== 0) {
      const direction = ['up', 'down', 'left', 'right'][code & 3];
      // A wheel report arrives as a press; there is no release to pair it with.
      if (pressed) {
        events.push(makeKey('wheel', { sequence, ...modifiers, wheel: { direction, ...at } }));
        return sequence.length;
      }
    }

    events.push(makeKey('mouse', {
      sequence, ...modifiers,
      mouse: { button: code & 3, pressed, ...at }
    }));
    return sequence.length;
  }

  stepSS3(buffer, offset, events) {
    if (buffer.length - offset < 3) return 0;
    const final = buffer.toString('utf8', offset + 2, offset + 3);
    const name = CSI_FINAL_NAMES[final] || { P: 'f1', Q: 'f2', R: 'f3', S: 'f4' }[final];
    events.push(makeKey(name || 'unknown', { sequence: '\x1bO' + final }));
    return 3;
  }
}

/**
 * Length of the longest suffix of `text` that is a prefix of `marker`.
 *
 * A paste terminator can be split across two chunks; without this the leading
 * bytes of the terminator would be appended to the pasted text as content and
 * the terminator would then never match.
 */
function partialSuffixLength(text, marker) {
  const max = Math.min(text.length, marker.length - 1);
  for (let length = max; length > 0; length--) {
    if (marker.startsWith(text.slice(text.length - length))) return length;
  }
  return 0;
}

/**
 * Turn mouse reporting on/off.
 *
 * ?1000 is button press/release reporting, which is what carries the wheel.
 * ?1006 asks for SGR encoding so the coordinates are decimal parameters rather
 * than three offset bytes that break past column 223.
 *
 * DELIBERATELY NOT ?1002 (button-drag) or ?1003 (any motion). opencode enables
 * both and needs OPENCODE_DISABLE_MOUSE as an escape hatch because of it. Causyne
 * offers no in-app selection or hover, so it has no reason to ask for drag
 * reports, and not asking is the difference between a terminal that can still
 * mostly be dragged over and one that cannot be at all.
 *
 * Be precise about what this does NOT buy: ?1000 still reports the click
 * itself, and several terminals respond to any mouse reporting by putting their
 * own selection behind a modifier (Option in iTerm2 and Terminal.app, Shift in
 * most X11 terminals). This narrows the damage; it does not remove it. That is
 * what CAUSYNE_MOUSE=0 is for, and why it is documented rather than buried.
 *
 * There is no mode that reports the wheel alone. UX-02.
 */
export function mouseTracking(enabled) {
  return enabled ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1006l\x1b[?1000l';
}

/** Turn bracketed paste on/off. Paired with the editor's lifecycle. */
export function bracketedPaste(enabled) {
  return enabled ? '\x1b[?2004h' : '\x1b[?2004l';
}

/**
 * True when `event` is the plain printable character `letter`.
 *
 * THE BUG THIS EXISTS TO PREVENT — and it shipped:
 *
 * A printable key does NOT decode to its own name. `y` produces
 * `{ name: 'char', text: 'y' }`, because the decoder reserves `name` for keys
 * that have no character (escape, up, enter) and puts the character in `text`.
 * Only MODIFIED letters get their letter as a name: ctrl+c is
 * `{ name: 'c', ctrl: true }`, alt+b is `{ name: 'b', alt: true }`.
 *
 * That asymmetry is easy to get wrong from the outside, and the approval
 * dialog got it wrong: it tested `event.name === 'y'`, which is true for
 * ctrl+y and false for y. So the y/n keys on the one modal that gates every
 * dangerous action in the product did nothing at all, silently — every
 * keypress fell through to the layer's `default:` branch and was swallowed.
 * Escape still worked, because escape genuinely is named 'escape', which made
 * the dialog look responsive while being impossible to approve.
 *
 * Anything comparing a bare letter must come through here.
 *
 * @param   {object} event   A decoded key event.
 * @param   {string} letter  Single character to test, case-insensitive.
 * @returns {boolean}
 */
export function isChar(event, letter) {
  if (!event || event.ctrl || event.alt || event.meta) return false;
  const typed = typeof event.text === 'string' && event.text.length > 0
    ? event.text
    : (event.name && event.name.length === 1 ? event.name : '');
  return typed.toLowerCase() === String(letter).toLowerCase();
}
