// Curated design data — the alternative to slop, not just the ban on it.
//
// The anti-slop directive in toolPacks.js has always told the model what NOT to
// do. Telling a model "no purple-to-blue gradients" without handing it something
// concrete is how you get the second-most-common gradient instead. This module
// is the positive half: real palettes and font pairings anchored to actual
// design movements, so "pick a movement and commit" has something to commit to.
//
// Plain data. No shell, no dependency, no eval.

/**
 * Palettes are stored as HSL triples because the playbook asks for HSL, and
 * because hue distance is what the detector reasons about.
 */
export const DESIGN_MOVEMENTS = [
  {
    id: 'swiss',
    name: 'Swiss / International Style',
    principles: 'Grid discipline, generous whitespace, flush-left ragged-right type, one accent only.',
    palette: { background: '#FFFFFF', surface: '#F2F2F2', ink: '#111111', accent: '#D40000', muted: '#767676' },
    fonts: { display: 'Helvetica Now, Inter, sans-serif', body: 'Inter, Helvetica, sans-serif' }
  },
  {
    id: 'brutalist',
    name: 'Brutalism',
    principles: 'Raw structure, visible borders, system type, high contrast, no rounded corners, no shadows.',
    palette: { background: '#E8E8E3', surface: '#FFFFFF', ink: '#000000', accent: '#0000EE', muted: '#5A5A55' },
    fonts: { display: 'Archivo Black, Impact, sans-serif', body: 'Courier New, monospace' }
  },
  {
    id: 'editorial',
    name: 'Editorial / Magazine',
    principles: 'Serif display at large sizes, multi-column rhythm, pull quotes, asymmetric layout.',
    palette: { background: '#FBF9F4', surface: '#FFFFFF', ink: '#1A1614', accent: '#8C2F1E', muted: '#6B625B' },
    fonts: { display: 'Playfair Display, Georgia, serif', body: 'Source Serif Pro, Georgia, serif' }
  },
  {
    id: 'japanese-minimal',
    name: 'Japanese Minimalism',
    principles: 'Ma (negative space) as the subject, muted naturals, hairline rules, restrained scale.',
    palette: { background: '#F7F5F0', surface: '#FFFFFF', ink: '#2B2B2B', accent: '#7B6C54', muted: '#9A9287' },
    fonts: { display: 'Noto Serif JP, Georgia, serif', body: 'Noto Sans JP, Inter, sans-serif' }
  },
  {
    id: 'bauhaus',
    name: 'Bauhaus',
    principles: 'Primary triad, geometric primitives, diagonal energy, function-first composition.',
    palette: { background: '#F4F1EA', surface: '#FFFFFF', ink: '#1C1C1C', accent: '#D62828', muted: '#003049' },
    fonts: { display: 'Futura, Poppins, sans-serif', body: 'Poppins, Inter, sans-serif' }
  },
  {
    id: 'terminal',
    name: 'Terminal / Retro-Computing',
    principles: 'Monospace throughout, phosphor accent on near-black, scanline restraint, ASCII rules.',
    palette: { background: '#0C0F0A', surface: '#131A11', ink: '#D6E5C8', accent: '#7FFF3F', muted: '#5C6B52' },
    fonts: { display: 'JetBrains Mono, monospace', body: 'IBM Plex Mono, monospace' }
  },
  {
    id: 'art-deco',
    name: 'Art Deco',
    principles: 'Symmetry, metallic accent on deep ground, stepped geometry, high-contrast display type.',
    palette: { background: '#10161F', surface: '#18202C', ink: '#EDE3D0', accent: '#C9A227', muted: '#6E7885' },
    fonts: { display: 'Poiret One, Didot, serif', body: 'Jost, Inter, sans-serif' }
  },
  {
    id: 'scandinavian',
    name: 'Scandinavian Minimal',
    principles: 'Warm off-white ground, pale wood neutrals, single desaturated accent, soft rounded geometry.',
    palette: { background: '#FAF8F5', surface: '#FFFFFF', ink: '#2E2A26', accent: '#6A8CAF', muted: '#A39C93' },
    fonts: { display: 'Outfit, Inter, sans-serif', body: 'Inter, system-ui, sans-serif' }
  }
];

/** A movement by id, or null. */
export function getMovement(id) {
  return DESIGN_MOVEMENTS.find(movement => movement.id === id) || null;
}

/**
 * Suggest movements the agent has NOT recently used.
 *
 * The creativePattern memory records what the last projects looked like; the
 * whole point of recording it is to deliberately diverge next time rather than
 * drifting back into one house style.
 */
export function suggestMovements(recentlyUsedIds = [], count = 3) {
  const used = new Set(recentlyUsedIds);
  const unused = DESIGN_MOVEMENTS.filter(movement => !used.has(movement.id));
  const pool = unused.length >= count ? unused : DESIGN_MOVEMENTS;
  return pool.slice(0, count);
}

/** A compact briefing the agent can be handed when its output scores as slop. */
export function formatMovementBrief(movements) {
  return movements.map(movement => {
    const palette = Object.entries(movement.palette).map(([role, hex]) => `${role} ${hex}`).join(', ');
    return `- ${movement.name}: ${movement.principles}\n  palette: ${palette}\n  type: ${movement.fonts.display} / ${movement.fonts.body}`;
  }).join('\n');
}
