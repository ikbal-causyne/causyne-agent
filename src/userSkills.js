

import fs from 'fs';
import os from 'os';
import path from 'path';
import { causyneHome } from './utils/paths.js';

// Bounds. Every one of these protects the context window, which is the resource
// a skill library actually spends.
export const MAX_USER_SKILLS = 200;
export const MAX_SKILL_BYTES = 32 * 1024;
export const MAX_DESCRIPTION = 400;

// A skill id and a domain are path segments. Lowercase, digits and hyphens is
// the whole alphabet — which makes traversal, drive letters, device names,
// leading dots and spaces unrepresentable rather than merely filtered.
const SEGMENT = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Windows reserves these as device names. A directory called `con` or `aux`
// cannot be created there, and `nul` silently discards what is written to it —
// so a skill named after one would work on the author's Mac and fail, or vanish,
// for a Windows user. Vision section 3: never assume the developer's own OS.
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`)
]);

export function userSkillsRoot() {
  return path.join(causyneHome(), 'skills');
}

/** Is this a usable path segment? Returns a reason when it is not. */
export function validateSegment(value, what = 'name') {
  const text = String(value == null ? '' : value);
  if (!text) return `${what} is required`;
  if (!SEGMENT.test(text)) {
    return `${what} must be lowercase letters, digits and hyphens, starting with a letter or digit `
      + `(got ${JSON.stringify(text.slice(0, 40))})`;
  }
  if (RESERVED.has(text)) {
    return `${what} ${JSON.stringify(text)} is a reserved device name on Windows — `
      + 'a skill by that name would fail there. Pick another.';
  }
  return null;
}

/**
 * Read `domain` and `name` out of a `domain/name` id.
 *
 * Rejects anything with a different shape rather than guessing, because a
 * guessed split is how a traversal segment reaches a join().
 */
export function parseSkillId(id) {
  const parts = String(id == null ? '' : id).split('/');
  if (parts.length !== 2) {
    return { error: 'skill id must be "domain/name", for example team/release-checklist' };
  }
  const [domain, name] = parts;
  const domainError = validateSegment(domain, 'domain');
  if (domainError) return { error: domainError };
  const nameError = validateSegment(name, 'skill name');
  if (nameError) return { error: nameError };
  return { domain, name };
}

/** Strip control characters and collapse a description onto one line. */
function cleanDescription(value) {
  return String(value == null ? '' : value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DESCRIPTION);
}

/** Remove control bytes from a body while keeping newlines and tabs. */
function cleanBody(value) {
  // eslint-disable-next-line no-control-regex
  return String(value == null ? '' : value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const block = match[1];
  const name = block.match(/^name:\s*(.+)$/m);
  const description = block.match(/^description:\s*(.+)$/m);
  return {
    name: name ? name[1].trim() : '',
    description: description ? description[1].trim() : ''
  };
}

/**
 * Every user skill on disk, validated.
 *
 * Never throws: a broken file is skipped and reported, because one bad skill
 * must not stop a session from starting. Returns { skills, problems }.
 */
export function loadUserSkills(root = userSkillsRoot()) {
  const skills = [];
  const problems = [];

  let domains;
  try {
    if (!fs.existsSync(root)) return { skills, problems };
    domains = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch (e) {
    return { skills, problems: [`could not read ${root}: ${e.message}`] };
  }

  for (const domain of domains) {
    if (validateSegment(domain, 'domain')) {
      problems.push(`skipped domain ${JSON.stringify(domain)}: not a valid name`);
      continue;
    }
    let names;
    try {
      names = fs.readdirSync(path.join(root, domain), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name);
    } catch (e) { continue; }

    for (const name of names) {
      if (skills.length >= MAX_USER_SKILLS) {
        problems.push(`stopped at ${MAX_USER_SKILLS} skills — the rest were not loaded`);
        return { skills, problems };
      }
      if (validateSegment(name, 'skill name')) {
        problems.push(`skipped ${domain}/${name}: not a valid name`);
        continue;
      }

      const file = path.join(root, domain, name, 'SKILL.md');
      let content;
      try {
        // Refuse a symlink outright: it is the one way a file inside this
        // directory can point at something outside it.
        const stat = fs.lstatSync(file);
        if (!stat.isFile()) { problems.push(`skipped ${domain}/${name}: not a regular file`); continue; }
        if (stat.size > MAX_SKILL_BYTES) {
          problems.push(`skipped ${domain}/${name}: ${(stat.size / 1024).toFixed(0)} KB exceeds the `
            + `${MAX_SKILL_BYTES / 1024} KB limit — a skill this large would crowd out the task`);
          continue;
        }
        content = fs.readFileSync(file, 'utf8');
      } catch (e) { continue; }

      const meta = parseFrontmatter(content);
      const description = cleanDescription(meta.description);
      if (!description) {
        problems.push(`skipped ${domain}/${name}: no description in the frontmatter — `
          + 'the description is how the agent decides when the skill applies');
        continue;
      }

      skills.push({
        domain,
        id: name,
        name: meta.name || name,
        description,
        content: cleanBody(content),
        source: 'user',
        path: file
      });
    }
  }
  return { skills, problems };
}

/** The starting point a new skill is written from. */
export function skillTemplate(domain, name, description = '') {
  const title = name.split('-').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
  return `---
