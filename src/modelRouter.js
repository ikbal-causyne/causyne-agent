import { UTILITY_MODEL_BY_PROVIDER } from './modelCatalogue.js';
/**
 * Utility work that is cheap to get wrong and expensive to run on a flagship.
 * Anything not listed is treated as reasoning — the safe default is to spend
 * more, never to silently downgrade work the user is judging.
 */
export const UTILITY_KINDS = new Set([
    'condense', // cortex/autoCondenser semantic pass
    'keywords', // plan-cache intent extraction
    'classify', // intent / archetype disambiguation
    'filter', // log and output filtering
    'summarise' // non-decision summaries
]);
/**
 * Decide where a call of a given kind should go.
 *
 * @param config The live agent config, as loaded from `~/.causyne/config.json`.
 * @param kind Either a RouteClass or one of UTILITY_KINDS.
 * @returns The resolved route description.
 */
export function resolveRoute(config, kind) {
    const provider = String(config?.provider || '').toLowerCase();
    const configured = String(config?.model || '');
    const stay = {
        provider,
        model: configured,
        routed: false,
        reason: 'reasoning work runs on the configured model'
    };
    if (!provider || !configured) {
        return { ...stay, reason: 'no provider or model configured' };
    }
    const isUtility = kind === 'utility' || UTILITY_KINDS.has(String(kind));
    if (!isUtility)
        return stay;
    if (config?.disableModelRouting === true) {
        return { ...stay, reason: 'model routing disabled by config' };
    }
    // An explicit choice by the user outranks the table, including a deliberate
    // choice of a training tier — they made it, we did not make it for them.
    const override = config?.modelRouting?.['utility'];
    if (override) {
        return {
            provider,
            model: String(override),
            routed: String(override) !== configured,
            reason: 'utility route set explicitly in config'
        };
    }
    const cheap = UTILITY_MODEL_BY_PROVIDER[provider];
    if (!cheap) {
        return { ...stay, reason: `no published utility tier for ${provider}; paying full rate` };
    }
    if (cheap === configured) {
        return { ...stay, reason: 'already on this provider\'s utility tier' };
    }
    // Rule 2. The configured model already carries a privacy posture; a route may
    // not alter it in either direction.
    if (/-contributor$/.test(configured) !== /-contributor$/.test(cheap)) {
        return { ...stay, reason: 'a route may not change the training-data posture' };
    }
    return {
        provider,
        model: cheap,
        routed: true,
        reason: `utility work routed to ${provider}'s cheaper tier`
    };
}
/**
 * A config object for the routed call, leaving everything except the model
 * untouched — same provider, same key, same base URL.
 */
export function routedConfig(config, kind) {
    const route = resolveRoute(config, kind);
    if (!route.routed)
        return { config, route };
    return { config: { ...config, model: route.model }, route };
}
