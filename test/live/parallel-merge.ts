import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { planControllerFixture } from '../fixtures/plan-controller.js';
import { parallelPlan } from '../fixtures/parallel-git.js';
import { git, commitFile } from '../fixtures/serial-git.js';
import { fileHash } from '../../src/plan.js';
import type { WorkerRef } from '../../src/contracts.js';

// Deterministic local Git acceptance; never claims model or UI observations.
export async function parallelMerge() {
  const cleanup: (() => void)[] = [], f = await planControllerFixture({ after(fn) { cleanup.push(fn); } }, f => { parallelPlan(f); });
  try {
    writeFileSync(path.join(f.repository, 'original.txt'), 'user dirty workspace');
    const candidates: string[] = [], integrations: string[] = [];
    const check = (cwd: string, names: string[], sha: string) => names.map(name => {
      const args = name === 'integration' ? [...names.filter(n => n !== 'integration'), name] : [name];
      const r = spawnSync(process.execPath, ['checks.mjs', ...args], { cwd, encoding: 'utf8', windowsHide: true });
      assert.equal(r.status, 0, r.stderr);
      return { name, command: `node checks.mjs ${args.join(' ')}`, result: 'passed' as const, exit_code: 0, evidence_refs: ['fixture:checks'], checked_sha: sha };
    });
    const complete = async (taskId: string, worker: WorkerRef, filename: string, text: string) => {
      const a = f.store.gitAssignment(worker.attemptId)!, sha = commitFile(a.cwd, filename, text), checks = check(a.cwd, [taskId], sha);
      git(a.cwd, 'push', 'origin', a.branch);
      await f.call('report', { taskId, report: { task_id: taskId, worker_id: worker.workerId, attempt_id: worker.attemptId, actor_id: worker.threadId, status: 'completed', base_sha: a.baseSha, candidate_sha: sha, branch: a.branch, push_result: { status: 'pushed', remote: 'origin', branch: a.branch }, summary: 'checked', checks, remaining: [] } }, { actor: worker, turnId: 'turn' });
      f.store.completedTurn(worker, 'turn'); await f.broker.releaseCompleted('run', worker);
      await f.call('record_decision', { taskId, decision: 'accept_candidate', candidateSha: sha, evidenceRefs: [] });
      candidates.push(sha); return sha;
    };
    const cwd = () => f.store.plan('run')!.pin.integrationCwd;
    const integrate = async (taskId: string, inputs: string[], names: string[], resolve?: () => void) => {
      await f.call('record_decision', { taskId, decision: 'prepare_integration', inputCandidateShas: inputs, evidenceRefs: [] });
      for (const sha of inputs) git(cwd(), 'merge', '--no-edit', sha);
      resolve?.();
      const sha = git(cwd(), 'rev-parse', 'HEAD'), checks = check(cwd(), [...names, 'integration'], sha);
      await f.call('record_decision', { taskId, decision: 'accept_integration', integrationSha: sha, checks, evidenceRefs: [] });
      integrations.push(sha);
    };
    const a = await f.create('A'), b = await f.create('B');
    const one = await complete('A', a, 'a.txt', 'alpha'), two = await complete('B', b, 'b.txt', 'beta');
    await integrate('B', [one, two], ['A', 'B']);
    const c = await f.create('C'), d = await f.create('D');
    const three = await complete('C', c, 'price.mjs', "export const price = () => ({ amount: 100, currency: 'JPY' });\n");
    const four = await complete('D', d, 'view.mjs', "import { price } from './price.mjs'; export const view = () => 'JPY ' + (price() * 0.9);\n");
    let semanticFailure = false;
    await integrate('D', [three, four], ['A', 'B', 'C', 'D'], () => {
      const before = spawnSync(process.execPath, ['checks.mjs', 'C', 'D', 'integration'], { cwd: cwd(), encoding: 'utf8', windowsHide: true });
      assert.notEqual(before.status, 0); semanticFailure = true;
      commitFile(cwd(), 'view.mjs', "import { price } from './price.mjs'; export const view = () => { const p = price(); return p.currency + ' ' + (p.amount * 0.9); };\n");
    });
    assert.equal(readFileSync(path.join(f.repository, 'original.txt'), 'utf8'), 'user dirty workspace');
    return { planRevision: 2, testId: 'CC-06-parallel-merge', capturedAt: new Date().toISOString(), versions: { node: process.version, git: git(f.repository, '--version') }, route: 'extension_parent_cli_workers', evidence_kind: 'fixture', result: 'passed', actorAliases: ['P', 'A', 'B', 'C', 'D'], workerAttemptIds: ['A-1', 'B-1', 'C-1', 'D-1'], terminalBindings: [], operationIds: ['private-fixture-db'], eventSeqs: f.store.events('run', 0, 100).map(e => e.seq), requestedAgent: { model: 'mock', effort: 'low' }, observedSettings: { runtime: 'deterministic', gitRemote: 'local_bare' }, processIdentities: [], stopEvidence: { attemptsCompleted: f.store.attempts('run').every(a => a.state === 'completed') }, artifactHashes: { 'view.mjs': fileHash(readFileSync(path.join(cwd(), 'view.mjs'))) }, candidateShas: candidates, integrationShas: integrations, assertions: { cleanMerge: true, semanticFailureBeforeResolution: semanticFailure, checksBoundToResult: true, dirtySourcePreserved: true }, limitations: ['Runtime is deterministic; not real Codex/VS Code acceptance.', 'No GitHub push.', 'Tab closure is covered separately by native fixture and live UI observations.'] };
  } finally { cleanup.forEach(close => close()); }
}

