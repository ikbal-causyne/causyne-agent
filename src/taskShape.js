

const PACK_SIGNALS = {
  game: {
    strong: ['game', 'gamedev', 'permainan', 'godot', 'unity', 'unreal', 'rpg', 'platformer', 'roguelike', 'arcade', 'voxel', 'minecraft', 'tilemap', 'spritesheet', 'boss fight', 'level design'],
    weak: ['sprite', 'player', 'enemy', 'quest', 'npc', 'gameplay', 'multiplayer', 'leaderboard']
  },
  web: {
    strong: ['web app', 'webapp', 'website', 'situs', 'landing page', 'homepage', 'frontend', 'front-end', 'dashboard', 'portfolio', 'react', 'vue', 'svelte', 'angular', 'nextjs', 'next.js', 'nuxt', 'astro', 'tailwind', 'html', 'css'],
    weak: ['web', 'ui', 'ux', 'page', 'halaman', 'responsive', 'browser', 'dom', 'component', 'layout', 'design', 'desain', 'tampilan']
  },
  media: {
    strong: ['generate image', 'generate video', 'generate music', 'text to speech', 'voiceover', 'blender', 'davinci', 'resolve', 'render', '3d model', 'animation', 'animasi'],
    weak: ['image', 'gambar', 'photo', 'foto', 'video', 'audio', 'sound', 'suara', 'music', 'musik', 'lagu', 'thumbnail', 'poster', 'logo', 'illustration']
  },
  system: {
    strong: ['kill process', 'port', 'zip', 'unzip', 'tar', 'archive', 'clipboard', 'printer', 'print', 'cetak'],
    weak: ['process', 'proses', 'compress', 'extract', 'ekstrak', 'open app', 'launch']
  },
  advanced: {
    strong: ['pdf', 'forge a tool', 'custom tool', 'subagent', 'sub-agent', 'parallel agent'],
    weak: ['symbols', 'ast', 'refactor', 'orchestrate', 'swarm']
  }
};

const STRONG_WEIGHT = 3;
const WEAK_WEIGHT = 1;
const PACK_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Task archetypes. Each one carries the phase plan the agent should follow and
// the tools that matter in each phase.
// ---------------------------------------------------------------------------

