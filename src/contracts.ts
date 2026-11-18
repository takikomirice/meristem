import { z } from 'zod';
export const Id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const ModelId = z.string().regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/);
export const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const DisplayName = z.string().refine(value => !/[\x00-\x1f\x7f-\x9f]/.test(value), 'control characters rejected').pipe(z.string().trim().min(1).max(128));
const OptionalLimit = z.number().int().positive().nullable().default(null);
export const ExecutionLimits = z.object({ maxWakeTurns: OptionalLimit, maxCorrectionsPerTask: OptionalLimit }).strict();
export type ExecutionLimits = z.infer<typeof ExecutionLimits>;
export const TaskAgent = z.object({ model: ModelId, effort: Id, permissionProfileId: Id }).strict();
export type TaskAgent = z.infer<typeof TaskAgent>;
export const AgentChoice = TaskAgent.pick({ model: true, effort: true });
export type AgentChoice = z.infer<typeof AgentChoice>;
export const READ_ONLY_PROFILE = 'meristem-read-only';
export const AppliedTaskSettings = z.object({
  agent: TaskAgent,
  permissions: z.object({ permissionProfileId: Id, approvalsReviewer: z.enum(['user', 'auto_review']), writableRoots: z.array(z.string().min(1).max(4096)).max(16) }),
  history: z.enum(['new', 'fresh_handoff']),
  sourceThreadId: Id.optional(),
  initialFallback: z.literal('agent_not_in_catalog').optional()
}).refine(({ agent, permissions }) => agent.permissionProfileId === 'read-only'
  ? permissions.permissionProfileId === READ_ONLY_PROFILE && permissions.writableRoots.length === 0
  : permissions.permissionProfileId !== READ_ONLY_PROFILE && permissions.writableRoots.length > 0, 'applied permissions do not match the assigned profile');
export type AppliedTaskSettings = z.infer<typeof AppliedTaskSettings>;
export const ModelRoutingClassification = z.object({
  kind: z.enum(['implementation', 'investigation', 'visual', 'routine']),
  complexity: z.enum(['bounded', 'complex']),
  comparison_key: Id.optional(),
  pin_initial: z.literal(true).optional()
}).strict();
export type ModelRoutingClassification = z.infer<typeof ModelRoutingClassification>;
export const ModelAssessment = z.object({
  attemptId: Id,
  reason: z.enum(['required_check_failed', 'investigation_stalled', 'unclear_instruction', 'environment', 'waiting_approval', 'integration_conflict', 'unknown']),
  checkName: z.string().min(1).max(128).optional()
}).strict().refine(value => (value.reason === 'required_check_failed') === (value.checkName !== undefined), 'check name is required only for a failed required check');
export type ModelAssessment = z.infer<typeof ModelAssessment>;
export const DecisionState = z.enum(['pending', 'resolved', 'cancelled', 'superseded']);
export type DecisionState = z.infer<typeof DecisionState>;
export const DecisionKind = z.enum(['consultation', 'plan_change', 'parallelism']);
export type DecisionKind = z.infer<typeof DecisionKind>;
const TaskIds = z.array(Id).max(128).refine(ids => new Set(ids).size === ids.length, 'duplicate task ID');
const DecisionText = z.string().trim().min(1).max(4096).refine(value => Buffer.byteLength(value, 'utf8') <= 8192, 'text too large');
export const Decision = z.object({
  id: Id, runId: Id, taskIds: TaskIds, kind: DecisionKind,
  recipient: z.enum(['coordinator', 'human']), blockingTaskIds: TaskIds,
  planHash: Hash, proposalHash: Hash, state: DecisionState,
  question: DecisionText,
  options: z.array(z.object({ id: Id, label: DisplayName, description: DecisionText }).strict()).max(16)
    .refine(options => new Set(options.map(option => option.id)).size === options.length, 'duplicate option ID'),
  requestedMaximum: z.number().int().min(1).max(128).optional(),
  proposedPlanHash: Hash.optional(),
  allowFreeText: z.boolean()
}).strict().refine(value => value.kind === 'parallelism' || value.requestedMaximum === undefined, 'maximum is only valid for parallelism')
  .refine(value => value.proposedPlanHash === undefined || value.kind === 'plan_change' && value.recipient === 'human', 'proposal hash target requires a human plan change')
  .refine(value => value.blockingTaskIds.every(id => value.taskIds.includes(id)), 'blocking task is outside decision scope')
  .refine(value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 32768, 'decision too large');
