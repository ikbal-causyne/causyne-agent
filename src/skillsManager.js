import fs from 'fs';
import path from 'path';

import { COMPILED_SKILLS } from './compiledSkills.js';
import { loadUserSkills } from './userSkills.js';

// User skills are read from disk, and the disk is slow relative to how often
// these functions are called (every completion keystroke asks for the
// catalogue). Cache for a moment so typing stays instant, but keep the window
// short enough that a skill the agent just wrote shows up without a restart.
const USER_CACHE_MS = 2000;
let userCache = { at: 0, skills: [], problems: [] };

export function invalidateUserSkills() {
  userCache = { at: 0, skills: [], problems: [] };
}

function userSkills() {
  const now = Date.now();
  if (now - userCache.at < USER_CACHE_MS) return userCache;
  try {
    const loaded = loadUserSkills();
    userCache = { at: now, skills: loaded.skills, problems: loaded.problems };
  } catch (e) {
    // A broken skills directory must never stop a session from starting.
    userCache = { at: now, skills: [], problems: [`user skills unavailable: ${e.message}`] };
  }
  return userCache;
}

export function userSkillProblems() {
  return userSkills().problems;
}

// What a workspace looks like from the outside.
//
// This used to name four domains, which meant that of the compiled skills only
// android, web, python and devops could EVER be surfaced — every other one was
// compiled into the artefact and unreachable. Detection is what decides whether
// a skill exists as far as the model is concerned.
//
// Marker files only; no globbing and no directory walking, so detection stays a
// handful of stat calls whatever the size of the repository.
const DOMAIN_INDICATORS = {
  android: ['build.gradle', 'build.gradle.kts', 'app/build.gradle', 'app/build.gradle.kts',
            'app/src/main/AndroidManifest.xml', 'settings.gradle.kts', 'gradlew'],
  mobile: ['pubspec.yaml', 'ios/Podfile', 'Podfile', 'app.json', 'metro.config.js',
           'react-native.config.js', 'expo.json'],
  web: ['next.config.js', 'next.config.mjs', 'next.config.ts', 'nuxt.config.ts',
        'svelte.config.js', 'vue.config.js', 'astro.config.mjs', 'vite.config.js',
        'vite.config.ts', 'angular.json', 'index.html', 'tailwind.config.js'],
  backend: ['package.json', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.sbt',
            'Gemfile', 'composer.json', 'nest-cli.json'],
  python: ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'setup.cfg',
           'uv.lock', 'poetry.lock', 'environment.yml'],
  devops: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', '.github/workflows',
           '.gitlab-ci.yml', 'Jenkinsfile', 'Makefile', '.circleci/config.yml'],
  cloud: ['main.tf', 'terraform.tf', 'serverless.yml', 'template.yaml', 'Pulumi.yaml',
          'cdk.json', 'k8s', 'kubernetes', 'helm', 'skaffold.yaml'],
  database: ['prisma/schema.prisma', 'migrations', 'alembic.ini', 'knexfile.js',
             'schema.sql', 'db/schema.rb', 'drizzle.config.ts', 'flyway.conf'],
  testing: ['jest.config.js', 'jest.config.ts', 'vitest.config.ts', 'playwright.config.ts',
            'cypress.config.js', 'pytest.ini', 'tox.ini', 'tests', 'test', '__tests__'],
  security: ['.github/dependabot.yml', 'SECURITY.md', '.snyk', 'socket.yml', 'socket.json'],
  design: ['tailwind.config.js', 'tailwind.config.ts', 'styles', 'src/styles',
           'theme.js', 'theme.ts', 'tokens.json', 'postcss.config.js'],
  // A 3D/video workspace. Without a rule here the media skills compile into
  // the artefact and are unreachable by domain detection — tool_search still
  // finds them, but the workspace never volunteers them.
  media: ['.blend', 'assets/3d', 'renders', 'blender', 'shots', 'Resolve Projects'],
  git: ['.git', '.gitignore', '.gitattributes'],
  performance: ['lighthouserc.js', 'lighthouserc.json', '.lighthouserc.yml', 'k6.js',
                'benchmark', 'benchmarks'],
  'ai-engineering': ['.env.example', 'prompts', 'evals', 'langchain.json',
                     'llm.config.js', 'openai.json'],
  data: ['dbt_project.yml', 'airflow.cfg', 'dags', 'notebooks', '*.ipynb',
         'dvc.yaml', 'great_expectations']
};

