import { z } from 'zod';
export const Id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const ModelId = z.string().regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/);
export const Owner = z.object({ ownerId: Id, ownerEpoch: Id }).strict();
export const Worker = Owner.extend({ threadId: Id, workerId: Id, attemptId: Id }).strict();
export type WorkerRef = z.infer<typeof Worker>;
export const Binding = z.object({ windowBindingId: Id, terminalId: Id, worker: Worker }).strict();
export type TerminalBinding = z.infer<typeof Binding>;
export const Operation = z.object({ operationId: Id, runId: Id, expectedRevision: z.number().int().nonnegative() }).strict();
export type OperationRef = z.infer<typeof Operation>;
export const Stop = z.object({ worker: Worker, state: z.enum(['interrupt_requested', 'stopping', 'stopped', 'unknown']), evidenceRefs: z.array(Id).max(32) }).strict();
export type StopResult = z.infer<typeof Stop>;
export const Event = z.object({ runId: Id, kind: z.enum(['registered', 'running', 'waiting_approval', 'waiting_input', 'authentication_required', 'limit_reached', 'failed', 'turn_completed', 'completed', 'report_saved', 'late_report', 'stopping', 'stopped', 'unknown', 'needs_reconcile', 'wake_limit', 'correction_limit']), attemptId: Id.optional() }).strict();
export type ControlEvent = z.infer<typeof Event>;
export type RunState = 'active' | 'stopped' | 'needs_reconcile' | 'completed';
export type DeliveryState = 'prepared' | 'sent_unknown' | 'acked' | 'settled' | 'cancelled';
export type Registration = {
  worker: WorkerRef; runId: string; taskId: string; assignmentId: string;
  cwd: string; repositoryId: string; branch: string; model: string; effort: string;
  hostPid: number; hostCreated: string; childPid: number; childCreated: string; jobId: string;
  binding: TerminalBinding;
};
export function sameWorker(a: WorkerRef, b: WorkerRef): boolean {
  return a.ownerId === b.ownerId && a.ownerEpoch === b.ownerEpoch && a.threadId === b.threadId && a.workerId === b.workerId && a.attemptId === b.attemptId;
}
