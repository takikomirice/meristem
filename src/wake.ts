import type { ActorRef } from './actors.js';
import { sameActor } from './actors.js';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
export type WakeRef = { runId: string; sourceEventSeq: number };
export type WakeResult = { state: 'deferred' | 'acked' | 'sent_unknown' | 'stopped' | 'empty'; turnId?: string };
const candidates = new Set(['completed', 'failed', 'authentication_required', 'limit_reached', 'waiting_input', 'waiting_approval', 'decision_changed', 'usage_recovered']);
export class WakeCoordinator {
  private busy = new Set<string>();
  constructor(private store: Store, private parent: ActorRef, private agent: { model: string; effort: string }, private relay: (method: string, params: Record<string, unknown>) => Promise<any>, private stop: (runId: string, reason: string) => Promise<unknown> = async runId => store.stopRun(runId), private limit: number | null | ((runId: string) => number | null) = null, private canWake: (runId: string) => boolean = runId => store.run(runId).state === 'active') {
    if (typeof limit !== 'function' && limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw Error('invalid wake budget');
  }
  enqueueWake(runId: string, sourceEventSeq: number): WakeRef {
    const event = this.store.events(runId, sourceEventSeq - 1, 1)[0];
    if (event?.seq !== sourceEventSeq || !candidates.has(String(event.kind))) throw Error('not a wake event');
    if (this.store.run(runId).state === 'active') this.store.wakeProgress(runId, 'pending_seq', sourceEventSeq);
    return { runId, sourceEventSeq };
  }
  async deliverWakeIfIdle(runId: string): Promise<WakeResult> {
    if (this.busy.has(runId)) return { state: 'deferred' };
    this.busy.add(runId);
    try {
      const run = this.store.run(runId); let cursor = this.store.wakeCursor(runId);
      if (!this.canWake(runId) || this.store.wakeUnknown(runId)) return { state: 'stopped' };
      if (cursor.pending_seq <= Math.max(cursor.delivered_seq, cursor.read_seq)) return { state: 'empty' };
      let status: any;
      try { status = await this.relay('relay/wake-state', { ...this.parent }); } catch { return { state: 'deferred' }; }
      if (!status.supported || !status.idle || !sameActor(status, this.parent)) return { state: 'deferred' };
      const current = this.store.run(runId);
      if (!this.canWake(runId) || current.stop_generation !== run.stop_generation) return { state: 'stopped' };
      cursor = this.store.wakeCursor(runId);
      if (cursor.pending_seq <= Math.max(cursor.delivered_seq, cursor.read_seq)) return { state: 'empty' };
      const limit = typeof this.limit === 'function' ? this.limit(runId) : this.limit;
      if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw Error('invalid wake budget');
      if (limit !== null && this.store.wakeCount(runId) >= limit) {
        await this.stop(runId, 'wake_limit'); this.store.appendEvent({ runId, kind: 'wake_limit' }); return { state: 'stopped' };
      }
      const operationId = randomUUID();
      this.store.reserveWake(operationId, runId, cursor.pending_seq, this.parent);
      try {
        // Only identifiers and a fixed instruction cross this boundary. Child prose is read as data via get_status.
        const result = await this.relay('relay/wake', { ...this.parent, ...this.agent, stateSeq: status.stateSeq, operationId, runId, sourceEventSeq: cursor.pending_seq });
        if (result.state === 'deferred') { this.store.settleWake(operationId, 'cancelled'); return { state: 'deferred' }; }
        if (result.state !== 'acked' || typeof result.turnId !== 'string') throw Error('wake delivery unknown');
        this.store.settleWake(operationId, 'acked', result.turnId);
        this.store.wakeProgress(runId, 'delivered_seq', cursor.pending_seq);
        return { state: 'acked', turnId: result.turnId };
      } catch {
        await this.stop(runId, 'wake_unknown'); return { state: 'sent_unknown' };
      }
    } finally { this.busy.delete(runId); }
  }
  async monitor(runId: string): Promise<WakeResult> {
    const cursor = this.store.wakeCursor(runId);
    for (const event of this.store.events(runId, cursor.scanned_seq, 100)) {
      if (candidates.has(String(event.kind)) && (event.kind !== 'completed' || (typeof event.attempt_id === 'string' && this.store.hasFinalReport(runId, event.attempt_id)))) this.enqueueWake(runId, Number(event.seq));
      this.store.wakeProgress(runId, 'scanned_seq', Number(event.seq));
    }
    return this.deliverWakeIfIdle(runId);
  }
}
