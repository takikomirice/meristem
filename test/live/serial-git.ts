import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { planControllerFixture } from '../fixtures/plan-controller.js';
import { git, checks } from '../fixtures/serial-git.js';
import { fileHash } from '../../src/plan.js';

// Real local Git, deterministic runtime. No model, GUI or GitHub requests.
export async function serialGit() {
  const cleanup: (() => void)[] = [], f = await planControllerFixture({ after(fn) { cleanup.push(fn); } });
  try {
    const original = path.join(f.repository, 'original.txt'); writeFileSync(original, 'user dirty workspace');
    const first = await f.create('A'), one = await f.complete('A', first);
    await f.call('record_decision', { taskId: 'A', decision: 'accept_candidate', candidateSha: one.sha, evidenceRefs: [] });
    await assert.rejects(f.create('B'));
    await f.call('record_decision', { taskId: 'A', decision: 'retry_same', evidenceRefs: [] });
    const correction = await f.create('A');
    assert.equal(correction.threadId, first.threadId); assert.notEqual(correction.attemptId, first.attemptId); assert.notEqual(correction.ownerEpoch, first.ownerEpoch);
    const two = await f.complete('A', correction, 'corrected');
    await f.call('record_decision', { taskId: 'A', decision: 'accept_candidate', candidateSha: two.sha, evidenceRefs: [] });
    const pin = f.store.plan('run')!.pin; git(pin.integrationCwd, 'merge', '--ff-only', two.sha); git(pin.integrationCwd, 'diff', '--check', pin.initialSha, two.sha);
    await f.call('record_decision', { taskId: 'A', decision: 'accept_integration', integrationSha: two.sha, checks, evidenceRefs: [] });
    const second = await f.create('B'); assert.notEqual(second.threadId, correction.threadId);
    const three = await f.complete('B', second, 'handoff');
    assert.equal(three.assignment.baseSha, two.sha);
    await f.call('record_decision', { taskId: 'B', decision: 'accept_candidate', candidateSha: three.sha, evidenceRefs: [] });
    git(pin.integrationCwd, 'merge', '--ff-only', three.sha); git(pin.integrationCwd, 'diff', '--check', two.sha, three.sha);
    await f.call('record_decision', { taskId: 'B', decision: 'accept_integration', integrationSha: three.sha, checks, evidenceRefs: [] });
    const status = await f.status(); await f.call('write_progress', { expectedFileHash: status.plan.fileHash });
    await f.call('record_decision', { taskId: 'B', decision: 'finish', evidenceRefs: [] });
    assert.equal(f.store.run('run').state, 'completed'); assert.equal(readFileSync(original, 'utf8'), 'user dirty workspace');
    assert.equal(readFileSync(path.join(pin.integrationCwd, 'a.txt'), 'utf8'), 'corrected'); assert.equal(readFileSync(path.join(pin.integrationCwd, 'b.txt'), 'utf8'), 'handoff');
    const evidence = {
      planRevision: 2, testId: 'CC-05-serial-git', capturedAt: new Date().toISOString(), versions: { node: process.version, git: git(f.repository, '--version') }, route: 'extension_parent_cli_workers',
      evidence_kind: 'fixture', result: 'passed', actorAliases: ['P', 'A', 'A-correction', 'B'], workerAttemptIds: ['A-1', 'A-2', 'B-1'], terminalBindings: [], operationIds: ['recorded-in-private-fixture-db'], eventSeqs: f.store.events('run', 0, 100).map(e => e.seq),
      requestedAgent: { model: 'mock', effort: 'low' }, observedSettings: { runtime: 'deterministic', gitRemote: 'local_bare' }, processIdentities: [], stopEvidence: { kind: 'fixture', attemptsCompleted: f.store.attempts('run').every(a => a.state === 'completed') },
      artifactHashes: { 'a.txt': fileHash(readFileSync(path.join(pin.integrationCwd, 'a.txt'))), 'b.txt': fileHash(readFileSync(path.join(pin.integrationCwd, 'b.txt'))) },
      candidateShas: [one.sha, two.sha, three.sha], integrationShas: [two.sha, three.sha], assertions: { sameHistoryNewAttempt: true, newHandoffHistory: true, dependencyBaseIncludesIntegration: true, dirtySourcePreserved: true, progressPreservesProse: readFileSync(f.planPath, 'utf8').startsWith('notes\n') },
      limitations: ['Runtime lifecycle/identity is a deterministic fixture; not real Codex or VS Code acceptance.', 'Local bare remote only; no GitHub acceptance.', 'CC-06 parallel dispatch and CC-07 installation excluded.']
    };
    return evidence;
  } finally { for (const close of cleanup) close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--evidence' || !path.isAbsolute(process.argv[3])) throw new Error('usage: serial-git --evidence <new absolute JSON path>');
  const result = await serialGit(); writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ result: result.result, evidence_kind: result.evidence_kind }));
}
