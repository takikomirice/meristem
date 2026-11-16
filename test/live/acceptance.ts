import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/store.js';
import { install } from '../../src/install.js';
import { planControllerFixture } from '../fixtures/plan-controller.js';
import { git } from '../fixtures/serial-git.js';
import { serialGit } from './serial-git.js';
import { parallelMerge } from './parallel-merge.js';

export async function coordinationGuards() {
  const cleanup: (() => void)[] = [], f = await planControllerFixture({ after(fn) { cleanup.push(fn); } });
  try {
    await assert.rejects(f.create('B'));
    const worker = await f.create('A');
    await assert.rejects(f.call('send_instruction', { taskId: 'B', target: worker, text: 'wrong task', agent: { model: 'mock', effort: 'low' } }));
    await assert.rejects(f.call('record_decision', { taskId: 'A', decision: 'accept_candidate', candidateSha: f.store.gitAssignment(worker.attemptId)!.baseSha, evidenceRefs: [] }));
    const result = await f.complete('A', worker);
    const request = { key: 'approval', worker, cwd: result.assignment.cwd, turnId: 'turn', requestId: 1, kind: 'elicitation' as const, payloadHash: 'a'.repeat(64), formGeneration: 'form', state: 'pending' as const, detail: '', expiresAt: null };
    f.store.saveRequest('run', request);
    await assert.rejects(f.call('record_decision', { taskId: 'A', decision: 'accept_candidate', candidateSha: result.sha, evidenceRefs: [] }));
    f.store.saveRequest('run', { ...request, state: 'resolved' });
    await f.call('record_decision', { taskId: 'A', decision: 'accept_candidate', candidateSha: result.sha, evidenceRefs: [] });
    git(f.store.plan('run')!.pin.integrationCwd, 'merge', '--ff-only', result.sha);
    await assert.rejects(f.call('record_decision', { taskId: 'A', decision: 'accept_integration', integrationSha: result.sha, checks: [], evidenceRefs: [] }));
    await assert.rejects(f.create('B'));
    await f.call('stop_run');
    f.broker.report('run', worker); // late event is saved, never a resume signal
    await assert.rejects(f.create('B'));
    assert.equal(f.store.run('run').state, 'stopped');
    const attempts = f.store.attempts('run').map(a => a.id), starts = f.starts.length;
    cleanup.pop()!();
    const restarted = new Store(path.join(f.root, 'state'), f.repository);
    try {
      assert.equal(restarted.run('run').state, 'needs_reconcile');
      assert.deepEqual(restarted.attempts('run').map(a => a.id), attempts);
      assert.equal(f.starts.length, starts);
      assert.equal(restarted.reports('run').length, 1);
      assert.equal(git(result.assignment.cwd, 'rev-parse', 'HEAD'), result.sha);
    } finally { restarted.close(); }
    return { dependencyFence: true, wrongWorkerTaskRejected: true, selfAssertionRejected: true, missingIntegrationChecksRejected: true, stoppedLateReportDoesNotResume: true, restartDoesNotResurrectWorker: true };
  } finally { cleanup.forEach(close => close()); }
}

async function main() {
  const args = process.argv.slice(2), action = args.shift();
  const arg = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const run = (file: string, rest: string[]) => { const result = spawnSync(process.execPath, [path.resolve('dist/test/live', file), ...rest], { stdio: 'inherit', windowsHide: true }); assert.equal(result.status, 0, 'acceptance step failed'); };
  if (action === 'fixture') {
    const output = arg('--evidence'); assert(output && path.isAbsolute(output) && !existsSync(output));
    const guards = await coordinationGuards(), serial = await serialGit(), parallel = await parallelMerge();
    const evidence = { ...serial, testId: 'CC-07-acceptance', assertions: guards, scenarios: { serial, parallel }, limitations: ['Deterministic runtime and local bare remote only.', 'Human approval, skill/subagent compatibility, real VS Code and GitHub need separate observations.'] };
    writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ result: 'passed', evidence_kind: 'fixture' }));
  } else if (action === 'prepare') {
    assert(args.includes('--live'));
    const previousFile = arg('--previous'), root = arg('--root'), helper = arg('--helper-extension');
    assert(previousFile && root && helper && [previousFile, root, helper].every(path.isAbsolute));
    const previous = JSON.parse(readFileSync(previousFile, 'utf8')); assert(previous.phase === 'restored', 'previous fixture must be restored');
    const extensionDir = arg('--extension-dir');
    assert(extensionDir && path.isAbsolute(extensionDir), 'explicit official Codex extension directory required');
    const windowsSandbox = arg('--windows-sandbox') ?? previous.windowsSandbox;
    run('cc02-prepare.js', ['--stage', 'CC-07', '--live', '--root', root, '--real-exe', previous.realExe, '--auth-home', previous.authHome, '--code-exe', previous.codeExe, '--extension-dir', extensionDir, '--max-turns', arg('--max-turns') ?? '20', '--scenario', arg('--scenario') ?? 'parallel', ...(windowsSandbox ? ['--windows-sandbox', windowsSandbox] : [])]);
    const sessionFile = path.join(root, 'session.json'), session = JSON.parse(readFileSync(sessionFile, 'utf8'));
    symlinkSync(helper, path.join(session.extensions, path.basename(helper)), 'junction');
    const settings = path.join(session.profile, 'User', 'settings.json');
    writeFileSync(settings, readFileSync(path.join(previous.profile, 'User', 'settings.json')));
    const request = { implementationRoot: process.cwd(), realExe: session.realExe, nodeExe: process.execPath, helperExtension: helper, settings, codexConfig: session.authConfig, controlConfig: session.controlConfig, installDirectory: path.join(tmpdir(), 'meristem-cc07-install-' + randomUUID()), parentCwd: session.cwd };
    writeFileSync(path.join(root, 'install-request.json'), JSON.stringify(request, null, 2), { flag: 'wx' });
    // Prepare artifacts only. Explicit install/launch follows after review.
    session.installRequest = path.join(root, 'install-request.json'); session.packagedHelper = helper;
    writeFileSync(sessionFile, JSON.stringify(session, null, 2));
    console.log(JSON.stringify({ session: sessionFile, installRequest: session.installRequest, turnsSent: 0 }));
  } else if (action === 'install') {
    assert(args.includes('--live')); const file = arg('--session')!;
    const session = JSON.parse(readFileSync(file, 'utf8')); assert(session.stage === 'CC-07' && !session.installationReceipt);
    const result = install(JSON.parse(readFileSync(session.installRequest, 'utf8')));
    session.installationReceipt = result.receipt;
    writeFileSync(file, JSON.stringify(session, null, 2)); console.log(JSON.stringify(result));
  } else if (['launch', 'relaunch', 'open-parent', 'parent', 'status', 'reconcile', 'cleanup'].includes(action ?? '')) {
    run('cc02-session.js', [action!, ...args]);
  } else throw new Error('usage: acceptance fixture|prepare|install|launch|parent|status|reconcile|cleanup');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => { console.error(error); process.exitCode = 1; });
