import { packForTool } from './toolPacks.js';
import { refineToolDecision } from './smartToolsUse.js';
/** Schema selection is a context optimization, never an authorization mechanism. */
export const DISCOVERY_CONTROLS = ['tool_search', 'update_plan', 'request_decision'];
export class SmartTools {
    schemaOrder = [];
    refine(decision, context) {
        // An explicit selection must not silently discard tools beyond a fixed cap.
        const refined = refineToolDecision(decision, context);
        const admittedTools = context.admittedTools ?? new Set();
        return decision.source === 'request'
            ? { ...refined, tools: decision.tools.filter((name) => !admittedTools.has(name)), deferred: [] }
            : refined;
    }
    schemas(eligible, selected, packs, grantAll = false) {
        const definitions = new Map(eligible.map((definition) => [definition.name, definition]));
        const requested = new Set(DISCOVERY_CONTROLS);
        for (const name of selected)
            requested.add(name);
        for (const definition of eligible) {
            const pack = packForTool(definition.name);
            if (grantAll || (pack && packs.has(pack)))
                requested.add(definition.name);
        }
        for (const name of requested) {
            if (definitions.has(name) && !this.schemaOrder.includes(name))
                this.schemaOrder.push(name);
        }
        // Revalidate on every turn: a saved ID cannot override a changed policy.
        return this.schemaOrder.filter((name) => requested.has(name) && definitions.has(name))
            .map((name) => definitions.get(name));
    }
}