// Domains that apply to every task regardless of what the workspace looks like.
//
// Design and security are not properties of a file layout — an agent writing a
// UI needs the anti-slop direction whether or not a tailwind config exists, and
// input validation matters whether or not the repository has a SECURITY.md.
const UNIVERSAL_DOMAINS = ['design', 'security'];

// Ceiling on how many skill descriptions may enter the system prompt.
//
// With 100 skills, injecting every description of every detected domain would
// spend thousands of tokens on an index before the task has even been read.
// This is the progressive-disclosure contract: the model sees names and routing
// conditions, and pulls a body with fs_read_skill only when one is relevant.
const MAX_INDEXED_SKILLS = 40;

export function detectWorkspaceDomains(workspaceRoot) {
  if (!workspaceRoot || !fs.existsSync(workspaceRoot)) return UNIVERSAL_DOMAINS.slice();

  const detectedDomains = [];

  for (const [domain, indicators] of Object.entries(DOMAIN_INDICATORS)) {
    for (const indicator of indicators) {
      // A glob marker means "any file with this extension at the root". Kept to
      // one readdir rather than a walk — a recursive search of a large monorepo
      // on every task start is not worth one extra domain.
      if (indicator.startsWith('*.')) {
        try {
          const extension = indicator.slice(1);
          if (fs.readdirSync(workspaceRoot).some((name) => name.endsWith(extension))) {
            detectedDomains.push(domain);
            break;
          }
        } catch (e) { /* unreadable directory is simply not a match */ }
        continue;
      }
      if (fs.existsSync(path.join(workspaceRoot, indicator))) {
        detectedDomains.push(domain);
        break;
      }
    }
  }

  for (const domain of UNIVERSAL_DOMAINS) {
    if (!detectedDomains.includes(domain)) detectedDomains.push(domain);
  }

  return detectedDomains;
}

export { MAX_INDEXED_SKILLS, UNIVERSAL_DOMAINS };

export function ensureSkillRepo(domain) {
  
  if (COMPILED_SKILLS[domain]) {
    return true;
  }
  return false;
}

/**
 * The index the model sees: names and routing conditions, never bodies.
 *
 * Progressive disclosure. 100 skills is roughly 250 KB of markdown; injecting it
 * would consume the context window before the task was read. What goes in is one
 * line per skill — the name and WHEN TO USE IT — and the model pulls the body
 * with fs_read_skill only for the one it needs. This is the same contract
 * claude-code and openclaw use, and it is what makes a large skill library
 * possible at all.
 *
 * Capped at MAX_INDEXED_SKILLS. A workspace matching eight domains would
 * otherwise inject fifty-odd descriptions; the detected domains come first so
 * the cut falls on the least relevant.
 */
export function getUniversalSkillsIndex(domains) {
  let indexText = '';
  let totalSkillsCount = 0;

  // One catalogue, so a user skill is as visible to the agent as a compiled one.
  const catalogue = new Map();
  for (const skill of listCompiledSkills()) {
    if (!catalogue.has(skill.domain)) catalogue.set(skill.domain, []);
    catalogue.get(skill.domain).push(skill);
  }

  // A user's own domains are always offered: someone who wrote a `team/` skill
  // wants it considered, and no marker file in the workspace announces it.
  const ownDomains = [...new Set(userSkills().skills.map((skill) => skill.domain))];
  const wanted = [...new Set([...ownDomains, ...domains])];

  for (const domain of wanted) {
    const domainSkills = catalogue.get(domain);
    if (!domainSkills || domainSkills.length === 0) continue;
    if (totalSkillsCount >= MAX_INDEXED_SKILLS) break;

    let domainSkillsCount = 0;
    let domainIndexText = `### ${domain.toUpperCase()} SKILLS\n`;

    for (const skill of domainSkills) {
      if (totalSkillsCount + domainSkillsCount >= MAX_INDEXED_SKILLS) break;
      const mark = skill.source === 'user' ? ' [your own]' : '';
      domainIndexText += `- **${skill.name}**${mark} (ID: ${domain}/${skill.id}): ${skill.description}\n`;
      domainSkillsCount++;
    }

    if (domainSkillsCount > 0) {
      indexText += domainIndexText + '\n';
      totalSkillsCount += domainSkillsCount;
    }
  }

  if (totalSkillsCount === 0) return '';

  let finalOutput = `\n<causyne_universal_skills>\n`;
  finalOutput += `You have access to highly-curated, domain-specific intelligence skills provided as readable local skill data. If a skill is relevant to the user's task, you MUST use the \`fs_read_skill\` tool (passing the ID) to read its full instruction BEFORE proceeding with your plan. NEVER guess syntax if a skill exists for it.\n\n`;
  finalOutput += indexText;
  finalOutput += `</causyne_universal_skills>\n`;

  return finalOutput;
}

