import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveTaskPermissions, type RunPermissionPermit } from '../src/permissions.js';
import type { TaskAgent } from '../src/contracts.js';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'mc07a-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, '作業 space');
  mkdirSync(workspace);
  const agent: TaskAgent = { model: 'gpt-test', effort: 'high', permissionProfileId: 'workspace' };
  const permit: RunPermissionPermit = { allowedProfileIds: ['workspace'], writableRoots: [workspace], allowedReviewers: ['user', 'auto_review'] };
  return { root, workspace, agent, permit };
}

test('workspace_resolves_to_managed_profile_with_explicit_auto_review_permit', t => {
  const f = fixture(t);
  assert.deepEqual(resolveTaskPermissions(f.agent, f.permit), {
    permissionProfileId: 'meristem-managed', approvalsReviewer: 'auto_review', writableRoots: [realpathSync(f.workspace)]
  });
  f.permit.allowedReviewers.reverse();
  assert.equal(resolveTaskPermissions(f.agent, f.permit).approvalsReviewer, 'auto_review');
});

test('user_reviewer_requires_explicit_permission_and_is_not_an_implicit_fallback', t => {
  const f = fixture(t);
  f.permit.allowedReviewers = ['user'];
  assert.equal(resolveTaskPermissions(f.agent, f.permit).approvalsReviewer, 'user');
  f.permit.allowedReviewers = [];
  assert.throws(() => resolveTaskPermissions(f.agent, f.permit));
  f.permit.allowedReviewers = ['guardian_subagent'];
  assert.throws(() => resolveTaskPermissions(f.agent, f.permit), /reviewer/);
});

test('unknown_or_unpermitted_profiles_never_expand_the_run_permit', t => {
  const f = fixture(t);
  f.permit.allowedProfileIds = ['other'];
  assert.throws(() => resolveTaskPermissions(f.agent, f.permit), /profile/);
  for (const profile of ['full-access', 'danger-full-access', 'meristem-read-only', 'meristem-managed', 'unknown']) {
    assert.throws(() => resolveTaskPermissions({ ...f.agent, permissionProfileId: profile }, {
      ...f.permit, allowedProfileIds: [profile]
    }), /profile/);
  }
  assert.throws(() => resolveTaskPermissions({ ...f.agent, permissionProfileId: ':read-only' }, f.permit));
});

test('read-only explicitly permits inspection in the assigned tree with zero write grants', t => {
  const f = fixture(t), review = { ...f.agent, permissionProfileId: 'read-only' };
  assert.throws(() => resolveTaskPermissions(review, f.permit, f.workspace), /outside run permit/);
  const both = { ...f.permit, allowedProfileIds: ['workspace', 'read-only'] };
  const assigned = path.join(f.workspace, 'assigned');
  mkdirSync(assigned);
  assert.deepEqual(resolveTaskPermissions(review, both, assigned), {
    permissionProfileId: 'meristem-read-only', approvalsReviewer: 'auto_review', writableRoots: []
  });
  assert.deepEqual(resolveTaskPermissions(f.agent, both, assigned).writableRoots, [realpathSync(assigned)]);
  assert.throws(() => resolveTaskPermissions(review, both, f.root), /outside run permission permit/);
  assert.throws(() => resolveTaskPermissions(f.agent, { ...both, allowedProfileIds: ['read-only'] }, assigned), /outside run permit/);
});

test('permission_inputs_reject_config_injection_and_task_roots_outside_the_permit', t => {
  const f = fixture(t);
  for (const extra of [
    { config: { sandbox_mode: 'danger-full-access' } }, { permissions: ':full-access' },
    { writableRoots: [f.root] }, { approvalsReviewer: 'user' }, { approvalPolicy: 'never' }
  ]) {
    assert.throws(() => resolveTaskPermissions({ ...f.agent, ...extra }, f.permit));
    if (!('writableRoots' in extra)) {
      const injectedPermit = { ...f.permit, ...extra };
      assert.throws(() => resolveTaskPermissions(f.agent, injectedPermit));
    }
  }
  for (const key of ['model', 'effort', 'permissionProfileId'] as const) {
    assert.throws(() => resolveTaskPermissions({ ...f.agent, [key]: 'bad\nvalue' }, f.permit));
  }
});

