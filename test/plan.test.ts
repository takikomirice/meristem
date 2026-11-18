import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { draftPlanChange, PlanChange, readPlan, eligibleTasks, writeProgress } from '../src/plan.js';

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
test('model_policy_rejects_duplicate_or_unapproved_settings_in_plans_and_revisions', () => {
  const f = fixture();
  const baseline = { model: 'mock', effort: 'low' }, upgrade = { model: 'mock', effort: 'high' };
  const policy = (candidates: unknown[], mode: string = 'rules') => {
    Object.assign(f.doc.run, { worker_model_policy: { mode, candidates } });
    f.save();
  };
  policy([baseline, upgrade]);
  assert.throws(() => readPlan(f.file));
  f.doc.schema_version = 2;
  for (const task of f.doc.tasks) Object.assign(task.agent, { permissionProfileId: 'workspace' });
  Object.assign(f.doc.tasks[0], { model_routing: { kind: 'implementation', complexity: 'bounded' } });
  for (const choices of [[baseline], [baseline, baseline], [upgrade, { model: 'other', effort: 'high' }], [baseline, { ...upgrade, extra: true }]]) {
    policy(choices);
    assert.throws(() => readPlan(f.file));
  }
  policy([baseline, upgrade], 'learned');
  assert.doesNotThrow(() => readPlan(f.file));
  policy([baseline, upgrade], 'unknown');
  assert.throws(() => readPlan(f.file));
  policy([baseline, upgrade]);
  const current = readPlan(f.file);
  const input = { expectedPlanHash: current.planHash, reason: 'Try a different configuration.', alternatives: ['Keep current.'], recommendation: 'Change effort.' };
  const change = (id: string, model: string, effort: string) => draftPlanChange(current, PlanChange.parse({
    ...input, tasks: [{ id, agent: { model, effort, permissionProfileId: 'workspace' } }]
  }));
  assert.throws(() => change('A', 'unapproved', 'low'));
  assert.deepEqual(change('A', 'mock', 'high').affected, ['A', 'B']);
  assert.deepEqual(change('B', 'unapproved', 'low').affected, ['B']);
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
test('parked_tasks_release_only_execution_slots_and_keep_resource_reservations', () => {
  const f = fixture(); f.doc.tasks[1].depends_on = []; f.save();
  const held = { state: 'held', hold: { releasedExecutionSlot: false } };
  assert.deepEqual(eligibleTasks(readPlan(f.file), { A: held }), []);
  held.hold.releasedExecutionSlot = true;
  assert.deepEqual(eligibleTasks(readPlan(f.file), { A: held }), ['B']);
  f.doc.tasks[1].scope = ['A.txt/nested']; f.save();
  assert.deepEqual(eligibleTasks(readPlan(f.file), { A: held }), []);
  f.doc.tasks[1].scope = ['b.txt']; f.doc.tasks[1].conflicts_with = ['lockfile']; f.save();
  assert.deepEqual(eligibleTasks(readPlan(f.file), { A: held }), []);
  f.doc.tasks[1].conflicts_with = []; f.save();
  assert.deepEqual(eligibleTasks(readPlan(f.file), { B: { state: 'pending', blockedByDecision: true } }), ['A']);
});
test('projection_preserves_user_prose', async () => {
  const f = fixture(), original = readFileSync(f.file, 'utf8'), before = readPlan(f.file);
  await writeProgress(f.file, before.fileHash, 'A: candidate_ready');
  assert.equal(readFileSync(f.file, 'utf8'), original.replace('\r\nold\r\n', '\r\nA: candidate_ready\r\n'));
  assert.equal(readPlan(f.file).planHash, before.planHash); assert.notEqual(readPlan(f.file).fileHash, before.fileHash);
  await assert.rejects(writeProgress(f.file, before.fileHash, 'stale')); assert.match(readFileSync(f.file, 'utf8'), /candidate_ready/);
});
test('plan_draft_uses_validated_fields_and_lists_the_transitive_impact', () => {
  const f = fixture();
  f.doc.tasks.push({ ...f.doc.tasks[1], id: 'C', depends_on: ['B'], scope: ['c.txt'], conflicts_with: [] });
  f.save();
  const current = readPlan(f.file);
  const input = { expectedPlanHash: current.planHash, reason: 'Missing a condition.', alternatives: ['Continue as written.'], recommendation: 'Use the new check.' };
  const change = draftPlanChange(current, PlanChange.parse({ ...input, tasks: [{ id: 'A', completion: ['new\u200bcheck'] }] }));
  assert.deepEqual(change.affected, ['A', 'B', 'C']);
  assert.deepEqual(change.differences, ['A / completion: ["test"] → ["new\\u200bcheck"]']);
  assert.equal(change.draft.documentHash, current.documentHash);
  assert.equal(readPlan(f.file).fileHash, current.fileHash);
  for (const tasks of [[{ id: 'A' }], [{ id: 'missing', completion: ['new'] }], [{ id: 'A', depends_on: ['C'] }], [{ id: 'A', completion: ['<!-- chat-control:plan:end -->'] }]]) {
    assert.throws(() => draftPlanChange(current, PlanChange.parse({ ...input, tasks })));
  }
  assert.throws(() => PlanChange.parse({ ...input, tasks: [{ id: 'A', scope: ['outside'] }] }));
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

test('optional_limits_and_display_names_are_validated', () => {
  const f = fixture();
  const doc = {
    ...f.doc, schema_version: 2,
    run: { ...f.doc.run, execution_limits: {} as Record<string, unknown> },
    tasks: f.doc.tasks.map(task => ({ ...task, display_name: '  API実装/担当  ', agent: { ...task.agent, permissionProfileId: 'workspace' } }))
  };
  const read = () => { writeFileSync(f.file, markdown(doc)); return readPlan(f.file).plan; };
  const parsed = read();
  assert.equal(parsed.schema_version, 2);
  assert.equal(parsed.tasks[0].display_name, 'API実装/担当');
  assert.deepEqual(parsed.run.execution_limits, { maxWakeTurns: null, maxCorrectionsPerTask: null });
  for (const value of [null, 1, 13]) {
    doc.run.execution_limits = { maxWakeTurns: value, maxCorrectionsPerTask: value };
    assert.doesNotThrow(read);
  }
  for (const key of ['maxWakeTurns', 'maxCorrectionsPerTask']) {
    for (const value of [0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) {
      doc.run.execution_limits = { [key]: value };
      assert.throws(read);
    }
  }
  doc.run.execution_limits = {};
  for (const name of [' ', '\n担当', '担当\t', '担当\u007f', '担当\u0085', 'a'.repeat(129)]) {
    doc.tasks[0].display_name = name;
    assert.throws(read);
  }
  doc.tasks[0].display_name = 'a'.repeat(128);
  assert.doesNotThrow(read);
  doc.tasks[0].agent.permissionProfileId = '../unsafe';
  assert.throws(read);
  doc.tasks[0].agent.permissionProfileId = 'workspace';
  writeFileSync(f.file, markdown({ ...doc, run: f.doc.run }));
  const omitted = readPlan(f.file).plan;
  assert.equal(omitted.schema_version, 2);
  assert.deepEqual(omitted.run.execution_limits, { maxWakeTurns: null, maxCorrectionsPerTask: null });
  writeFileSync(f.file, markdown({ ...doc, tasks: f.doc.tasks }));
  assert.throws(() => readPlan(f.file));
});

test('version_one_does_not_gain_version_two_defaults_or_settings', () => {
  const f = fixture(), before = readPlan(f.file).plan;
  assert.equal('execution_limits' in before.run, false);
  assert.equal('permissionProfileId' in before.tasks[0].agent, false);
  writeFileSync(f.file, markdown({ ...f.doc, run: { ...f.doc.run, execution_limits: {} } }));
  assert.throws(() => readPlan(f.file));
});

test('v2_parallelism_is_a_request_with_bounded_capacity_and_v1_stays_compatible', () => {
  const f = fixture();
  f.doc.run.max_parallel = 3; f.save(); assert.throws(() => readPlan(f.file));
  f.doc.schema_version = 2;
  f.doc.tasks.forEach(task => Object.assign(task.agent, { permissionProfileId: 'default' }));
  f.doc.tasks[1].depends_on = []; f.doc.tasks[0].conflicts_with = [];
  for (const maximum of [0, -1, 1.5, 129, NaN]) {
    f.doc.run.max_parallel = maximum; f.save(); assert.throws(() => readPlan(f.file));
  }
  f.doc.run.max_parallel = 128; f.save();
  const snapshot = readPlan(f.file);
  assert.equal(snapshot.plan.run.max_parallel, 128);
  assert.deepEqual(eligibleTasks(snapshot, { A: { state: 'starting' }, B: { state: 'stopping' } }), []);
  assert.deepEqual(eligibleTasks(snapshot, { A: { state: 'starting' } }, 1), []);
  assert.deepEqual(eligibleTasks(snapshot, { A: { state: 'starting' } }, 4), ['B']);
  f.doc.tasks = Array.from({ length: 129 }, (_, i) => ({ ...f.doc.tasks[0], id: `T${i}` })); f.save(); assert.throws(() => readPlan(f.file));
});
