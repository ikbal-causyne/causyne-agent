// The banner: the wordmark, and the first thing a new user is invited to ask.
//
// This lives in its own module because it is written ONCE, straight into the
// user's real terminal history, before anything else runs — the same shape
// openclaw uses (src/cli/banner.ts emitCliBanner: art first, metadata line
// underneath) and opencode's entry splash, whose own comment calls these
// "scrollback snapshots ... immutable terminal history once committed".
//
// Nothing here repaints. Nothing here clears. See UX-01 in .agents/rules.json.
//
// Pure Node over theme.js and text.js. No dependency, no shell.

import { paint, bold, dim, GLYPHS, HAS_UNICODE } from './theme.js';
import { visibleWidth, truncate, padEnd, shortenHome } from './text.js';

// Painted through the theme rather than with a hardcoded \x1b[1m\x1b[36m, so it
// still obeys NO_COLOR and still degrades on a terminal without box-drawing.
const WORDMARK = [
  ' ████   ███  █   █  ████ █   █ █   █ █████',
  '█      █   █ █   █ █      █ █  ██  █ █    ',
  '█      █████ █   █  ███    █   █ █ █ ████ ',
  '█      █   █ █   █     █   █   █  ██ █    ',
  ' ████  █   █  ███  ████    █   █   █ █████'
];

// A terminal without box-drawing support would render the art as mojibake, so
// it gets the wordmark spelled out instead of a field of question marks.
const WORDMARK_PLAIN = ['C A U S Y N E'];

/**
 * The banner rows.
 *
 * `unicode` is overridable so both branches can actually be tested — under
 * `node --test` there is no TTY, so HAS_UNICODE is false and the block art would
 * never be exercised at all.
 */
export function wordmark(width = 80, { unicode = HAS_UNICODE } = {}) {
  const art = (unicode && width >= 54) ? WORDMARK : WORDMARK_PLAIN;
  const rows = art.map((line) => paint('accent', line));
  rows.push('');
  rows.push(dim('Causyne AI Agent'));
  return rows;
}

/**
 * The session header: the wordmark and the session facts, SIDE BY SIDE.
 *
 * This used to be three stacked blocks — six rows of art, then a blank, then a
 * bordered panel of four label/value rows, then two separate hint lines. Nineteen
 * rows of chrome before the user could type a character, on a surface whose whole
 * job is to get out of the way.
 *
 * Neither reference does that. claude-code sets its art in the left column with
 * the version, model, plan and directory stacked beside it — three rows, one
 * block. opencode puts the logo alone and the facts in the prompt box. The
 * common property is that the identity and the facts are ONE object, not a
 * sequence of them.
 *
 * Falls back to stacking when the terminal cannot hold both columns, because a
 * header that wraps is worse than a header that is tall.
 */
export function sessionBanner(info = {}, width = 80, { unicode = HAS_UNICODE } = {}) {
  const art = (unicode && width >= 54) ? WORDMARK : WORDMARK_PLAIN;
  const artWidth = Math.max(...art.map(visibleWidth));

  const facts = [];
  if (info.version) facts.push([bold(paint('accent', 'Causyne')), dim(info.version)]);
  const model = info.model || 'no model configured';
  facts.push([paint('ink', model), info.provider ? dim(providerLabel(info.provider)) : '']);
  const mode = [info.autonomyMode ? `mode ${info.autonomyMode}` : '', info.tier ? `tier ${info.tier}` : '']
    .filter(Boolean).join(`  ${GLYPHS.dot}  `);
  if (mode) facts.push([dim(mode), '']);
  if (info.workspace) facts.push([dim(shortenHome(info.workspace)), '']);

  const GAP = 4;
  // The spare column is the same one the stacked branch below already reserves
  // (`width - 1`). Without it a full-width fact row lands in the terminal's
  // deferred-wrap state: the cursor sits past the last column, and the next
  // write decides whether that becomes a wrap. Measured on an 80-column pty,
  // the workspace row came back at exactly 80 while every other row was 79.
  const room = width - artWidth - GAP - 1;

  // Not enough width for two columns: stack, rather than wrap either one.
  if (room < 24) {
    return art.map((line) => paint('accent', line))
      .concat([''], facts.map(([left, right]) =>
        truncate(right ? `${left}  ${right}` : left, width - 1, GLYPHS.ellipsis)));
  }

  const rows = [];
  const height = Math.max(art.length, facts.length);
  for (let index = 0; index < height; index++) {
    const artLine = art[index] === undefined ? '' : paint('accent', art[index]);
    const fact = facts[index];
    const left = padEnd(artLine, artWidth) + ' '.repeat(GAP);
    if (!fact) { rows.push(artLine); continue; }
    const [primary, secondary] = fact;
    const text = secondary ? `${primary}  ${secondary}` : primary;
    rows.push(left + truncate(text, room, GLYPHS.ellipsis));
  }
  return rows;
}

/**
 * Display the provider the way the user wrote it, normalised for casing only.
 *
 * Causyne is BYOK: the provider is whatever the user configured, and nothing here
 * may assume or default to one. A config saying `Gemini` and one saying `gemini`
 * are the same provider and must read the same.
 */
export function providerLabel(provider) {
  const raw = String(provider || '').trim();
  if (!raw) return '';
  const KNOWN = {
    openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', ollama: 'Ollama',
    deepseek: 'DeepSeek', dashscope: 'DashScope', 'dashscope-byok': 'DashScope',
    qwen: 'Qwen', xai: 'xAI', grok: 'xAI', moonshot: 'Moonshot', kimi: 'Moonshot',
    muse: 'Meta', meta: 'Meta',
    'openai-compatible': 'OpenAI-compatible'
  };
  return KNOWN[raw.toLowerCase()] || raw;
}

// What to ask, for the person who has just opened this for the first time.
//
// `ask anything` is an invitation, not an example — it tells a new user nothing
// about what this agent can actually be asked to do. Both references show a
// concrete prompt instead (opencode seeds a random one per launch from
// routes/home.tsx). One is picked per session so the hint does not churn while
// the user is reading it.
export const EXAMPLES = [
  'summarise what changed in this repo today',
  'find every TODO left in src/ and group them by file',
  'explain what this project does and how it is wired',
  'run the tests and tell me what broke',
  'review my last commit for anything risky'
];

/** One example, chosen per session rather than per keystroke. */
export function pickExample() {
  return EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)];
}

/**
 * Join hint fragments, dropping the least important until the line fits.
 *
 * Same policy as the footer: a hint clipped mid-word reads as a bug, so drop
 * whole fragments rather than truncate one, and fall back entirely when even a
 * single fragment will not fit.
 */
export function fitHints(parts, width, fallback) {
  const separator = `  ${GLYPHS.dot}  `;
  const kept = parts.slice();
  while (kept.length > 1 && visibleWidth(kept.join(separator)) > width) kept.pop();
  const line = kept.join(separator);
  // A narrow terminal must not get `try "review my last commit for anything r`.
  return visibleWidth(line) <= width ? line : fallback;
}
