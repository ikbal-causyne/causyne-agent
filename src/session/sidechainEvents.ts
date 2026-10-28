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

export type EventSource = 'user' | 'agent' | 'environment';

export interface BaseSidechainEvent {
  id: string;
  timestamp: number;
  source: EventSource;
}

export interface CondensationEvent extends BaseSidechainEvent {
  kind: 'Condensation';
  source: 'environment';
  forgotten_event_ids: string[];
  summary: string;
  summary_offset: number;
  reclaimedChars: number;
  finalChars: number;
  limitChars: number;
}

export interface ToolCallEvent extends BaseSidechainEvent {
  kind: 'ToolCall';
  tool: string;
  callId: string;
  arguments: Record<string, unknown>;
}

export interface ToolObservationEvent extends BaseSidechainEvent {
  kind: 'ToolObservation';
  tool: string;
  callId: string;
  success: boolean;
  outputLength: number;
  spillPath?: string;
}

export type SidechainEvent = CondensationEvent | ToolCallEvent | ToolObservationEvent;

export class SidechainEventLog {
  private events: SidechainEvent[] = [];

  public append(event: SidechainEvent): void {
    this.events.push(event);
  }

  public recordCondensation(
    forgottenIds: string[],
    summary: string,
    reclaimedChars: number,
    finalChars: number,
    limitChars: number
  ): CondensationEvent {
    const event: CondensationEvent = {
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

  public getEvents(): readonly SidechainEvent[] {
    return this.events;
  }

  public getForgottenIds(): ReadonlySet<string> {
    const set = new Set<string>();
    for (const event of this.events) {
      if (event.kind === 'Condensation') {
        for (const id of event.forgotten_event_ids) {
          set.add(id);
        }
      }
    }
    return set;
  }

  public serializeJsonl(): string {
    return this.events.map(e => JSON.stringify(e)).join('\n') + '\n';
  }
}
