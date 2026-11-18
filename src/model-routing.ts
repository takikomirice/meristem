import { createHash } from 'node:crypto';
import type { AgentChoice, ModelAssessment, ModelRoutingClassification } from './contracts.js';

export function sameAgentChoice(first: AgentChoice, second: AgentChoice): boolean {
  return first.model === second.model && first.effort === second.effort;
}

export function selectNextAgent(candidates: readonly AgentChoice[], previous: AgentChoice): AgentChoice | undefined {
  const index = candidates.findIndex(candidate => sameAgentChoice(candidate, previous));
  return index < 0 ? undefined : candidates[index + 1];
}

export type ModelSwitch = {
  agent: AgentChoice;
  previousAttemptId: string;
  sourceHead: string;
  planHash: string;
  stopGeneration: number;
  reason: ModelAssessment['reason'];
  evidenceRefs: string[];
};

export type ModelAttempt = {
  repositoryKey: string;
  planHash: string;
  classification: ModelRoutingClassification;
  requiredChecks: string[];
  phase: 'initial' | 'handoff';
  agent: AgentChoice | null;
  modelSwitch?: ModelSwitch;
  initialRecommendation?: InitialRecommendation;
  creationOperationId?: string;
};

export type InitialRecommendation = {
  planned: AgentChoice;
  recommended?: AgentChoice;
  selected: AgentChoice;
  reason: 'pinned' | 'summary_not_configured' | 'comparison_key_missing' | 'insufficient_evidence' | 'rules_advisory' | 'learned' | 'agent_not_in_catalog';
};

export type ModelOutcome = ModelAttempt & {
  runId: string;
  taskId: string;
  attemptId: string;
  result: 'accepted' | 'failed' | 'excluded' | 'unrated';
  reason: 'integrated' | 'review_accepted' | 'integration_evidence_unconfirmed' | ModelAssessment['reason'];
  evidenceRefs: string[];
  recordedAt: string;
  integrationSha?: string;
};

export type ModelOutcomeSummary = {
  repositoryKey: string;
  classification: ModelRoutingClassification;
  requiredChecksHash: string;
  agent: AgentChoice;
  initialAccepted: number;
  initialEvaluated: number;
  handoffAccepted: number;
  handoffEvaluated: number;
  completed: number;
  excluded: number;
};

export const MODEL_OUTCOME_LIMIT = 200;

export const requiredChecksHash = (checks: readonly string[]) =>
  createHash('sha256').update(JSON.stringify([...new Set(checks)].sort())).digest('hex');

export type ModelOutcomeSample = Pick<ModelOutcome, 'repositoryKey' | 'classification' | 'agent' | 'phase' | 'result' | 'runId' | 'attemptId'> & { requiredChecksHash: string };

export function summarizeModelOutcomes(samples: readonly (ModelOutcomeSample | ModelOutcome)[], includeUnrated = false): ModelOutcomeSummary[] {
  const summaries = new Map<string, ModelOutcomeSummary>();
  const seen = new Set<string>();
  for (const sample of samples) {
    const id = JSON.stringify([sample.repositoryKey, sample.runId, sample.attemptId]);
    if (seen.has(id) || !sample.agent || sample.result === 'unrated' && !includeUnrated) continue;
    seen.add(id);
    const { kind, complexity, comparison_key } = sample.classification;
    const classification = { kind, complexity, ...(comparison_key ? { comparison_key } : {}) };
    const checksHash = 'requiredChecksHash' in sample ? sample.requiredChecksHash : requiredChecksHash(sample.requiredChecks);
    const key = JSON.stringify([sample.repositoryKey, classification, checksHash, sample.agent.model, sample.agent.effort]);
    let summary = summaries.get(key);
    if (!summary) {
      summary = {
        repositoryKey: sample.repositoryKey, classification, requiredChecksHash: checksHash, agent: sample.agent,
        initialAccepted: 0, initialEvaluated: 0, handoffAccepted: 0, handoffEvaluated: 0, completed: 0, excluded: 0
      };
      summaries.set(key, summary);
    }
    if (sample.result === 'unrated') continue;
    if (sample.result === 'excluded') {
      summary.excluded++;
      continue;
    }
    if (sample.phase === 'initial') {
      summary.initialEvaluated++;
      if (sample.result === 'accepted') summary.initialAccepted++;
    } else {
      summary.handoffEvaluated++;
      if (sample.result === 'accepted') summary.handoffAccepted++;
    }
    if (sample.result === 'accepted') summary.completed++;
  }
  return [...summaries.values()];
}

// The caller supplies one matched comparison group. Cross-multiplication keeps
// an exact 20-point boundary and preserves candidate order on ties.
export function recommendInitialAgent(baseline: AgentChoice, candidates: readonly AgentChoice[], stats: readonly ModelOutcomeSummary[]): AgentChoice | undefined {
  const base = stats.find(row => sameAgentChoice(row.agent, baseline));
  if (!base || base.initialEvaluated < 5) return undefined;
  let best: ModelOutcomeSummary | undefined;
  for (const candidate of candidates) {
    const row = stats.find(row => sameAgentChoice(row.agent, candidate));
    if (!row || row.initialEvaluated < 5) continue;
    const difference = row.initialAccepted * base.initialEvaluated - base.initialAccepted * row.initialEvaluated;
    if (difference * 5 < base.initialEvaluated * row.initialEvaluated) continue;
    if (!best || row.initialAccepted * best.initialEvaluated > best.initialAccepted * row.initialEvaluated) best = row;
  }
  return best?.agent;
}
