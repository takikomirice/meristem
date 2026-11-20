import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeRequest, relayRequest } from '../../src/protocol.js';

// Store acquires writer ownership and reconciles on open. Observe the existing run read-only.
export function recordedWorkflow(directory: string, runId: string) {
  const db = new DatabaseSync(path.join(directory, 'control.sqlite'), { readOnly: true });
  try {
    db.exec('BEGIN');
    const rows = (sql: string) => db.prepare(sql).all(runId);
    return {
      workers: rows(`SELECT id AS attemptId, json_extract(registration,'$.taskId') AS taskId,
        state, json_extract(stop_result,'$.state') AS stopResult FROM attempts WHERE run_id=? ORDER BY rowid`),
      reports: rows(`SELECT operation_id AS reportRef, attempt_id AS attemptId, turn_id AS turnId,
        json_extract(payload,'$.status') AS status FROM reports WHERE run_id=? ORDER BY rowid`),
      tasks: rows(`SELECT task_id AS taskId, json_extract(payload,'$.state') AS state,
        json_extract(payload,'$.candidate.reportRef') AS editReportRef, json_extract(payload,'$.candidate.saveRef') AS saveRef,
        json_extract(payload,'$.candidate.candidateSha') AS candidateSha, json_extract(payload,'$.reviewEvidence.reportRef') AS reviewReportRef,
        json_extract(payload,'$.integrationSha') AS integrationSha FROM plan_task_state WHERE run_id=? ORDER BY rowid`),
      wakes: rows(`SELECT id AS operationId, state, source_seq AS sourceSeq, turn_id AS turnId,
        json_extract(parent,'$.threadId') AS threadId, json_extract(parent,'$.ownerId') AS ownerId,
        json_extract(parent,'$.ownerEpoch') AS ownerEpoch FROM wake_deliveries WHERE run_id=? ORDER BY rowid`),
      workerRequestsByKind: rows('SELECT kind, COUNT(*) AS count FROM requests WHERE run_id=? GROUP BY kind')
    };
  } finally { db.close(); }
}

export async function observeParent(entry: 'cli' | 'vscode', configFile: string, expectedThread: string) {
  if (!configFile || !path.isAbsolute(configFile) || !expectedThread) throw new Error('Supply the test control config and the independently recorded thread ID');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const parentRelay = config.mcp.parentRelay;
  if (parentRelay.mode !== 'verified-start' || (parentRelay.sessionKind ?? 'vscode') !== entry) throw new Error('Unexpected test session');
  const discovery = JSON.parse(readFileSync(path.join(config.stateDirectory, 'discovery.json'), 'utf8'));
  if (discovery.runId !== config.runId || discovery.pipeName !== config.pipeName) throw new Error('Discovery changed');
  const status = await pipeRequest(config.pipeName, { ...discovery, method: 'status', registrationOnly: true });
  const run = status.run as { id: string; state: string };
  if (!status.ok || run?.id !== config.runId) throw new Error('Run status unavailable');
  const binding = status.binding as { parent: string; state: string } | undefined;
  const parent = binding && JSON.parse(binding.parent);
  const workflow = recordedWorkflow(config.stateDirectory, run.id);
  const common = { entry, runId: run.id, capturedAt: new Date().toISOString(), runState: run.state,
    bindingState: binding?.state ?? 'none', registeredThreadMatches: parent?.threadId === expectedThread, ...workflow };
  // In the product the relay exposes these events only to its broker (or direct CLI launcher).
  if (config.cliTerminal || config.ideTerminal) return { ...common, relayObservation: 'owner_only' as const };
  const relay = await relayRequest(parentRelay.pipeName, 'relay/status');
  type RelayEvent = { seq: number; method: string; threadId: string; turnId: string };
  const events: RelayEvent[] = relay.events;
  const starts = events.filter(event => event.method === 'ui/turn/start');
  const acknowledgements = events.filter(event => event.method === 'turn/start/acked');
  return {
    ...common, relayObservation: 'available' as const,
    managementEnabled: relay.managementEnabled,
    expectedConversationObserved: relay.observedThreads.includes(expectedThread),
    observedConversationCount: relay.observedThreads.length,
    expectedConversationBound: !!parent && parent.threadId === expectedThread && parent.ownerId === relay.ownerId && parent.ownerEpoch === relay.ownerEpoch,
    visibleUiTurnStarts: starts.length,
    visibleStartsInOtherThreads: starts.filter(event => event.threadId !== expectedThread).length,
    acknowledgedStartsInOtherThreads: acknowledgements.filter(event => event.threadId !== expectedThread).length,
    firstRetainedEventSequence: events[0]?.seq ?? null, lastEventSequence: relay.lastEventSeq,
    observedWakeAcknowledgements: workflow.wakes.map(wake => ({
      operationId: wake.operationId,
      threads: acknowledgements.filter(event => event.turnId === wake.turnId).map(event => event.threadId)
    }))
  };
}
