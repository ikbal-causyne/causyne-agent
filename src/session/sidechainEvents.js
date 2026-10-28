/**
 * @file src/session/sidechainEvents.ts
 * Causyne Agent — Typed Condensation Events & Sidechain Auditing
 *
 * Ported & elevated from OpenHands (src/types/agent-server/core/events/condensation-event.ts).
 * Models history compaction not as destructive deletion, but as an explicit,
 * auditable event stream preserving forgotten_event_ids and recovery anchors.
 *
 * Authorship: Strict TypeScript (Causyne Agent).
 */
export class SidechainEventLog {
    events = [];
    append(event) {
        this.events.push(event);
    }
    recordCondensation(forgottenIds, summary, reclaimedChars, finalChars, limitChars) {
        const event = {
            id: `cond_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            timestamp: Date.now(),
            kind: 'Condensation',
            source: 'environment',
            forgotten_event_ids: [...forgottenIds],
            summary,
            summary_offset: this.events.length,
            reclaimedChars,
            finalChars,
            limitChars
        };
        this.append(event);
        return event;
    }
    getEvents() {
        return this.events;
    }
    getForgottenIds() {
        const set = new Set();
        for (const event of this.events) {
            if (event.kind === 'Condensation') {
                for (const id of event.forgotten_event_ids) {
                    set.add(id);
                }
            }
        }
        return set;
    }
    serializeJsonl() {
        return this.events.map(e => JSON.stringify(e)).join('\n') + '\n';
    }
}
