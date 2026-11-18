import test from 'node:test';
import { coordinationGuards } from './live/acceptance.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { serialAcceptancePlan, serialFixture } from './fixtures/serial-git.js';
import { eligibleTasks, readPlan } from '../src/plan.js';

test('broker store restart does not resurrect a stopped worker', async () => { await coordinationGuards(); });

test('serial_acceptance_checks_detect_failed_correction_and_gate_handoff', () => {
  const f = serialAcceptancePlan(serialFixture(), { model: 'mock', effort: 'low' });
  const plan = readPlan(f.planPath);
  assert.deepEqual(eligibleTasks(plan, {}), ['A']);
  const check = (...names: string[]) => spawnSync(process.execPath, ['checks.mjs', ...names], { cwd: f.repository, windowsHide: true }).status;
  writeFileSync(path.join(f.repository, 'a.txt'), 'draft');
  assert.equal(check('A'), 1);
  writeFileSync(path.join(f.repository, 'a.txt'), 'alpha');
  assert.equal(check('A'), 0);
  assert.deepEqual(eligibleTasks(plan, { A: { state: 'integrated', integrationSha: 'a'.repeat(40) } }), ['B']);
  writeFileSync(path.join(f.repository, 'b.txt'), 'beta');
  assert.equal(check('A', 'B'), 0);
  writeFileSync(path.join(f.repository, 'a.txt'), 'broken');
  assert.equal(check('A', 'B'), 1);
});