/**
 * The compact form of the skills index: what domains exist and how to search
 * them, instead of forty name-and-description lines.
 *
 * WHY: `getUniversalSkillsIndex()` costs ~841 tokens for two domains and ~1,092
 * for web+android, injected into a cached system block on EVERY request of
 * EVERY task — a bare "hi" paid for a catalogue of skills it would never read.
 *
 * WHY IT IS SAFE NOW AND WAS NOT BEFORE: until `tool_search` learned to score
 * the skill catalogue, this index was the ONLY way a model could discover a
 * skill id. Shrinking it would have made 100 compiled skills unreachable —
 * a capability regression wearing an optimisation's clothes. Retrieval replaces
 * a catalogue only once the retrieval exists.
 *
 * @param   {Set|Array} domains  Workspace domains detected for this task.
 * @returns {string}             System-prompt fragment, '' when nothing exists.
 */
export function getSkillDomainHeader(domains) {
  const catalogue = new Map();
  for (const skill of listCompiledSkills()) {
    catalogue.set(skill.domain, (catalogue.get(skill.domain) || 0) + 1);
  }
  if (catalogue.size === 0) return '';

  const total = [...catalogue.values()].reduce((sum, n) => sum + n, 0);
  const relevant = [...new Set(domains || [])].filter(d => catalogue.has(d));
  const all = [...catalogue.keys()].sort();

  let out = `\n<causyne_universal_skills>\n`;
  out += `${total} curated engineering skills are compiled into you, across: ${all.join(', ')}.\n`;
  if (relevant.length > 0) {
    out += `This workspace looks like: ${relevant.join(', ')}.\n`;
  }
  out += `Call \`tool_search\` with what you are trying to do to find the relevant skill ids, then read one with \`fs_read_skill\`. Do this BEFORE planning anything the skills cover. NEVER guess syntax a skill documents.\n`;
  out += `</causyne_universal_skills>\n`;
  return out;
}

/**
 * The whole catalogue as a flat list, for the picker and for `/skills`.
 *
 * One shape for every consumer, so the terminal picker and the text listing can
 * never disagree about what exists.
 */
export function listCompiledSkills() {
  const out = [];
  const seen = new Set();

  // The user's own skills come first and SHADOW a compiled skill of the same
  // id. That is the customisation: someone whose deployment genuinely differs
  // from the shipped procedure writes their own `devops/zero-downtime-deploys`
  // and theirs is the one the agent reads. Shipping a library that cannot be
  // corrected is shipping an opinion.
  for (const skill of userSkills().skills) {
    const key = `${skill.domain}/${skill.id}`;
    seen.add(key);
    out.push({
      domain: skill.domain, id: skill.id, name: skill.name,
      description: skill.description, source: 'user'
    });
  }

  for (const [domain, skills] of Object.entries(COMPILED_SKILLS)) {
    for (const [id, data] of Object.entries(skills)) {
      if (seen.has(`${domain}/${id}`)) continue;
      out.push({
        domain, id, name: data.name || id,
        description: data.description || '', source: 'native'
      });
    }
  }
  return out;
}

export function readCompiledSkill(domain, skillId) {
  // A user skill of the same id wins, for the same reason it does in the
  // listing: the user's version is the corrected one.
  const own = userSkills().skills
    .find((skill) => skill.domain === domain && skill.id === skillId);
  if (own) return own.content;

  const domainSkills = COMPILED_SKILLS[domain];
  if (!domainSkills) return `Error: Domain ${domain} not found in compiled skills.`;

  const skillData = domainSkills[skillId];
  if (!skillData) return `Error: Skill ${skillId} not found in domain ${domain}.`;

  return skillData.content;
}
