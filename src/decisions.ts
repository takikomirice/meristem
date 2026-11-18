import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Decision, HumanDecisionRef, Id } from './contracts.js';
import type { OperationRef } from './contracts.js';
import { fileHash, type PlanSnapshot } from './plan.js';
import { Store } from './store.js';

export const DecisionAnswer = z.object({ optionId: Id.optional(), text: z.string().trim().min(1).max(8192).refine(value => Buffer.byteLength(value) <= 16384).optional() }).strict().refine(value => value.optionId !== undefined || value.text !== undefined);
export type DecisionAnswer = z.infer<typeof DecisionAnswer>;
export type DecisionProposal = Omit<Decision, 'id' | 'runId' | 'proposalHash' | 'state'>;

// The broker supplies authenticated actor scope. MC-02/03 supply the trusted UI
// adapter. No serialized humanApproved flag is an authentication mechanism.
export class DecisionService {
  constructor(
    private store: Store,
    private authorize: (ref: OperationRef, taskIds: string[], coordinatorOnly: boolean) => void,
    private verifyHuman: (context: unknown, form: HumanDecisionRef, answer: DecisionAnswer) => OperationRef | undefined,
  ) {}

  propose(ref: OperationRef, input: DecisionProposal, draftPlan?: PlanSnapshot): Decision {
    if (input.proposedPlanHash !== draftPlan?.planHash) throw new Error('plan draft target mismatch');
    if (input.kind === 'parallelism' && (!input.requestedMaximum || !input.taskIds.length || !input.options.some(option => option.id === 'approve'))) throw new Error('parallelism maximum and approval choice required');
    const tasks = input.kind === 'parallelism' ? this.store.plan(ref.runId)?.snapshot.plan.tasks.filter(task => input.taskIds.includes(task.id)) : undefined;
    const question = tasks ? `${input.question}\n\n担当設定: ${tasks.map(task => `${task.id} (${task.agent?.model ?? 'unspecified'} / ${task.agent?.effort ?? 'unspecified'})`).join(', ')}` : input.question;
    const draft = Decision.parse({ ...input, question, id: ref.operationId, runId: ref.runId, proposalHash: '0'.repeat(64), state: 'pending' });
    const { id, runId, proposalHash: _, state, ...proposal } = draft;
    const decision = { ...draft, proposalHash: fileHash(JSON.stringify(proposal)) };
    this.authorize(ref, decision.taskIds, decision.kind !== 'consultation');
    if (decision.kind !== 'consultation' && decision.recipient !== 'human') throw new Error('human decision required');
    return this.store.coordinationOperation(ref, fileHash(JSON.stringify(['propose', decision])), () => {
      this.assertCurrent(decision);
      if (this.store.coordinationDecision(ref.runId, id)) throw new Error('decision already exists');
      if (decision.kind === 'parallelism') this.store.supersedeParallelismDecisions(ref.runId);
      if (draftPlan) this.store.savePlanRevision(ref.runId, draftPlan);
      this.store.saveCoordinationDecision(decision);
      this.store.appendEvent({ runId: ref.runId, kind: 'decision_proposed' }, decision.kind);
      return decision;
    });
  }

  present(ref: OperationRef, decisionId: string): HumanDecisionRef {
    this.authorize(ref, [], true);
    return this.store.coordinationOperation(ref, fileHash(JSON.stringify(['present', decisionId])), () => {
      const decision = this.pending(ref.runId, decisionId);
      if (decision.recipient !== 'human') throw new Error('human decision required');
      const formGeneration = randomUUID();
      this.store.saveCoordinationDecision(decision, formGeneration);
      return { decisionId, planHash: decision.planHash, proposalHash: decision.proposalHash, formGeneration };
    });
  }

  resolveCoordinator(ref: OperationRef, decisionId: string, answer: DecisionAnswer): Decision {
    this.authorize(ref, [], true);
    return this.resolve(ref, decisionId, answer, 'coordinator');
  }

  resolveHuman(form: HumanDecisionRef, answer: DecisionAnswer, verifiedHumanContext: unknown): Decision {
    const safeForm = HumanDecisionRef.parse(form), safeAnswer = DecisionAnswer.parse(answer);
    const ref = this.verifyHuman(verifiedHumanContext, safeForm, safeAnswer);
    if (!ref) throw new Error('verified human context required');
    return this.resolve(ref, safeForm.decisionId, safeAnswer, 'human', safeForm);
  }

