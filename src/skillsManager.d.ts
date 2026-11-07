export function detectWorkspaceDomains(...args: any[]): any;
export function ensureSkillRepo(...args: any[]): any;
export function getSkillDomainHeader(...args: any[]): any;
export function listCompiledSkills(): Array<{ id: string; name: string; domain: string; description?: string; source?: string }>;
export function readCompiledSkill(domain: string, skillId: string): string;
export function invalidateUserSkills(): void;
export function userSkillProblems(): string[];