name: ${name}
description: ${description || `TODO — one line: what this does, and WHEN to reach for it.`}
---

# ${title}

## Workflow

1. First step.
   - What to do, and the detail that is easy to get wrong.
   - **Done when:** something you can actually check.

2. Second step.
   - **Done when:** something you can actually check.

## Verification

- How to confirm the whole thing worked.
`;
}

/**
 * Write a user skill to disk.
 *
 * Refuses to overwrite unless asked, so neither a user nor an agent can silently
 * replace a skill someone spent time on.
 */
export function writeUserSkill({ domain, name, content, overwrite = false }, root = userSkillsRoot()) {
  const domainError = validateSegment(domain, 'domain');
  if (domainError) return { ok: false, error: domainError };
  const nameError = validateSegment(name, 'skill name');
  if (nameError) return { ok: false, error: nameError };

  const body = cleanBody(content);
  if (Buffer.byteLength(body, 'utf8') > MAX_SKILL_BYTES) {
    return { ok: false, error: `skill exceeds the ${MAX_SKILL_BYTES / 1024} KB limit` };
  }

  const meta = parseFrontmatter(body);
  if (!cleanDescription(meta.description)) {
    return {
      ok: false,
      error: "the frontmatter needs a `description:` line — it is what the agent reads to decide whether the skill applies, so a skill without one can never be selected"
    };
  }

  const directory = path.join(root, domain, name);
  const file = path.join(directory, 'SKILL.md');

  // Belt and braces: the resolved path must still be inside the root after every
  // segment has been joined. Validation above already makes this unreachable.
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(file);
  if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(resolvedRoot + path.sep)) {
    return { ok: false, error: 'refusing to write outside the skills directory' };
  }

  if (!overwrite && fs.existsSync(file)) {
    return { ok: false, error: `${domain}/${name} already exists — pass overwrite to replace it` };
  }

  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
  } catch (e) {
    return { ok: false, error: `could not write ${file}: ${e.message}` };
  }
  return { ok: true, path: file };
}

/** Remove a user skill. Compiled skills are not removable — they are the build. */
export function deleteUserSkill(domain, name, root = userSkillsRoot()) {
  const domainError = validateSegment(domain, 'domain');
  if (domainError) return { ok: false, error: domainError };
  const nameError = validateSegment(name, 'skill name');
  if (nameError) return { ok: false, error: nameError };

  const directory = path.join(root, domain, name);
  if (!fs.existsSync(path.join(directory, 'SKILL.md'))) {
    return { ok: false, error: `${domain}/${name} is not a user skill` };
  }
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: `could not remove ${directory}: ${e.message}` };
  }
  return { ok: true, path: directory };
}
