/** Types for the existing JavaScript user skill store during the TS migration. */
export interface UserSkill {
  domain: string;
  id: string;
  name: string;
  description: string;
  content: string;
  source: 'user';
  path: string;
}
export const MAX_USER_SKILLS: number;
export const MAX_SKILL_BYTES: number;
export const MAX_DESCRIPTION: number;
export function userSkillsRoot(): string;
export function validateSegment(value: unknown, what?: string): string | null;
export function parseSkillId(id: unknown):
  | { domain: string; name: string; error?: never }
  | { domain?: never; name?: never; error: string };
export function loadUserSkills(root?: string): { skills: UserSkill[]; problems: string[] };
export function skillTemplate(domain: string, name: string, description?: string): string;
export function writeUserSkill(input: {
  domain: string; name: string; content: string; overwrite?: boolean;
}, root?: string): { ok: boolean; path?: string; error?: string };
export function deleteUserSkill(domain: string, name: string, root?: string): {
  ok: boolean; path?: string; error?: string;
};