const ARCHETYPES = {
  integrate: {
    label: 'Build an application that integrates live external data',
    match: {
      strong: ['realtime', 'real-time', 'real time', 'api', 'rest', 'webhook', 'integration', 'integrasi', 'sync', 'sinkron', 'automation', 'automasi', 'otomasi', 'automate', 'otomatis', 'booking', 'tiket', 'ticket', 'calendar', 'kalender', 'jadwal', 'schedule', 'payment', 'pembayaran'],
      weak: ['live', 'stream', 'fetch', 'data', 'third party', 'oauth', 'token']
    },
    phases: [
      { name: 'Research the data sources FIRST', tools: ['web_search', 'web_fetch'], note: 'Identify the exact official REST APIs, their auth model, rate limits and response shape before writing any code. Prefer documented JSON APIs over browser scraping — reading JSON always beats reading DOM.' },
      { name: 'Verify access and versions', tools: ['sysRun', 'web_fetch'], note: 'Probe one real endpoint and check current package versions with `npm view <pkg> version` before pinning anything. Never assume a version from memory.' },
      { name: 'Scaffold', tools: ['fs_write', 'sysRun'], note: 'Create the project structure and dependency manifest.' },
      { name: 'Implement', tools: ['fs_read', 'fs_edit', 'MultiEdit'], note: 'Build the integration layer first, the UI second. Handle auth failures and rate limits explicitly.' },
      { name: 'Verify', tools: ['code_verify_syntax', 'sysRun'], note: 'Run the build, lint and type-check. Exercise the live data path end to end, not just the happy path.' }
    ]
  },
  build_app: {
    label: 'Build a new application from scratch',
    match: {
      strong: ['build me', 'buatkan', 'buat aku', 'create a', 'make me', 'bikin', 'develop a', 'new app', 'from scratch'],
      weak: ['app', 'aplikasi', 'project', 'proyek', 'tool', 'system', 'sistem']
    },
    phases: [
      { name: 'Plan', tools: ['TodoWrite'], note: 'Break the build into atomic, verifiable steps before touching the filesystem.' },
      { name: 'Scaffold', tools: ['fs_write', 'sysRun'], note: 'Create structure and install dependencies at verified current versions.' },
      { name: 'Implement', tools: ['fs_write', 'fs_edit', 'MultiEdit'], note: 'Write runnable code with every import and dependency present.' },
      { name: 'Verify', tools: ['code_verify_syntax', 'sysRun'], note: 'Build, lint and run it. Never assume code works.' }
    ]
  },
  debug: {
    label: 'Diagnose and fix a defect in existing code',
    match: {
      strong: ['bug', 'error', 'crash', 'fix', 'perbaiki', 'benerin', 'broken', 'rusak', 'not working', 'gagal', 'failing', 'exception', 'stack trace', 'regression'],
      weak: ['issue', 'masalah', 'problem', 'wrong', 'salah', 'debug']
    },
    phases: [
      { name: 'Reproduce', tools: ['sysRun', 'fs_read'], note: 'Reproduce the failure and capture the exact error before changing anything.' },
      { name: 'Locate', tools: ['code_search_ripgrep', 'codebase_search', 'fs_read'], note: 'Search several phrasings in parallel. Read the file before patching it.' },
      { name: 'Fix', tools: ['fs_edit', 'MultiEdit'], note: 'Make the smallest correct change. Do not touch unrelated code.' },
      { name: 'Verify', tools: ['sysRun', 'code_verify_syntax'], note: 'Confirm the original reproduction now passes.' }
    ]
  },
  research: {
    label: 'Investigate and report, without changing the system',
    match: {
      strong: ['explain', 'jelaskan', 'analyse', 'analyze', 'analisa', 'research', 'riset', 'compare', 'bandingkan', 'what is', 'apa itu', 'how does', 'bagaimana', 'review', 'audit'],
      weak: ['understand', 'pahami', 'find out', 'cari tahu', 'summarize', 'ringkas']
    },
    phases: [
      { name: 'Gather', tools: ['code_search_ripgrep', 'fs_read', 'web_search', 'web_fetch'], note: 'Search broadly with several phrasings in parallel before concluding.' },
      { name: 'Report', tools: [], note: 'Answer concisely and cite exact file paths or URLs. Do not modify anything unless asked.' }
    ]
  },
  maintain: {
    label: 'Operate on files, processes or the machine itself',
    match: {
      strong: ['organize', 'rapikan', 'clean up', 'bersihkan', 'rename', 'ganti nama', 'move', 'pindahkan', 'backup', 'cadangkan', 'delete', 'hapus', 'install', 'deploy', 'commit', 'merge'],
      weak: ['folder', 'directory', 'file', 'berkas', 'desktop', 'downloads']
    },
    phases: [
      { name: 'Survey', tools: ['fs_list', 'fs_find'], note: 'List and count what you are about to touch, and report it, before acting.' },
      { name: 'Act', tools: ['fs_move', 'fs_write', 'sysRun'], note: 'Prefer reversible operations. Flag anything destructive for approval.' },
      { name: 'Confirm', tools: ['fs_list'], note: 'Verify the end state matches what the user asked for.' }
    ]
  }
};

const ARCHETYPE_NAMES = Object.keys(ARCHETYPES);

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreSignals(text, signals) {
  let score = 0;
  const hits = [];

  for (const term of signals.strong || []) {
    if (text.includes(term)) {
      score += STRONG_WEIGHT;
      hits.push(term);
    }
  }
  for (const term of signals.weak || []) {
    // Word-boundary check for short weak terms so 'ui' cannot match 'build'
    // and 'race' cannot match 'trace' — the exact class of false positive that
    // used to drag ordinary tasks into game and web enforcement.
    const pattern = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'i');
    if (pattern.test(text)) {
      score += WEAK_WEIGHT;
      hits.push(term);
    }
  }

  return { score, hits };
}

