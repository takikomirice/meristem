// Explicit CC-03 runner. Setup/manual seed turns reuse CC-02; continuous wake belongs to the broker.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { relayRequest } from '../../src/protocol.js';

const args = process.argv.slice(2), action = args.shift();
const arg = (name: string) => args[args.indexOf(name) + 1];
if (action === 'prepare') {
  const result = spawnSync(process.execPath, [path.resolve('dist/test/live/cc02-prepare.js'), ...args, '--stage', 'CC-03'], { stdio: 'inherit', windowsHide: true }); process.exitCode = result.status ?? 1;
} else if (action === 'evidence') {
  const file = arg('--session'); assert(path.isAbsolute(file)); const session = JSON.parse(readFileSync(file, 'utf8'));
  assert(session.stage === 'CC-03'); const db = new DatabaseSync(path.join(session.stateDirectory, 'control.sqlite'), { readOnly: true });
  try {
    const attempts = db.prepare('SELECT id,state,registration,stop_result FROM attempts ORDER BY rowid').all().map(row => ({ attemptId: row.id, state: row.state, worker: JSON.parse(row.registration as string).worker, stop: row.stop_result ? JSON.parse(row.stop_result as string) : null }));
    const reports = db.prepare('SELECT attempt_id,turn_id FROM reports').all();
    const wakes = db.prepare('SELECT id,state,source_seq,stop_generation,turn_id FROM wake_deliveries').all();
    const instructions = db.prepare('SELECT operation_id FROM instruction_reservations').all();
    const seedTurns = [1, 2].filter(n => existsSync(path.join(session.root, `parent-turn-${n}.json`))).length;
    const consumed = seedTurns + instructions.length + wakes.filter(row => row.state === 'acked' || row.state === 'sent_unknown').length;
    assert(consumed <= session.approvedMaxTurns);
    let parent: any; try { parent = await relayRequest(session.parentPipe, 'relay/status'); } catch {}
    const evidence = { stage: 'CC-03', run: db.prepare('SELECT * FROM runs').get(), attempts, reports, wakes, cursor: db.prepare('SELECT * FROM wake_cursors').get(), consumed, approvedMaxTurns: session.approvedMaxTurns, parentEvents: parent?.events ?? [], UI: { active: 'not_observed', idle: 'protocol_only', hidden: 'not_run', panelClosed: 'not_run', vscodeExit: 'not_run' } };
    const output = arg('--output'); assert(output && path.isAbsolute(output)); writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ output, consumed, attempts: attempts.length, reports: reports.length, wakes: wakes.length }));
  } finally { db.close(); }
} else {
  assert(['launch', 'status', 'parent', 'reconcile', 'cleanup', 'open-parent'].includes(action!));
  const session = JSON.parse(readFileSync(arg('--session'), 'utf8')); assert(session.stage === 'CC-03');
  const result = spawnSync(process.execPath, [path.resolve('dist/test/live/cc02-session.js'), action!, ...args], { stdio: 'inherit', windowsHide: true }); process.exitCode = result.status ?? 1;
}
