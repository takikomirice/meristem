import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { confirmCliParent } from '../src/cli-parent.js';
import { planControllerFixture } from './fixtures/plan-controller.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
test('official CLI entry shows its commands without an authenticated session', () => {
  const help = spawnSync(process.execPath, [cli, 'terminal', 'help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  for (const action of ['setup', 'start', 'resume', 'status', 'usage', 'answer', 'stop']) assert.match(help.stdout, new RegExp(action));
});
test('piped input cannot start or authorize an interactive session', () => {
  const result = spawnSync(process.execPath, [cli, 'terminal', 'start'], { input: '1\ny\n', encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /対話端末/);
});

test('local consent uses the first caller, the displayed scope and the observed stop generation', async () => {
  const parent = { threadId: 'first', ownerId: 'owner', ownerEpoch: 'epoch' };
  const seen: string[] = [], answers = ['n', 'y'], calls: {method: string; params: any}[] = [];
  const control = {
    async parent(threadId: string) { assert.equal(threadId, parent.threadId); return parent; },
    async request(method: string, params?: object): Promise<Record<string, any>> {
      calls.push({ method, params });
      if (method === 'status') return { binding: { parent: JSON.stringify(parent) } };
      if (method === 'preview_parent_start') return { runId: 'one', state: 'needs_reconcile', stopGeneration: 3, scope: { gitDestination: 'fixture-origin', approvedMaximum: 2 }, scopeHash: 'displayed' };
      return { state: 'active' };
    }
  };
  const ui = { show(text: string) { seen.push(text); }, async ask() { return answers.shift()!; } };
  await confirmCliParent(control, ui);
  assert.deepEqual(calls.map(c => c.method), ['status', 'preview_parent_start']);
  await confirmCliParent(control, ui);
  assert.match(seen.join('\n'), /fixture-origin/);
  const last = calls.at(-1)!;
  assert.equal(last.method, 'resume_parent');
  assert.deepEqual(last.params.parent, parent);
  assert.equal(last.params.stopGeneration, 3);
  assert.equal(last.params.scopeHash, 'displayed');
});

test('consultation answers bind to the displayed proposal and expire on stop', async t => {
  const f = await planControllerFixture(t);
  const proposal = { taskIds: ['A'], blockingTaskIds: [], kind: 'consultation', recipient: 'human',
    question: '採用しますか', allowFreeText: false, options: [{ id: 'accept', label: '採用', description: 'この案を採用する' }],
    planHash: f.store.plan('run')!.snapshot.planHash };
  const first = await f.call('propose_decision', { proposal });
  const stale = f.controller.presentControlDecision(first.id);
  const current = f.controller.presentControlDecision(first.id);
  assert.throws(() => f.controller.resolveControlDecision(stale.form, { optionId: 'accept' }));
  assert.equal(f.controller.resolveControlDecision(current.form, { optionId: 'accept' }).state, 'resolved');
  const second = await f.call('propose_decision', { proposal });
  const pending = f.controller.presentControlDecision(second.id);
  await f.broker.stopRun('run');
  assert.throws(() => f.controller.resolveControlDecision(pending.form, { optionId: 'accept' }));
  assert.equal(f.store.coordinationDecision('run', second.id)!.decision.state, 'pending');
});
