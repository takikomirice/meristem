import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveCallerIdentity, resolveCallContext } from '../src/actors.js';

const actor = { ownerId: 'owner', ownerEpoch: 'epoch', threadId: 'parent' };
const peer = { pid: 123, created: '456' };
const proof = { actor, peer, turnId: 'turn' };
const meta = { 'x-codex-turn-metadata': { thread_id: 'parent', turn_id: 'turn' } };
test('requires_actual_metadata_and_owned_peer', () => {
  assert.deepEqual(resolveCallerIdentity(meta, peer, proof), { actor, turnId: 'turn' });
  for (const [metadata, connection, binding] of [[{}, peer, proof], [meta, { ...peer, created: 'old' }, proof], [{ 'x-codex-turn-metadata': { thread_id: 'parent', turn_id: 'old' } }, peer, proof], [meta, peer, { ...proof, actor: { ...actor, threadId: 'subagent' } }]]) {
    assert.throws(() => resolveCallerIdentity(metadata, connection, binding), /identity/);
  }
});
test('worker_cannot_bootstrap_parent_and_subagent_report_is_not_main_worker_report', () => {
  const binding = { runId: 'run', parent: actor, workers: [{ ...actor, threadId: 'worker' }] };
  assert.equal(resolveCallContext({ actor, turnId: 'turn' }, binding).role, 'parent');
  assert.equal(resolveCallContext({ actor: { ...actor, threadId: 'worker' }, turnId: 'turn' }, binding).role, 'worker');
  assert.throws(() => resolveCallContext({ actor: { ...actor, threadId: 'subagent' }, turnId: 'turn' }, binding), /registered/);
  assert.throws(() => resolveCallContext({ actor: { ...actor, ownerEpoch: 'old' }, turnId: 'turn' }, binding), /registered/);
});
