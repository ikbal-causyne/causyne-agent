// @ts-expect-error userSkills.js is awaiting TypeScript migration.
import { writeUserSkill, validateSegment, skillTemplate } from '../userSkills.js';
import { invalidateUserSkills } from '../skillsManager.js';
// @ts-expect-error theme.js has no TypeScript declaration yet.
import { paint, bold, dim } from './theme.js';
// @ts-expect-error dialogs.js is awaiting TypeScript migration.
import { InputLayer, SelectLayer } from './dialogs.js';
const COMMON_DOMAINS = [
    { value: 'custom', label: 'custom', description: 'General project & personal workflow skills' },
    { value: 'engineering', label: 'engineering', description: 'Software architecture, refactoring & review' },
    { value: 'frontend', label: 'frontend', description: 'Web UI, CSS, React, components & layout' },
    { value: 'backend', label: 'backend', description: 'APIs, databases, server infrastructure' },
    { value: 'devops', label: 'devops', description: 'CI/CD, Docker, deployment & releases' },
    { value: 'testing', label: 'testing', description: 'Unit, integration & regression tests' },
    { value: 'mobile', label: 'mobile', description: 'Android, iOS, Flutter, React Native' },
    { value: '__other__', label: '+ Enter custom category...', description: 'Specify any category name' }
];
/**
 * Interactive wizard hosted on ChatPrompt to scaffold and create a new skill.
 */
export async function runInteractiveSkillWizard(prompt) {
    // Step 1: Select or enter domain/category
    const chosenDomain = await new Promise((resolve) => {
        let resolved = false;
        const finish = (val) => {
            if (!resolved) {
                resolved = true;
                resolve(val);
            }
        };
        const layer = new SelectLayer({
            title: 'create skill · category',
            placeholder: 'choose or type category',
            items: COMMON_DOMAINS,
            width: 72,
            height: 14,
            onPick: (item) => {
                finish(item?.value || null);
            }
        });
        prompt.openLayer(layer);
    });
    if (!chosenDomain)
        return null;
    let domain = chosenDomain;
    if (domain === '__other__') {
        const customDomain = await new Promise((resolve) => {
            let resolved = false;
            const finish = (val) => {
                if (!resolved) {
                    resolved = true;
                    resolve(val);
                }
            };
            const layer = new InputLayer({
                title: 'create skill · category name',
                lines: ['Category / domain name (e.g. data, analytics, cloud, tools):'],
                placeholder: 'category-name',
                onSubmit: (val) => finish(val.trim().toLowerCase()),
                onCancel: () => finish(null)
            });
            prompt.openLayer(layer);
        });
        if (!customDomain)
            return null;
        const err = validateSegment(customDomain, 'category');
        if (err) {
            if (typeof prompt.showText === 'function') {
                prompt.showText('Invalid Category', err, { danger: true });
            }
            return null;
        }
        domain = customDomain;
    }
    // Step 2: Skill name
    const skillName = await new Promise((resolve) => {
        let resolved = false;
        const finish = (val) => {
            if (!resolved) {
                resolved = true;
                resolve(val);
            }
        };
        const layer = new InputLayer({
            title: 'create skill · name',
            lines: [
                `Category: ${paint('accent', domain)}`,
                'Skill name (lowercase letters, numbers, hyphens — e.g. play-store-release, pr-review):'
            ],
            placeholder: 'my-new-skill',
            onSubmit: (val) => finish(val.trim().toLowerCase()),
            onCancel: () => finish(null)
        });
        prompt.openLayer(layer);
    });
    if (!skillName)
        return null;
    const nameErr = validateSegment(skillName, 'skill name');
    if (nameErr) {
        if (typeof prompt.showText === 'function') {
            prompt.showText('Invalid Skill Name', nameErr, { danger: true });
        }
        return null;
    }
    // Step 3: Skill description
    const skillDesc = await new Promise((resolve) => {
        let resolved = false;
        const finish = (val) => {
            if (!resolved) {
                resolved = true;
                resolve(val);
            }
        };
        const layer = new InputLayer({
            title: 'create skill · description',
            lines: [
                `Skill: ${paint('accent', `${domain}/${skillName}`)}`,
                'Short description: what this skill does and when the agent should use it:'
            ],
            placeholder: 'e.g. Prepares and validates Android app bundles for Google Play Store release.',
            onSubmit: (val) => finish(val.trim()),
            onCancel: () => finish(null)
        });
        prompt.openLayer(layer);
    });
    if (!skillDesc)
        return null;
    // Step 4: Write skill file
    const content = skillTemplate(domain, skillName, skillDesc);
    const written = writeUserSkill({ domain, name: skillName, content, overwrite: false });
    if (!written.ok) {
        if (typeof prompt.showText === 'function') {
            prompt.showText('Skill Creation Failed', written.error || 'Failed to write skill file', { danger: true });
        }
        return null;
    }
    invalidateUserSkills();
    return {
        domain,
        id: skillName,
        name: skillName,
        description: skillDesc,
        content,
        path: written.path,
        source: 'user'
    };
}
