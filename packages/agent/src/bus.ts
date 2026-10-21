// The agent's internal event bus (§4.1): perception, reflexes and modules publish small typed events; modules
// that react to them read the state for details.

import { EventEmitter } from 'node:events';
import type { AgentEvent, AgentEventType } from '@agora/shared';

export type EventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;

export class AgentBus {
  private readonly ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(100);
  }

  emit(e: AgentEvent): void {
    this.ee.emit(e.type, e);
    this.ee.emit('*', e);
  }

  /** Subscribes to one event type; returns the unsubscribe function. */
  on<T extends AgentEventType>(type: T, handler: (e: EventOf<T>) => void): () => void {
    const h = handler as (e: AgentEvent) => void;
    this.ee.on(type, h);
    return () => this.ee.off(type, h);
  }

  onAny(handler: (e: AgentEvent) => void): () => void {
    this.ee.on('*', handler);
    return () => this.ee.off('*', handler);
  }
}