  close(ref: OperationRef, decisionId: string, state: 'cancelled' | 'superseded'): Decision {
    this.authorize(ref, [], true);
    if (!['cancelled', 'superseded'].includes(state)) throw new Error('invalid terminal state');
    return this.store.coordinationOperation(ref, fileHash(JSON.stringify(['close', decisionId, state])), () => {
      const record = this.store.coordinationDecision(ref.runId, decisionId);
      const approvedUnapplied = this.store.planChangeAgreement(ref.runId, decisionId) && !this.store.coordinationRevision(ref.runId, decisionId);
      if (!record || !(record.decision.state === 'pending' || approvedUnapplied)) throw new Error('decision is not pending or unapplied');
      const decision = { ...record.decision, state };
      this.store.saveCoordinationDecision(decision, null, record.answer);
      this.store.releaseDecisionHolds(ref.runId, decisionId);
      this.store.appendEvent({ runId: ref.runId, kind: state === 'cancelled' ? 'decision_cancelled' : 'decision_superseded' }, decision.kind);
      return decision;
    });
  }

  private assertCurrent(decision: Decision): void {
    const plan = this.store.plan(decision.runId);
    if (!plan || plan.frozen || plan.snapshot.planHash !== decision.planHash) throw new Error('stale decision plan');
    if (decision.taskIds.some(id => !plan.snapshot.plan.tasks.some(task => task.id === id))) throw new Error('unknown decision task');
  }

  private pending(runId: string, decisionId: string): Decision {
    const decision = this.store.coordinationDecision(runId, decisionId)?.decision;
    if (!decision || decision.state !== 'pending') throw new Error('decision is not pending');
    this.assertCurrent(decision);
    return decision;
  }

  private resolve(ref: OperationRef, decisionId: string, input: DecisionAnswer, recipient: Decision['recipient'], form?: HumanDecisionRef): Decision {
    const answer = DecisionAnswer.parse(input);
    return this.store.coordinationOperation(ref, fileHash(JSON.stringify(['resolve', decisionId, answer, recipient, form])), () => {
      const decision = this.pending(ref.runId, decisionId);
      if (decision.recipient !== recipient) throw new Error('decision recipient mismatch');
      if (form && (form.planHash !== decision.planHash || form.proposalHash !== decision.proposalHash || form.formGeneration !== this.store.coordinationDecision(ref.runId, decisionId)!.formGeneration)) throw new Error('stale decision form');
      if (answer.optionId && !decision.options.some(option => option.id === answer.optionId)) throw new Error('unknown decision option');
      if (answer.text && !decision.allowFreeText) throw new Error('free text is not allowed');
      // The form labels free text alongside choices as a revised proposal.
      // Never infer consent to the original choices from that text, even if a
      // choice is also selected. Open consultations still accept text answers.
      if (recipient === 'human' && decision.options.length && answer.text) {
        const superseded = { ...decision, state: 'superseded' as const };
        if (decision.proposedPlanHash) {
          // An amendment requires a fresh structured diff and form.
          this.store.saveCoordinationDecision(superseded, null, answer);
          this.store.releaseDecisionHolds(ref.runId, decisionId);
          this.store.appendEvent({ runId: ref.runId, kind: 'decision_superseded' }, decision.kind);
          return superseded;
        }
        const { id: _, runId: __, proposalHash: ___, state: ____, ...proposal } = decision;
        const revised = { ...proposal, question: answer.text };
        const replacement = Decision.parse({ ...revised, id: ref.operationId, runId: ref.runId, proposalHash: fileHash(JSON.stringify(revised)), state: 'pending' });
        if (this.store.coordinationDecision(ref.runId, replacement.id)) throw new Error('decision already exists');
        this.store.saveCoordinationDecision(superseded, null, answer);
        this.store.saveCoordinationDecision(replacement);
        this.store.releaseDecisionHolds(ref.runId, decisionId);
        this.store.appendEvent({ runId: ref.runId, kind: 'decision_revised' }, decision.kind);
        return replacement;
      }
      const resolved = { ...decision, state: 'resolved' as const };
      this.store.saveCoordinationDecision(resolved, null, answer);
      if (recipient === 'human' && decision.kind === 'parallelism' && answer.optionId === 'approve' && !answer.text) this.store.saveParallelismApproval(ref.runId, decision.id, decision.requestedMaximum!);
      if (!this.store.planChangeAgreement(ref.runId, decisionId)) this.store.releaseDecisionHolds(ref.runId, decisionId);
      this.store.appendEvent({ runId: ref.runId, kind: 'decision_answered' }, decision.kind);
      return resolved;
    });
  }
}
