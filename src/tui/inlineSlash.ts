/**
 * Slash completion framing for the Causyne chat composer.
 *
 * This is intentionally a lexical, zero-model operation. It never executes a
 * command. Only an explicit picker selection can hand a command to ChatPrompt.
 * Existing command dispatch keeps its beginning-of-input parser unchanged.
 */

export type SlashTrigger =
  | {
      readonly kind: 'command';
      readonly query: string;
      readonly start: number;
      readonly tokenStart: number;
      readonly inline: boolean;
    }
  | {
      readonly kind: 'command-argument';
      readonly command: string;
      readonly query: string;
      readonly start: number;
      readonly tokenStart: number;
      readonly inline: boolean;
    };

export interface RemovedSlashToken {
  readonly text: string;
  readonly cursor: number;
}

const ARGUMENT = /(?:^|[ \t\r\n])\/([a-z0-9_?-]+)[ \t]+([^\s]*)$/i;
const COMMAND = /(?:^|[ \t\r\n])\/([a-z0-9_?-]*)$/i;

/**
 * Find a complete slash prefix at the caret, even when other prose precedes it.
 * A slash must start a whitespace-delimited token: URLs, division, and paths
 * with inner slashes do not open the command menu.
 *
 * Offsets are UTF-16 code units, which is the existing completion.js contract.
 */
export function detectInlineSlashTrigger(text: string, cursor: number): SlashTrigger | null {
  if (typeof text !== 'string' || !Number.isFinite(cursor)) return null;
  if (cursor < 0 || cursor > text.length) return null;

  const before = text.slice(0, cursor);
  const argument = ARGUMENT.exec(before);
  if (argument) {
    const fragment = argument[0];
    const offset = cursor - fragment.length + fragment.indexOf('/');
    const query = argument[2] ?? '';
    return {
      kind: 'command-argument',
      command: argument[1] ?? '',
      query,
      start: cursor - query.length,
      tokenStart: offset,
      inline: before.slice(0, offset).trim().length > 0
    };
  }

  const command = COMMAND.exec(before);
  if (!command) return null;
  const fragment = command[0];
  const offset = cursor - fragment.length + fragment.indexOf('/');
  return {
    kind: 'command',
    query: command[1] ?? '',
    start: offset,
    tokenStart: offset,
    inline: before.slice(0, offset).trim().length > 0
  };
}

/**
 * Remove the command token, NOT the surrounding draft.
 * An editor caret can sit in the middle of a token. In that case, remove the
 * untyped suffix of the same token too, stopping at the following whitespace.
 */
export function removeInlineSlashToken(
  text: string,
  cursor: number,
  trigger: SlashTrigger
): RemovedSlashToken {
  if (typeof text !== 'string' || !Number.isFinite(cursor)) {
    throw new TypeError('Invalid inline command text or cursor');
  }
  const position = Math.trunc(cursor);
  const start = trigger.tokenStart;
  if (!Number.isInteger(start) || start < 0 || start >= text.length ||
      position < start || position > text.length || text[start] !== '/') {
    throw new RangeError('Stale inline command selection');
  }
  const actual = text.slice(start, position);
  if (trigger.kind === 'command') {
    if (actual !== `/${trigger.query}`) {
      throw new RangeError('Stale inline command selection');
    }
  } else {
    const argument = /^\/([a-z0-9_?-]+)[ \t]+([^\s]*)$/i.exec(actual);
    if (!argument || argument[1] !== trigger.command || argument[2] !== trigger.query) {
      throw new RangeError('Stale inline command selection');
    }
  }
  const suffix = text.slice(position);
  const trailingToken = trigger.kind === 'command'
    ? /^[a-z0-9_?-]*/i.exec(suffix)?.[0] ?? ''
    : /^[^\s]*/.exec(suffix)?.[0] ?? '';
  const end = position + trailingToken.length;
  return {
    text: text.slice(0, start) + text.slice(end),
    cursor: start
  };
}

/**
 * Compiled-skill menu entries are the only commands that consume the current
 * draft as their task instruction. Management commands keep the draft intact.
 */
export function isInlineSkillInvocation(command: string): boolean {
  return /^\/skills\s+[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(command);
}
