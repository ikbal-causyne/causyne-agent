import { readCompiledSkill } from '../skillsManager.js';

export default {
  schema: {
    name: "fs_read_skill",
    description: "Read the full contents of a native AI skill from the bundled readable skill data. Use this to read the instructions for a specific skill.",
    parameters: {
      type: "object",
      properties: {
        skill_id: {
          type: "string",
          description: "The ID of the skill to read (e.g. 'devops/docker-best-practices' or 'python/python-env-isolation')"
        }
      },
      required: ["skill_id"]
    }
  },
  execute: async (args) => {
    try {
      const parts = args.skill_id.split('/');
      if (parts.length !== 2) {
        return { success: false, error: 'Invalid skill_id format. Expected "domain/skillName"' };
      }
      
      const domain = parts[0];
      const skillName = parts[1];
      
      const content = readCompiledSkill(domain, skillName);
      
      if (content.startsWith('Error:')) {
        return { success: false, error: content };
      }
      
      return { success: true, result: content };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
