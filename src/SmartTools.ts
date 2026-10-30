import { packForTool } from './toolPacks.js';
import { refineToolDecision } from './smartToolsUse.js';
import type { SmartToolsContext, RefinedToolDecision } from './smartToolsUse.js';
import type { ToolDecision } from './decideTools.js';

/** Schema selection is a context optimization, never an authorization mechanism. */
export const DISCOVERY_CONTROLS = ['tool_search', 'update_plan', 'request_decision'] as const;

export class SmartTools {
  private readonly schemaOrder: string[] = [];

  refine(decision: ToolDecision, context: SmartToolsContext): RefinedToolDecision {
    // An explicit selection must not silently discard tools beyond a fixed cap.
    const refined = refineToolDecision(decision, context);
    const admittedTools = context.admittedTools ?? new Set<string>();
    return decision.source === 'request'
      ? { ...refined, tools: decision.tools.filter((name) => !admittedTools.has(name)), deferred: [] }
      : refined;
  }

  schemas<T extends { name: string }>(eligible: readonly T[], selected: ReadonlySet<string>,
    packs: ReadonlySet<string>, grantAll = false): T[] {
    const definitions = new Map(eligible.map((definition) => [definition.name, definition]));
    const requested = new Set<string>(DISCOVERY_CONTROLS);
    for (const name of selected) requested.add(name);
    for (const definition of eligible) {
      const pack = packForTool(definition.name);
      if (grantAll || (pack && packs.has(pack))) requested.add(definition.name);
    }
    for (const name of requested) {
      if (definitions.has(name) && !this.schemaOrder.includes(name)) this.schemaOrder.push(name);
    }
    // Revalidate on every turn: a saved ID cannot override a changed policy.
    return this.schemaOrder.filter((name) => requested.has(name) && definitions.has(name))
      .map((name) => definitions.get(name)!);
  }
}
