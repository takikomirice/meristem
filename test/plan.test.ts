import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readPlan, eligibleTasks, writeProgress } from '../src/plan.js';

export function planDocument(repository: string, root: string) {
  return { schema_version: 1, run: { repository, worktrees_root: root, integration_branch: 'cc05-integration', max_parallel: 1 }, tasks: [
    { id: 'A', depends_on: [], scope: ['a.txt'], conflicts_with: ['lockfile'], agent: { model: 'mock', effort: 'low' }, continuation: { mode: 'new' }, completion: ['test'] },
    { id: 'B', depends_on: ['A'], scope: ['b.txt'], conflicts_with: [], agent: { model: 'mock', effort: 'low' }, continuation: { mode: 'new' }, completion: ['test'] }
  ] };
}
export function markdown(plan: unknown) { return `人が書いた説明\r\n<!-- chat-control:plan:start -->\n${JSON.stringify(plan)}\n<!-- chat-control:plan:end -->\r\n手順を保持\r\n<!-- chat-control:progress:start -->\r\nold\r\n<!-- chat-control:progress:end -->\r\n末尾\r\n`; }
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'cc05-plan-')), file = path.join(root, 'plan.md');
  const doc = planDocument(root, path.join(root, 'trees'));
  const save = () => writeFileSync(file, markdown(doc)); save(); return { root, file, doc, save };
}
test('accepts_versioned_model_names_without_relaxing_task_ids', () => {
  const f = fixture(); f.doc.tasks[0].agent.model = 'gpt-6.1-sol'; f.save();
  assert.equal(readPlan(f.file).plan.tasks[0].agent.model, 'gpt-6.1-sol');
  for (const model of ['', 'a'.repeat(129), '../model', 'model name', 'model\n']) {
    f.doc.tasks[0].agent.model = model; f.save(); assert.throws(() => readPlan(f.file));
  }
  f.doc.tasks[0].agent.model = 'gpt-6.1-sol'; f.doc.tasks[0].id = 'task.1'; f.save();
  assert.throws(() => readPlan(f.file));
});
test('rejects_duplicate_ids_missing_dependencies_and_cycles', () => {
  const f = fixture(); assert.equal(readPlan(f.file).plan.tasks.length, 2); f.doc.tasks[1].id = 'A'; f.save(); assert.throws(() => readPlan(f.file));
  f.doc.tasks[1].id = 'B'; f.doc.tasks[1].depends_on = ['missing']; f.save(); assert.throws(() => readPlan(f.file));
  f.doc.tasks[1].depends_on = ['A']; f.doc.tasks[0].depends_on = ['B']; f.save(); assert.throws(() => readPlan(f.file));
});
test('rejects_conflicting_parallel_resources', () => {
  const f = fixture(); f.doc.tasks[1].depends_on = []; f.doc.tasks[1].conflicts_with = ['lockfile']; f.save();
  assert.deepEqual(eligibleTasks(readPlan(f.file), { A: { state: 'running' } }), []);
  f.doc.run.max_parallel = 2; f.doc.tasks[1].conflicts_with = []; f.doc.tasks[1].scope = ['a.txt/sub']; f.save();
  assert.deepEqual(eligibleTasks(readPlan(f.file), { A: { state: 'running' } }), []);
});
test('candidate_acceptance_does_not_release_dependencies', () => {
  const f = fixture(), snapshot = readPlan(f.file);
  assert.deepEqual(eligibleTasks(snapshot, { A: { state: 'candidate_accepted' } }), []);
  assert.deepEqual(eligibleTasks(snapshot, { A: { state: 'integrated', integrationSha: 'a'.repeat(40) } }), ['B']);
});
test('projection_preserves_user_prose', async () => {
  const f = fixture(), original = readFileSync(f.file, 'utf8'), before = readPlan(f.file);
  await writeProgress(f.file, before.fileHash, 'A: candidate_ready');
  assert.equal(readFileSync(f.file, 'utf8'), original.replace('\r\nold\r\n', '\r\nA: candidate_ready\r\n'));
  assert.equal(readPlan(f.file).planHash, before.planHash); assert.notEqual(readPlan(f.file).fileHash, before.fileHash);
  await assert.rejects(writeProgress(f.file, before.fileHash, 'stale')); assert.match(readFileSync(f.file, 'utf8'), /candidate_ready/);
});
test('rejects_unsafe_yaml_paths_tags_aliases_and_markers', () => {
  const f = fixture(); assert.equal(readPlan(f.file).plan.schema_version, 1);
  for (const value of ['../escape', '/absolute', 'C:\\escape', 'a/../b', '.git/config']) {
    f.doc.tasks[0].scope = [value]; f.save(); assert.throws(() => readPlan(f.file));
  }
  for (const yaml of ['!!js/function hi', 'a: &a [*a]', 'schema_version: 1\nschema_version: 1', 'a: !custom x', '---\na: 1\n---\nb: 2']) {
    writeFileSync(f.file, `<!-- chat-control:plan:start -->\n${yaml}\n<!-- chat-control:plan:end -->`); assert.throws(() => readPlan(f.file));
  }
  f.doc.tasks[0].scope = ['a.txt']; f.save(); writeFileSync(f.file, readFileSync(f.file, 'utf8') + '<!-- chat-control:plan:start -->'); assert.throws(() => readPlan(f.file));
});

test('explicit_pending_decision_is_eligible_but_live_worker_occupies_serial_slot', () => {
  const f = fixture(), snapshot = readPlan(f.file);
  assert.deepEqual(eligibleTasks(snapshot, { A: { state: 'pending' } }), ['A']);
  f.doc.tasks[1].depends_on = []; f.save(); assert.deepEqual(eligibleTasks(readPlan(f.file), { A: { state: 'idle' } }), []);
});