export type Decision = z.infer<typeof Decision>;
export const HumanDecisionRef = z.object({ decisionId: Id, planHash: Hash, proposalHash: Hash, formGeneration: Id }).strict();
export type HumanDecisionRef = z.infer<typeof HumanDecisionRef>;
export const TaskHold = z.object({ taskId: Id, decisionId: Id, releasedExecutionSlot: z.boolean() }).strict();
export type TaskHold = z.infer<typeof TaskHold>;
export const WorkerPresentation = z.object({
  displayName: DisplayName, taskId: Id, activity: DecisionText, activitySource: z.enum(['tool', 'worker']).nullable(),
  lastActivityAt: z.iso.datetime().nullable(), decisionIds: z.array(Id).max(128)
}).strict();
export type WorkerPresentation = z.infer<typeof WorkerPresentation>;
export const Owner = z.object({ ownerId: Id, ownerEpoch: Id }).strict();
export const Worker = Owner.extend({ threadId: Id, workerId: Id, attemptId: Id }).strict();
export type WorkerRef = z.infer<typeof Worker>;
export const Binding = z.object({ windowBindingId: Id, terminalId: Id, worker: Worker }).strict();
export type TerminalBinding = z.infer<typeof Binding>;
export const Operation = z.object({ operationId: Id, runId: Id, expectedRevision: z.number().int().nonnegative() }).strict();
export type OperationRef = z.infer<typeof Operation>;
export const Stop = z.object({ worker: Worker, state: z.enum(['interrupt_requested', 'stopping', 'stopped', 'unknown']), evidenceRefs: z.array(Id).max(32) }).strict();
export type StopResult = z.infer<typeof Stop>;
export const DecisionTransition = z.enum(['decision_proposed', 'decision_answered', 'decision_cancelled', 'decision_superseded', 'decision_revised', 'plan_change_applied']);
export const Event = z.object({ runId: Id, kind: z.enum(['registered', 'running', 'waiting_approval', 'waiting_input', 'authentication_required', 'limit_reached', 'failed', 'turn_completed', 'completed', 'report_saved', 'late_report', 'stopping', 'stopped', 'unknown', 'needs_reconcile', 'wake_limit', 'correction_limit', 'decision_changed', ...DecisionTransition.options]), attemptId: Id.optional() }).strict();
export type ControlEvent = z.infer<typeof Event>;
export type RunState = 'active' | 'stopped' | 'needs_reconcile' | 'completed';
export type DeliveryState = 'prepared' | 'sent_unknown' | 'acked' | 'settled' | 'cancelled';
export type Registration = {
  modelProvider?: string;
  settings?: AppliedTaskSettings;
  modelRouting?: import('./model-routing.js').ModelAttempt;
  displayName?: string;
  worker: WorkerRef; runId: string; taskId: string; assignmentId: string;
  cwd: string; repositoryId: string; branch: string; model: string; effort: string;
  hostPid: number; hostCreated: string; childPid: number; childCreated: string; jobId: string;
  binding: TerminalBinding;
};
export function sameWorker(a: WorkerRef, b: WorkerRef): boolean {
  return a.ownerId === b.ownerId && a.ownerEpoch === b.ownerEpoch && a.threadId === b.threadId && a.workerId === b.workerId && a.attemptId === b.attemptId;
}