test('reviewer_values_are_closed_to_the_MC02_schema', t => {
  const f = fixture(t);
  for (const reviewer of ['auto-review', 'full-access', 'auto_review\n', 'AUTO_REVIEW']) {
    assert.throws(() => resolveTaskPermissions(f.agent, {
      ...f.permit, allowedReviewers: [reviewer] as RunPermissionPermit['allowedReviewers']
    }));
  }
});

test('writable_roots_must_be_existing_absolute_scoped_directories', t => {
  const f = fixture(t), file = path.join(f.root, 'file.txt');
  writeFileSync(file, 'unchanged');
  for (const roots of [[], ['relative'], [''], [path.parse(f.root).root], [file],
    [path.join(f.root, 'missing')], [f.workspace + '\n'], ['a'.repeat(4097)],
    ...(process.platform === 'win32' ? [['C:relative'], ['\\relative'], ['\\\\?\\' + f.workspace]] : [])]) {
    assert.throws(() => resolveTaskPermissions(f.agent, { ...f.permit, writableRoots: roots }));
  }
});

test('writable_roots_are_canonical_without_widening_to_a_parent_or_sibling', t => {
  const f = fixture(t), sibling = path.join(f.root, '作業 space-other');
  mkdirSync(sibling);
  assert.deepEqual(resolveTaskPermissions(f.agent, {
    ...f.permit, writableRoots: [f.workspace + path.sep + '.', sibling + path.sep]
  }).writableRoots, [realpathSync(f.workspace), realpathSync(sibling)]);
  assert.throws(() => resolveTaskPermissions(f.agent, {
    ...f.permit, writableRoots: [f.workspace, f.workspace + path.sep + '.']
  }));
});

test('root_aliases_and_alias_ancestors_cannot_redirect_writable_scope', t => {
  const f = fixture(t), alias = path.join(f.root, 'alias'), child = path.join(f.workspace, 'child');
  mkdirSync(child);
  symlinkSync(f.workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const root of [alias, path.join(alias, 'child')]) {
    assert.throws(() => resolveTaskPermissions(f.agent, { ...f.permit, writableRoots: [root] }), /alias|reparse/);
  }
});

test('permission_lists_are_bounded_and_duplicate_entries_are_rejected', t => {
  const f = fixture(t);
  for (const field of ['allowedProfileIds', 'allowedReviewers', 'writableRoots'] as const) {
    assert.throws(() => resolveTaskPermissions(f.agent, { ...f.permit, [field]: [] }));
    assert.throws(() => resolveTaskPermissions(f.agent, { ...f.permit, [field]: Array(17).fill(f.permit[field][0]) }));
    assert.throws(() => resolveTaskPermissions(f.agent, { ...f.permit, [field]: [f.permit[field][0], f.permit[field][0]] }));
  }
});

test('each_resolution_uses_only_the_current_permit_and_returns_detached_roots', t => {
  const f = fixture(t), first = resolveTaskPermissions(f.agent, f.permit);
  first.writableRoots.push(f.root);
  assert.deepEqual(f.permit.writableRoots, [f.workspace]);
  const second = resolveTaskPermissions(f.agent, { ...f.permit, allowedReviewers: ['user'] });
  assert.deepEqual(second, { permissionProfileId: 'meristem-managed', approvalsReviewer: 'user', writableRoots: [realpathSync(f.workspace)] });
  f.permit.writableRoots.push(f.root);
  assert.deepEqual(second.writableRoots, [realpathSync(f.workspace)]);
  assert.throws(() => resolveTaskPermissions(f.agent, { ...f.permit, allowedProfileIds: [] }));
});
