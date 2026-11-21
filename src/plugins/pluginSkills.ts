import fs from 'node:fs';
import path from 'node:path';
import { isWithinPhysicalPath, physicalPath } from '../agent/workspaceBoundary.js';

const MAX_SKILLS_PER_PLUGIN = 32;
const MAX_SKILL_BYTES = 32 * 1024;
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface PluginSkillManifestInput {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  file?: unknown;
}

export interface PluginSkill {
  domain: string;
  id: string;
  name: string;
  description: string;
  content: string;
  source: 'plugin';
  plugin: string;
  path: string;
}

function resolveInside(root: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0')) {
    throw new Error('Invalid plugin skill path');
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relativePath);
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Skill path escapes plugin root: ${relativePath}`);
  }
  let cursor = path.dirname(resolved);
  while (cursor !== resolvedRoot && cursor.startsWith(`${resolvedRoot}${path.sep}`)) {
    const ancestorStat = fs.lstatSync(cursor);
    if (ancestorStat.isSymbolicLink() || !ancestorStat.isDirectory()) {
      throw new Error(`Skill path must not traverse symlinks: ${relativePath}`);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const realRoot = physicalPath(resolvedRoot);
  const realTarget = physicalPath(resolved);
  if (!realRoot || !realTarget || realTarget === realRoot || !isWithinPhysicalPath(realTarget, realRoot)) {
    throw new Error(`Skill path escapes plugin root physically: ${relativePath}`);
  }
  return resolved;
}

const BIDI_AND_ZW_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

function cleanLine(value: unknown, maximum: number): string {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(BIDI_AND_ZW_RE, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function readSkillFile(file: string): string {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${file} must be a regular file`);
  if (stat.nlink > 1) throw new Error(`${file} must not be a hardlink`);
  if (stat.size > MAX_SKILL_BYTES) throw new Error(`${file} exceeds ${MAX_SKILL_BYTES / 1024} KB`);
  return fs.readFileSync(file, 'utf8')
    // Keep newlines and tabs, but remove control bytes and bidi overrides that can corrupt a prompt.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(BIDI_AND_ZW_RE, '');
}

/**
 * Validate plugin-contributed skills without importing or evaluating plugin
 * code. A skill becomes visible only after the caller verifies the plugin's
 * whole-directory digest against the explicit enablement record.
 */
export function parsePluginSkills(
  directory: string,
  pluginName: string,
  value: unknown
): PluginSkill[] {
  if (typeof directory !== 'string' || !directory || directory.includes('\0')) {
    throw new Error('Invalid plugin directory');
  }
  if (typeof pluginName !== 'string' || !SKILL_ID.test(pluginName)) {
    throw new Error(`Invalid plugin name ${JSON.stringify(pluginName)}`);
  }
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Plugin skills must be an array');
  if (value.length > MAX_SKILLS_PER_PLUGIN) {
    throw new Error(`Plugin exceeds ${MAX_SKILLS_PER_PLUGIN} skills`);
  }

  const domain = `plugin-${pluginName}`;
  const ids = new Set<string>();
  return value.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Skill ${index + 1} must be an object`);
    }
    const input = raw as PluginSkillManifestInput;
    const id = String(input.id ?? '');
    if (!SKILL_ID.test(id)) throw new Error(`Invalid plugin skill id ${JSON.stringify(id)}`);
    if (ids.has(id)) throw new Error(`Duplicate plugin skill id ${id}`);
    ids.add(id);

    const name = cleanLine(input.name ?? id, 120);
    const description = cleanLine(input.description, 400);
    if (!name) throw new Error(`Plugin skill ${id} needs a name`);
    if (!description) throw new Error(`Plugin skill ${id} needs a description`);
    if (typeof input.file !== 'string' || !input.file || input.file.length > 512 || path.isAbsolute(input.file)) {
      throw new Error(`Plugin skill ${id} needs a valid relative file path`);
    }
    const file = resolveInside(directory, input.file);
    const content = readSkillFile(file);
    if (!content.trim()) throw new Error(`Plugin skill ${id} is empty`);

    return {
      domain,
      id,
      name,
      description,
      content,
      source: 'plugin' as const,
      plugin: pluginName,
      path: file
    };
  });
}

export { MAX_SKILLS_PER_PLUGIN, MAX_SKILL_BYTES };
