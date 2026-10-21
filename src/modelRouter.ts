import { UTILITY_MODEL_BY_PROVIDER } from './modelCatalogue.js';

// Hybrid model routing.
//
// Not every call an agent makes is reasoning. Condensing a dropped transcript,
// classifying an intent, filtering a log, extracting keywords — these are
// utility work, and paying a flagship rate for them is pure waste. The research
// spec puts the saving at the difference between the two rate cards, which for
// OpenAI is $5/$30 against $0.75/$4.50: roughly 6x on work that never needed
// the better model.
//
// THREE RULES THIS MODULE EXISTS TO ENFORCE, all of them things a naive router
// gets wrong:
//
//   1. NEVER CHANGE PROVIDER. Causyne is BYOK. The user holds one key. A router
//      that sends utility work to "whatever is cheapest on the market" calls an
//      endpoint there is no credential for and the task fails — having spent
//      the tokens that got it there.
//
//   2. NEVER CHANGE THE PRIVACY POSTURE. Muse's cheap tier is `-contributor`,
//      discounted because the vendor trains on the content. Routing into it to
//      save money would opt the user into training silently. Cost is not a
//      reason to make that choice for someone.
//
//   3. NEVER GUESS. A provider with no published second tier routes to nothing
//      and pays full rate. An invented model id becomes a 404 mid-task, or
//      worse, a real model at a price nobody predicted.
//
// The router returns a DESCRIPTION of where a call should go. It never
// constructs a provider and never performs a call, so it stays trivially
// testable and cannot become a second place where credentials are handled.

export type RouteClass = 'reasoning' | 'utility';

export interface Route {
  provider: string;
  model: string;
  routed: boolean;
  reason: string;
}

export interface RouterConfig {
  provider?: string | undefined;
  model?: string | undefined;
  modelRouting?: Record<string, string> | undefined;
  disableModelRouting?: boolean | undefined;
  [key: string]: unknown;
}

/**
 * Utility work that is cheap to get wrong and expensive to run on a flagship.
 * Anything not listed is treated as reasoning — the safe default is to spend
 * more, never to silently downgrade work the user is judging.
 */
export const UTILITY_KINDS: ReadonlySet<string> = new Set([
  'condense',        // cortex/autoCondenser semantic pass
  'keywords',        // plan-cache intent extraction
  'classify',        // intent / archetype disambiguation
  'filter',          // log and output filtering
  'summarise'        // non-decision summaries
]);

/**
 * Decide where a call of a given kind should go.
 *
 * @param config The live agent config, as loaded from `~/.causyne/config.json`.
 * @param kind Either a RouteClass or one of UTILITY_KINDS.
 * @returns The resolved route description.
 */
export function resolveRoute(config: RouterConfig | undefined | null, kind: RouteClass | string): Route {
  const provider = String(config?.provider || '').toLowerCase();
  const configured = String(config?.model || '');

  const stay: Route = {
    provider,
    model: configured,
    routed: false,
    reason: 'reasoning work runs on the configured model'
  };

  if (!provider || !configured) {
    return { ...stay, reason: 'no provider or model configured' };
  }

  const isUtility = kind === 'utility' || UTILITY_KINDS.has(String(kind));
  if (!isUtility) return stay;

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
export function routedConfig<T extends RouterConfig>(config: T, kind: RouteClass | string): { config: T; route: Route } {
  const route = resolveRoute(config, kind);
  if (!route.routed) return { config, route };
  return { config: { ...config, model: route.model }, route };
}
