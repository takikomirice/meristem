// Explicit CC-04 live controls. Human decisions are made only in the real UI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2), action = args.shift();
const arg = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
if (action === 'prepare') {
  const result = spawnSync(process.execPath, [path.resolve('dist/test/live/cc02-prepare.js'), ...args, '--stage', 'CC-04'], { stdio: 'inherit', windowsHide: true }); process.exitCode = result.status ?? 1;
} else {
  const file = arg('--session'); assert(file && path.isAbsolute(file));
  const session = JSON.parse(readFileSync(file, 'utf8')); assert.equal(session.stage, 'CC-04');
  if (action === 'evidence') {
    const output = arg('--output'); assert(output && path.isAbsolute(output) && !existsSync(output));
    const db = new DatabaseSync(path.join(session.stateDirectory, 'control.sqlite'), { readOnly: true });
    try {
      const requests = db.prepare('SELECT id,attempt_id,kind,state,payload_hash,form_generation FROM requests WHERE run_id=?').all('cc04');
      const attempts = db.prepare('SELECT id,state,stop_result FROM attempts WHERE run_id=?').all('cc04');
      const instructions = Number(db.prepare('SELECT COUNT(*) AS n FROM instruction_reservations WHERE run_id=?').get('cc04')!.n);
      const turnsSent = Array.from({ length: session.approvedMaxTurns }, (_, i) => path.join(session.root, `parent-turn-${i + 1}.json`)).filter(existsSync).length;
      assert(turnsSent + instructions <= session.approvedMaxTurns);
      const artifacts = session.assignments.map((a: any) => { const file = path.join(a.cwd, 'cc04-result.txt'); return { workerId: a.workerId, exists: existsSync(file), ...(existsSync(file) ? { sha256: createHash('sha256').update(readFileSync(file)).digest('hex') } : {}) }; });
      // Observations only: this cannot infer human UI choices or declare acceptance.
      writeFileSync(output, JSON.stringify({ stage: 'CC-04', result: 'observed_requires_UI_review', runtime: { realExe: session.realExe, realSha256: session.realSha256, nodeSha256: session.nodeSha256 }, requests, attempts, artifacts, turnsSent, instructions, approvedMaxTurns: session.approvedMaxTurns }, null, 2) + '\n', { flag: 'wx' });
      console.log(JSON.stringify({ output, requests: requests.length }));
    } finally { db.close(); }
  } else {
    assert(['launch', 'status', 'parent', 'reconcile', 'cleanup', 'open-parent'].includes(action!));
    const result = spawnSync(process.execPath, [path.resolve('dist/test/live/cc02-session.js'), action!, ...args], { stdio: 'inherit', windowsHide: true }); process.exitCode = result.status ?? 1;
  }
}
