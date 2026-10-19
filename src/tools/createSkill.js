// Let the agent write a skill for the user.
//
// The compiled library is one library for everybody. The other half of the same
// idea is that the agent can WRITE one: a user explains their release process
// once, and it becomes a procedure the agent follows every time afterwards
// instead of being re-explained every session. That is the difference between a
// tool that remembers and a tool that does not.
//
// The contract is the one every compiled skill already meets — frontmatter with
// a routing description, numbered steps each closing with a checkable
// criterion, and a verification section. It is enforced here rather than
// suggested, because a skill written to a weaker standard than the library is
// worse than none: it dilutes the index the agent chooses from.
//
// Path safety, size limits and sanitising all live in userSkills.js, and this
// tool cannot reach the filesystem except through it.

import {
  parseSkillId, writeUserSkill, userSkillsRoot, MAX_SKILL_BYTES
} from '../userSkills.js';
import { invalidateUserSkills } from '../skillsManager.js';

/** Everything the contract requires, reported at once rather than one at a time. */
function contractProblems(content) {
  const problems = [];
  if (!/^---\n[\s\S]*?\n---/.test(content)) {
    problems.push('missing the `---` frontmatter block at the very top');
  }
  if (!/^description:\s*\S/m.test(content)) {
    problems.push("frontmatter needs a `description:` — it is the ONLY thing the agent reads when deciding whether this skill applies, so write it as \"what this does. Use when …\"");
  }
  if (!/^name:\s*\S/m.test(content)) {
    problems.push('frontmatter needs a `name:`');
  }
  if (!/\*\*Done when:\*\*/.test(content)) {
    problems.push("no step ends with a `**Done when:**` criterion — without one this is a description of a task, not a procedure someone can follow to a known end");
  }
  if (!/##\s+Verification/i.test(content)) {
    problems.push('no `## Verification` section — a skill has to say how to confirm it worked');
  }
  return problems;
}

export const createSkill = {
  schema: {
    name: 'skill_create',
    description:
      "Write a reusable skill into the user's own skill library so it is available in every future session. Use when the user describes a procedure specific to them — their "
      + 'deployment steps, their review checklist, their project conventions — that would '
      + 'otherwise have to be explained again next time. Ask the user before writing one they '
      + 'did not request. The body must follow the skill contract: frontmatter with name and a '
      + '"Use when ..." description, numbered steps each ending with a "**Done when:**" line, '
      + 'and a closing "## Verification" section.',
    parameters: {
      type: 'object',
      properties: {
        skill_id: {
          type: 'string',
          description:
            "Where it lives, as \"domain/name\". Both are lowercase letters, digits and hyphens. Use an existing domain (web, devops, python, testing, security, design, …) when the "
            + 'skill belongs to one, or a new domain of the user\'s own such as "team" or the '
            + 'project name. Example: team/release-checklist'
        },
        content: {
          type: 'string',
          description:
            "The complete SKILL.md, starting with the --- frontmatter block. Write the procedure, not an essay: the steps someone would actually take, in order, each with a "
            + 'checkable "**Done when:**" line, closing with "## Verification".'
        },
        overwrite: {
          type: 'boolean',
          description:
            "Replace an existing skill of the same id. Defaults to false. Only set this when the user has asked for that specific skill to be rewritten."
        }
      },
      required: ['skill_id', 'content']
    }
  },

  execute: async (args = {}) => {
    const parsed = parseSkillId(args.skill_id);
    if (parsed.error) return { success: false, error: parsed.error };

    const content = typeof args.content === 'string' ? args.content : '';
    if (!content.trim()) {
      return { success: false, error: 'content is required — write the whole SKILL.md' };
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) {
      return {
        success: false,
        error: `the skill is larger than the ${MAX_SKILL_BYTES / 1024} KB limit. A skill this long `
          + 'will crowd out the task it is meant to help with — split it, or move the detail into '
          + 'the step that needs it.'
      };
    }

    const problems = contractProblems(content);
    if (problems.length > 0) {
      return {
        success: false,
        error: 'the skill does not meet the contract:\n'
          + problems.map((problem) => `  - ${problem}`).join('\n')
          + '\n\nRewrite it with those fixed and call skill_create again.'
      };
    }

    const written = writeUserSkill({
      domain: parsed.domain,
      name: parsed.name,
      content,
      overwrite: args.overwrite === true
    });
    if (!written.ok) return { success: false, error: written.error };

    // The catalogue is cached; a skill written now must be visible now.
    invalidateUserSkills();

    return {
      success: true,
      result: `Wrote ${parsed.domain}/${parsed.name} to ${written.path}\n\n`
        + `It is now in the user's library alongside the built-in skills, and it shadows a `
        + `built-in of the same id. They can see it with /skill mine, read it with `
        + `/skills ${parsed.domain}/${parsed.name}, and edit the file directly at `
        + `${userSkillsRoot()}.`
    };
  }
};

export default createSkill;