async function main() {
  const args = process.argv.slice(2), action = args.shift();
  const arg = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  if (action === 'fixture') {
    const output = arg('--evidence'); assert(output && path.isAbsolute(output) && !existsSync(output));
    const evidence = await parallelMerge(); writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ result: evidence.result }));
  } else if (action === 'prepare') {
    const r = spawnSync(process.execPath, [path.resolve('dist/test/live/cc02-prepare.js'), ...args, '--stage', 'CC-06'], { stdio: 'inherit', windowsHide: true }); process.exitCode = r.status ?? 1;
  } else {
    const file = arg('--session'); assert(file && path.isAbsolute(file)); const session = JSON.parse(readFileSync(file, 'utf8')); assert.equal(session.stage, 'CC-06');
    if (action === 'evidence') {
      const output = arg('--output'); assert(output && path.isAbsolute(output) && !existsSync(output));
      const db = new DatabaseSync(path.join(session.stateDirectory, 'control.sqlite'), { readOnly: true });
      try {
        const instructions = Number(db.prepare('SELECT COUNT(*) AS n FROM instruction_reservations').get()!.n);
        const parentTurns = Array.from({ length: session.approvedMaxTurns - 6 }, (_, i) => path.join(session.root, `parent-turn-${i + 1}.json`)).filter(existsSync).length;
        assert(parentTurns + instructions <= session.approvedMaxTurns);
        const attempts = db.prepare('SELECT state,registration,stop_result FROM attempts ORDER BY rowid').all().map((r, i) => { const a = JSON.parse(r.registration as string); return { alias: a.taskId, attempt: i + 1, state: r.state, processIdentity: { hostPid: a.hostPid, hostCreated: a.hostCreated, childPid: a.childPid, childCreated: a.childCreated, jobId: a.jobId }, terminalBinding: a.binding, stop: r.stop_result ? JSON.parse(r.stop_result as string) : null }; });
        const tasks = db.prepare('SELECT task_id,payload FROM plan_task_state').all().map(r => ({ task: r.task_id, state: JSON.parse(r.payload as string) }));
        writeFileSync(output, JSON.stringify({ planRevision: 2, testId: 'CC-06-live', capturedAt: new Date().toISOString(), route: 'extension_parent_cli_workers', evidence_kind: 'real_codex', result: 'unknown', versions: { node: process.version, realSha256: session.realSha256, nodeSha256: session.nodeSha256 }, actorAliases: attempts.map(a => a.alias), workerAttemptIds: attempts.map(a => a.attempt), terminalBindings: attempts.map(a => a.terminalBinding), processIdentities: attempts.map(a => a.processIdentity), stopEvidence: attempts.map(a => a.stop), requestedAgent: session.agent, attempts, tasks, parentTurns, instructions, approvedMaxTurns: session.approvedMaxTurns, limitations: ['Observations require human UI review; this command does not infer acceptance or approval.', 'Local bare remote only.'] }, null, 2) + '\n', { flag: 'wx' });
      } finally { db.close(); }
    } else {
      assert(['launch', 'status', 'parent', 'reconcile', 'cleanup', 'open-parent'].includes(action!));
      const r = spawnSync(process.execPath, [path.resolve('dist/test/live/cc02-session.js'), action!, ...args], { stdio: 'inherit', windowsHide: true }); process.exitCode = r.status ?? 1;
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