/**
 * Analyse a request into the shape of the work it implies.
 *
 * @param {string} prompt
 * @param {object} workspaceContext  Optional perception output.
 * @returns {{
 *   archetype: string,
 *   archetypeLabel: string,
 *   packs: Array<{name: string, score: number}>,
 *   phases: Array<object>,
 *   confidence: string
 * }}
 */
export function analyzeTask(prompt, workspaceContext = null) {
  const text = String(prompt || '').toLowerCase();

  // Which capability packs are worth their token cost for this request.
  const packScores = [];
  for (const packName of Object.keys(PACK_SIGNALS)) {
    const { score } = scoreSignals(text, PACK_SIGNALS[packName]);
    if (score >= PACK_THRESHOLD) {
      packScores.push({ name: packName, score });
    }
  }

  // Workspace evidence outranks keywords: a Godot project on disk is far more
  // reliable than any phrasing in the prompt.
  if (workspaceContext) {
    const signals = [
      workspaceContext.framework,
      workspaceContext.projectType,
      workspaceContext.designSystem,
      Array.isArray(workspaceContext.keyFiles) ? workspaceContext.keyFiles.join(' ') : ''
    ].filter(Boolean).join(' ').toLowerCase();

    const bump = (name, amount) => {
      const existing = packScores.find(p => p.name === name);
      if (existing) existing.score += amount;
      else packScores.push({ name, score: amount });
    };

    if (/godot|project\.godot|unity|\.tscn/.test(signals)) bump('game', 5);
    if (/react|vue|svelte|next|nuxt|astro|angular|tailwind|vite|index\.html/.test(signals)) bump('web', 4);
  }

  packScores.sort((a, b) => b.score - a.score);

  // Which archetype the work follows.
  let bestArchetype = null;
  let bestScore = 0;
  for (const name of ARCHETYPE_NAMES) {
    const { score } = scoreSignals(text, ARCHETYPES[name].match);
    if (score > bestScore) {
      bestScore = score;
      bestArchetype = name;
    }
  }

  // A build request that also talks about live external data is an integration
  // job first and a build job second — that ordering is what stops the agent
  // scaffolding a UI before it knows whether the API even exists.
  const integrationScore = scoreSignals(text, ARCHETYPES.integrate.match).score;
  if (integrationScore >= STRONG_WEIGHT && bestArchetype === 'build_app') {
    bestArchetype = 'integrate';
    bestScore = integrationScore;
  }

  const archetype = bestArchetype || 'build_app';
  const confidence = bestScore >= 6 ? 'high' : (bestScore >= 3 ? 'medium' : 'low');

  return {
    archetype,
    archetypeLabel: ARCHETYPES[archetype].label,
    packs: packScores,
    phases: ARCHETYPES[archetype].phases,
    confidence
  };
}

/**
 * Render the analysis as a compact brief for the system prompt.
 *
 * This is the piece that turns "here are 28 tools" into "here is the order to
 * use them in". It costs roughly 150-200 tokens and routinely saves whole
 * exploratory steps, each of which costs thousands.
 */
export function buildTaskBrief(shape, availableToolNames) {
  if (!shape) return '';

  const available = new Set(availableToolNames || []);
  const lines = [];

  lines.push('# TASK SHAPE (analysed from your request)');
  lines.push(`Work type: ${shape.archetypeLabel}.`);
  lines.push('Follow this sequence. Do not skip ahead — each phase de-risks the next.');

  shape.phases.forEach((phase, index) => {
    const tools = (phase.tools || []).filter(name => available.has(name));
    const toolList = tools.length > 0 ? ` [${tools.join(', ')}]` : '';
    lines.push(`${index + 1}. ${phase.name}${toolList} — ${phase.note}`);
  });

  lines.push('Tools outside this list remain fully available; search for them with tool_search when a phase genuinely needs one.');

  return lines.join('\n');
}

/** Pack names above threshold, highest score first. */
export function packsFromShape(shape) {
  return shape && Array.isArray(shape.packs) ? shape.packs.map(p => p.name) : [];
}
